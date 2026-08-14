import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCaptured, sweepStaleCaptureDirs } from '../src/subprocess-capture';

const REPO_ROOT = path.join(import.meta.dir, '..', '..');

/** Names of capture dirs currently in the shared temp dir. */
function countCaptureDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('gstack-capture-'));
}

describe('runCaptured', () => {
  it('captures both streams and the exit code', async () => {
    const r = await runCaptured(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('feeds stdin to the child', async () => {
    const r = await runCaptured(['cat'], { stdin: 'hello-stdin' });
    expect(r.stdout).toBe('hello-stdin');
    expect(r.exitCode).toBe(0);
  });

  it('reports a timeout as exit 124 rather than hanging', async () => {
    const r = await runCaptured(['sh', '-c', 'sleep 30'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
  });

  it('truncates at maxBytes and says so, per stream', async () => {
    const r = await runCaptured(['sh', '-c', 'printf "%s" 0123456789'], { maxBytes: 4 });
    expect(r.stdout).toBe('0123');
    expect(r.truncated).toBe(true);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
  });

  it('reports which stream was truncated, not just that one was', async () => {
    // Load-bearing for the caller: a truncated stdout means the result is
    // unusable, a truncated stderr is just noisy logging. Collapsing both into
    // one flag made a chatty-but-successful run look like a failure.
    const r = await runCaptured(
      ['sh', '-c', 'printf "ok"; printf "%s" 0123456789 >&2'], { maxBytes: 4 },
    );
    expect(r.stdout).toBe('ok');
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderrTruncated).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it('never splits a multi-byte character at the cap', async () => {
    // A byte cap can land mid-character. Decoding that tail yields U+FFFD,
    // which is exactly the malformed output the server-egress sanitizer exists
    // to keep away from the API — so drop the partial character instead.
    for (const cap of [1, 2, 3, 4, 5]) {
      const r = await runCaptured(['sh', '-c', 'printf %s ééé'], { maxBytes: cap });
      expect(r.stdout).not.toContain('�');
      expect(r.stdout).toBe('é'.repeat(Math.floor(cap / 2)));
    }
    const emoji = await runCaptured(['sh', '-c', 'printf %s 🎉🎉'], { maxBytes: 5 });
    expect(emoji.stdout).toBe('🎉');
  });

  it('honours cwd and env', async () => {
    const dir = fs.realpathSync(os.tmpdir());
    const r = await runCaptured(['sh', '-c', 'pwd; echo $FOO'], { cwd: dir, env: { FOO: 'bar' } });
    expect(r.stdout.trim().split('\n')).toEqual([dir, 'bar']);
  });

  it('bounds the wait even when the child ignores SIGTERM', async () => {
    // SIGTERM is a request. Without escalation this returned only when the
    // child finished on its own — measured at 25s against a 600ms timeout —
    // while still reporting a clean, on-time timeout to the caller.
    const started = Date.now();
    const r = await runCaptured(
      ['sh', '-c', "trap '' TERM; sleep 25"], { timeoutMs: 400 },
    );
    const elapsed = Date.now() - started;
    expect(r.timedOut).toBe(true);
    expect(r.killed).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  it('does not escalate to SIGKILL when the child exits on SIGTERM', async () => {
    const r = await runCaptured(['sh', '-c', 'sleep 30'], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.killed).toBe(false);
  });

  it('throws rather than resolving when the command does not exist', async () => {
    // Pins the contract every caller depends on: they all destructure the
    // result, so a missing binary must surface as a throw, not a result with a
    // nonzero exit code. `secret-tool` is routinely absent on Linux, and
    // runPasswordLookup relies on catching this to degrade to null.
    const before = countCaptureDirs();
    await expect(runCaptured(['gstack-no-such-binary-xyz'])).rejects.toThrow();
    expect(countCaptureDirs()).toEqual(before);
  });

  it('leaves no temp directory behind', async () => {
    // Compare the exact directory names rather than a count: this repo runs
    // several worktrees on one box, so a concurrent gstack process creating or
    // removing a capture dir would otherwise make the assertion lie either way.
    const before = countCaptureDirs();
    await runCaptured(['sh', '-c', 'echo hi']);
    await runCaptured(['sh', '-c', 'sleep 30'], { timeoutMs: 200 });
    await runCaptured(['sh', '-c', 'printf x'], { stdin: 'secret', maxBytes: 1 });
    const leaked = countCaptureDirs().filter(d => !before.includes(d));
    expect(leaked).toEqual([]);
  });

  it('keeps captured credentials owner-only on disk', async () => {
    // The capture files hold plaintext keychain passwords on the cookie-import
    // paths. Left to Bun they land at umask-derived 0664.
    if (process.platform !== 'linux') return; // needs /proc to name the target
    // Resolve the fd to the real path first: stat on /proc/self/fd/1 itself
    // reports the symlink's access mode, not the capture file's permissions.
    const r = await runCaptured(
      ['sh', '-c', 'stat -c %a "$(readlink /proc/self/fd/2)" >&2'],
    );
    expect(r.stderr.trim()).toBe('600');
  });

  it('captures a stream the child writes but never flushes explicitly', async () => {
    // The regression this module exists for: output written by a child that
    // exits immediately afterwards must still arrive in full.
    const r = await runCaptured(['sh', '-c', 'printf "a%.0s" $(seq 1 5000) >&2; exit 0']);
    expect(r.stderr.length).toBe(5000);
  });
});

describe('sweepStaleCaptureDirs', () => {
  it('reclaims an orphaned capture dir and leaves fresh ones alone', () => {
    // Simulates the SIGKILL case: a parent died before its finally could run,
    // leaving a directory that may hold a plaintext keychain password.
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-capture-'));
    fs.writeFileSync(path.join(stale, 'stdout'), 'keychain-password');
    const old = Date.now() - 60 * 60_000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-capture-'));
    try {
      const removed = sweepStaleCaptureDirs(30 * 60_000);
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(stale)).toBe(false);
      // A concurrent capture in a sibling worktree must survive the sweep.
      expect(fs.existsSync(fresh)).toBe(true);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
      fs.rmSync(stale, { recursive: true, force: true });
    }
  });

  it('is a no-op, and never throws, when nothing is old enough', () => {
    // Deliberately NOT sweepStaleCaptureDirs(0): a zero max-age matches every
    // capture dir on the box, including a live one belonging to a concurrent
    // worktree's test run, and would delete it out from under them.
    const before = countCaptureDirs();
    expect(() => sweepStaleCaptureDirs(365 * 24 * 60 * 60_000)).not.toThrow();
    expect(countCaptureDirs()).toEqual(before);
  });
});

describe('no subprocess output is captured through a pipe', () => {
  // Tripwire, repo-wide over shipped source.
  //
  // Capturing a child's output through a pipe on an async `Bun.spawn` is lossy:
  // under a loaded parent the FIRST piped spawn in the process intermittently
  // yields an empty stream even though the child wrote it and exited 0. The
  // bytes are lost inside Bun's async pipe plumbing, so reading before awaiting
  // exit and draining via getReader() were both measured losing the same bytes.
  //
  // Consequences seen: `$B skill test` reporting only bun's banner, a keychain
  // password read back as "" and then derived into a wrong AES key, and
  // `design extract-language` skipping its DESIGN.md write. Every one of those
  // looked like success.
  //
  // Use runCaptured() (temp files, async) or Bun.spawnSync (blocking) instead.
  // Comments are stripped first so prose naming the banned pattern in order to
  // explain it doesn't trip a check meant for code.
  const SRC_GLOBS = ['browse/src/**/*.ts', 'design/src/**/*.ts'];

  const sources = SRC_GLOBS.flatMap(g =>
    Array.from(new Glob(g).scanSync(REPO_ROOT)).map(rel => ({
      rel,
      src: fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    })),
  );

  it('finds sources to scan', () => {
    // Guard against a glob that silently matches nothing, which would make
    // every assertion below vacuously pass.
    expect(sources.length).toBeGreaterThan(20);
  });

  it('never reads a child stream via new Response() or getReader()', () => {
    // This is the load-bearing rule. It catches the case an options-based check
    // cannot: `Bun.spawn(cmd)` with no stdio options at all still defaults
    // stdout to a pipe, so the read is where the bug is actually visible.
    const offenders = sources.filter(({ src }) => readsChildStream(src));
    expect(offenders.map(o => o.rel)).toEqual([]);
  });

  it("never spawns async with stdout/stderr: 'pipe'", () => {
    const offenders = sources.filter(({ src }) =>
      asyncSpawnCalls(src).some(call => /std(out|err):\s*['"]pipe['"]/.test(call)),
    );
    expect(offenders.map(o => o.rel)).toEqual([]);
  });

  // Positive controls. A static tripwire whose detector quietly stops matching
  // is worse than no tripwire, because the green tick reads as coverage. These
  // pin that each rule still fires on the shape it was written to catch, and
  // still ignores the shapes that legitimately resemble it.
  describe('the detectors themselves', () => {
    it('flags a piped async spawn', () => {
      const bad = `const p = Bun.spawn(cmd, {\n  stdout: 'pipe',\n  stderr: 'pipe',\n});`;
      expect(asyncSpawnCalls(bad).some(c => /std(out|err):\s*['"]pipe['"]/.test(c))).toBe(true);
    });

    it('ignores a piped spawnSync, which captures reliably', () => {
      const ok = `const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });`;
      expect(asyncSpawnCalls(ok)).toHaveLength(0);
    });

    it('flags both child-stream read shapes', () => {
      expect(readsChildStream('const t = await new Response(proc.stdout).text();')).toBe(true);
      expect(readsChildStream('const t = await new Response(proc2.stderr).text();')).toBe(true);
      expect(readsChildStream('const r = proc.stdout.getReader();')).toBe(true);
      expect(readsChildStream('const r = (proc.stdout as ReadableStream<Uint8Array>).getReader();')).toBe(true);
    });

    it('flags the idiomatic Bun read APIs, not just the one shape the bug was found in', () => {
      // These are the spellings a new author reaches for first. An earlier
      // version of this rule missed all of them, which would have let the bug
      // back in with the suite passing.
      expect(readsChildStream('const t = await Bun.readableStreamToText(proc.stdout);')).toBe(true);
      expect(readsChildStream('const b = await readableStreamToArrayBuffer(proc.stderr);')).toBe(true);
      expect(readsChildStream('const t = await proc.stdout.text();')).toBe(true);
      expect(readsChildStream('const j = await proc.stderr.json();')).toBe(true);
      expect(readsChildStream('const b = await proc.stdout.bytes();')).toBe(true);
      expect(readsChildStream('for await (const chunk of proc.stdout) { out += chunk; }')).toBe(true);
    });

    it("ignores the parent's own process.stdout", () => {
      // The shape that first tripped this rule: an interactive prompt writing to
      // its own stdout and then reading its own stdin, no child involved.
      expect(readsChildStream(
        'process.stdout.write("API key: ");\n const reader = Bun.stdin.stream().getReader();',
      )).toBe(false);
    });
  });
});

/**
 * True if the source reads a spawned child's stdout/stderr stream — the read
 * side of the lossy-pipe bug.
 *
 * Covers every spelling Bun offers for draining a child stream, not just the
 * one this repo happened to use. `new Response(proc.stdout).text()` is where
 * the bug was found, but `Bun.readableStreamToText(proc.stdout)` and
 * `await proc.stdout.text()` are the more idiomatic forms — a rule that missed
 * those would let the next author reintroduce the bug under a green tick.
 *
 * Matched structurally (the read must apply to the stream expression itself,
 * allowing a TS cast) rather than by handle name, so `process.stdout.write(...)`
 * sitting near an unrelated `.getReader()` doesn't register as a child read.
 */
function readsChildStream(src: string): boolean {
  const STREAM = String.raw`\.(?:stdout|stderr)\s*(?:as\s+[\w<>\[\], |]+)?\s*\)?\s*`;
  return (
    // Helper taking the stream as an argument: new Response(proc.stdout),
    // Bun.readableStreamToText(proc.stderr), readableStreamToArrayBuffer(...).
    /(?:new Response|readableStreamTo\w+)\(\s*\w+\.(?:stdout|stderr)/.test(src) ||
    // Method on the stream: proc.stdout.getReader() / .text() / .json() / ...
    new RegExp(STREAM + String.raw`\.(?:getReader|text|json|bytes|arrayBuffer|blob)\(`).test(src) ||
    // for await (const chunk of proc.stdout) { ... }
    /for\s+await\s*\([^)]*\bof\s+\w+\.(?:stdout|stderr)\b/.test(src)
  );
}

/**
 * Extract the full text of each async `Bun.spawn(...)` call, brace-matched so a
 * multi-line options object is checked in one piece. `Bun.spawnSync` is excluded
 * deliberately: it captures reliably and is the right choice for a quick probe.
 */
function asyncSpawnCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /(?<!Sync)\bBun\.spawn\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      i++;
    }
    calls.push(src.slice(m.index, i));
  }
  return calls;
}
