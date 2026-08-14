/**
 * subprocess-capture — run a child process and capture its output reliably.
 *
 * The one rule this module exists to enforce: never capture a child's output
 * through `stdout: 'pipe'` on an async `Bun.spawn`.
 *
 * Under a loaded parent, the FIRST piped spawn in a process intermittently
 * yields an empty stderr even though the child wrote it and exited 0. Measured
 * by instrumenting a full `bun test browse/test/` run — the loss reproduced in
 * 4 of 4 runs and always landed on the first piped spawn:
 *
 *     pipe#0 exit=0 outLen=28 errLen=0    <- lost
 *     pipe#1 exit=0 outLen=28 errLen=76   <- fine
 *     pipe#2 exit=0 outLen=28 errLen=76   <- fine
 *
 * The bytes are lost inside Bun's async pipe plumbing, not by reading in the
 * wrong order, so the obvious workarounds do NOT help. Both of these were
 * measured losing the same bytes in the same position:
 *
 *   - attaching readers before awaiting `proc.exited`, settling with Promise.all
 *   - a manual `stream.getReader()` drain loop
 *
 * Pointing the child's fds at temp files takes user-space streams out of the
 * path entirely: the kernel has flushed every byte by the time the child exits,
 * so the post-exit read is always complete. It also removes the pipe-buffer
 * stall risk on a chatty child that nobody is draining.
 *
 * `Bun.spawnSync` also captures reliably and is the simpler choice when
 * blocking the event loop is acceptable — a fast startup probe like
 * `git rev-parse` or `chrome --version`. Reach for this module when blocking
 * is NOT acceptable: a child that can hang on a user-facing dialog, or one that
 * calls back into this same daemon (a synchronous wait would deadlock it).
 *
 * Handling secrets: `runCaptured` writes the child's output to a file inside a
 * `mkdtemp` directory, which POSIX creates 0700, and removes the whole
 * directory in a `finally`. For a credential-bearing capture (keychain
 * passwords, DPAPI-decrypted keys) that is a real if small widening of
 * exposure — owner-only for a few milliseconds, versus never touching disk.
 * It is the better trade here, because the alternative is not "no disk write",
 * it is a silently-empty credential that derives a wrong key and corrupts
 * every value decrypted with it. There is deliberately no "shred the file
 * before unlinking" option: on a journaling or copy-on-write filesystem
 * overwriting in place does not reliably erase the old blocks, so it would buy
 * reassurance rather than secrecy.
 *
 * Two properties of file-backed capture that pipes did not have, neither
 * exploitable through any current caller but both load-bearing if you add one:
 *
 *   - The child's stdout/stderr fds are seekable and truncatable, so a child can
 *     rewrite or shorten output it already emitted. Captured output is therefore
 *     whatever the child left at exit; it is NOT an append-only record of what
 *     the child said over time. Don't use it as an audit log. (No caller reads
 *     mid-flight, so today a lying child gains nothing it couldn't get by simply
 *     printing the lie.)
 *   - The child can reach its own capture directory via /proc/self/fd/1 and read
 *     the sibling `stdin` file, which runs as the same uid and so is not stopped
 *     by file mode. Only pass a secret via `stdin` to a child that is the
 *     intended recipient of that secret — which is the case for the one caller
 *     that uses it (dpapiDecrypt hands PowerShell the blob PowerShell decrypts).
 *
 * Reaping covers the direct child only. `proc.kill()` does not signal a process
 * group, so a child that backgrounds work leaves descendants running past the
 * timeout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { restrictDirectoryPermissions, writeSecureFile } from './file-permissions';

export interface RunCapturedOptions {
  cwd?: string;
  env?: Record<string, string> | NodeJS.ProcessEnv;
  /** Fed to the child on stdin. Written to a temp file, not piped. */
  stdin?: string;
  /**
   * Signal the child after this many ms, then SIGKILL it if it hasn't exited
   * within `KILL_GRACE_MS`. Omit for no timeout.
   */
  timeoutMs?: number;
  /**
   * Cap each captured stream independently. Bytes past the cap are dropped and
   * the matching `*Truncated` flag is set. This is a BYTE cap, not a character
   * cap; a multi-byte sequence straddling the limit is dropped whole rather
   * than decoded into a replacement character.
   */
  maxBytes?: number;
}

export interface RunCapturedResult {
  stdout: string;
  stderr: string;
  /** 124 when the child was killed by `timeoutMs`, mirroring coreutils `timeout`. */
  exitCode: number;
  timedOut: boolean;
  /** True when the child ignored SIGTERM and had to be SIGKILLed. */
  killed: boolean;
  /** True when either stream hit `maxBytes`. Prefer the per-stream flags. */
  truncated: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * How long a child gets to exit on SIGTERM before SIGKILL. Without this,
 * `timeoutMs` bounds nothing: `proc.kill()` sends SIGTERM, and a child that
 * ignores it is awaited for its full natural lifetime while the result still
 * claims a clean on-time timeout.
 */
const KILL_GRACE_MS = 2_000;

/**
 * Run a command to completion, capturing stdout/stderr by pointing the child's
 * file descriptors at temp files rather than at pipes.
 *
 * Only for children that exit on their own (or via `timeoutMs`). A long-lived
 * child whose output nobody reads should be spawned with `stdio: 'ignore'`
 * instead — that says "discarded" outright and costs no temp files.
 */
const CAPTURE_DIR_PREFIX = 'gstack-capture-';

/**
 * Remove capture directories orphaned by a parent that died before its
 * `finally` could run.
 *
 * Normal cleanup is the `finally` in `runCaptured`, which does not run on
 * SIGKILL, `taskkill /F`, or a host crash. That matters more than it looks: the
 * daemon deliberately ignores SIGTERM in headless mode, so being killed
 * outright is a routine way for it to exit — and an orphan from the cookie
 * import holds a plaintext Keychain or libsecret password. Without a sweep
 * those accumulate in the temp dir indefinitely.
 *
 * Best-effort and never throws. `maxAgeMs` must stay comfortably longer than
 * the slowest capture (`$B skill test` runs an entire `bun test` with no
 * timeout), or this would delete a live sibling process's directory.
 */
export function sweepStaleCaptureDirs(maxAgeMs = 30 * 60_000, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(CAPTURE_DIR_PREFIX));
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = path.join(os.tmpdir(), name);
    try {
      if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // Another process may be mid-cleanup, or the dir may not be ours to
      // remove. Either way this is hygiene, not correctness — skip it.
    }
  }
  return removed;
}

export async function runCaptured(
  cmd: string[],
  opts: RunCapturedOptions = {},
): Promise<RunCapturedResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), CAPTURE_DIR_PREFIX));
  // mkdtemp is 0700 on POSIX but mode is largely inert on Windows, so go
  // through the repo's helper for the ACL equivalent.
  restrictDirectoryPermissions(dir);
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  try {
    let stdinSource: unknown = 'ignore';
    if (opts.stdin !== undefined) {
      const inPath = path.join(dir, 'stdin');
      writeSecureFile(inPath, opts.stdin);
      stdinSource = Bun.file(inPath);
    }

    // Pre-create the capture files owner-only. Left to Bun they land at
    // umask-derived 0644/0664, and these hold plaintext credentials on the
    // keychain paths. The directory already contains the exposure, so this is
    // defence in depth — it keeps the secret owner-only if a later change
    // relaxes the directory mode or moves capture somewhere shared. Spawn
    // truncates and writes without altering the mode.
    writeSecureFile(outPath, '');
    writeSecureFile(errPath, '');

    // Hand Bun the destinations as BunFiles rather than raw fds we opened: Bun
    // then owns the descriptors for the child's whole lifetime. Opening them
    // here and closing them after exit instead put us in Bun's fd bookkeeping,
    // which surfaced as a stray EBADF from epoll_ctl on a later spawn.
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      // Read process.env at call time rather than leaving this undefined.
      // Undefined makes Bun inherit the environ as it was at process start, so
      // a later `process.env.PATH = ...` is ignored even for resolving the
      // executable — surprising, and it makes PATH-stubbing a child untestable.
      env: (opts.env ?? process.env) as any,
      stdin: stdinSource as any,
      stdout: Bun.file(outPath) as any,
      stderr: Bun.file(errPath) as any,
    });

    let timedOut = false;
    let killed = false;
    let hardKiller: ReturnType<typeof setTimeout> | undefined;
    const killer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      // SIGTERM is a request. A child that ignores it (or is wedged in
      // uninterruptible sleep) would otherwise be awaited for its full natural
      // lifetime while we still report a clean on-time timeout, so follow up
      // with a signal it cannot decline.
      hardKiller = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGKILL'); } catch {}
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);

    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } finally {
      if (killer !== undefined) clearTimeout(killer);
      if (hardKiller !== undefined) clearTimeout(hardKiller);
    }

    // The child's own writes are flushed by the kernel when it exits, so
    // everything it wrote is readable here.
    const cap = opts.maxBytes ?? Infinity;
    const stdout = readCappedFile(outPath, cap);
    const stderr = readCappedFile(errPath, cap);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      killed,
      truncated: stdout.truncated || stderr.truncated,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } finally {
    // Swallow cleanup failures. `force: true` does not cover every case (a
    // Windows AV/indexer holding a handle raises EBUSY/EPERM), and letting that
    // escape a `finally` would replace the real error — a Keychain denial, a
    // DPAPI failure — with an unrelated cleanup exception. The repo's
    // convention for best-effort cleanup is to stay quiet; see safeUnlinkQuiet.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

interface CappedRead { text: string; truncated: boolean; }

/** Read at most `capBytes` from a file, reporting whether anything was dropped. */
function readCappedFile(p: string, capBytes: number): CappedRead {
  // A killed child can die before its fd is created; treat that as no output
  // rather than letting ENOENT mask the real timeout/exit-code result.
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return { text: '', truncated: false };
  }
  if (size <= capBytes) return { text: fs.readFileSync(p, 'utf-8'), truncated: false };
  const fd = fs.openSync(p, 'r');
  try {
    // Size the buffer to what we'll actually read. Buffer.alloc zero-fills, so
    // allocating the full cap does real work even when the overflow is tiny.
    const want = Math.min(capBytes, size);
    const buf = Buffer.allocUnsafe(want);
    const read = fs.readSync(fd, buf, 0, want, 0);
    return { text: decodeWholeCodePoints(buf.subarray(0, read)), truncated: true };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Decode UTF-8, dropping a trailing byte sequence cut off mid-character.
 *
 * The cap is a byte count, so it can land inside a multi-byte character. Naive
 * decoding turns that tail into U+FFFD, which is exactly the kind of malformed
 * output the server-egress sanitizer exists to keep away from the API. Dropping
 * the partial character loses at most three bytes we were truncating anyway.
 */
function decodeWholeCodePoints(buf: Buffer): string {
  // Walk back over continuation bytes (10xxxxxx) to the lead byte of the last
  // character, then keep it only if its full width is present.
  let end = buf.length;
  let back = 0;
  while (end > 0 && back < 4 && (buf[end - 1] & 0xc0) === 0x80) { end--; back++; }
  if (end > 0 && back < 4) {
    const lead = buf[end - 1];
    const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    // Complete character: keep it. Otherwise leave it behind.
    if (back + 1 === width) end = buf.length;
    else end -= 1;
  }
  return buf.subarray(0, end).toString('utf-8');
}
