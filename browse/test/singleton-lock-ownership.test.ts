import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserManager } from '../src/browser-manager';

// Ownership gate for Chromium singleton-lock cleanup.
//
// SingletonLock/SingletonSocket/SingletonCookie are Chromium's
// ProcessSingleton — the mechanism that stops a second Chromium attaching to
// a user-data-dir already in use. With the locks intact, a second launch
// aborts with "Failed to create a ProcessSingleton for your profile
// directory ... Aborting now to avoid profile corruption". Delete them out
// from under a live browser and the second instance starts anyway, so two
// Chromiums write one profile (observed: "database is locked", "Unable to
// open the password store database", "Could not create/open login database").
//
// The bug this pins: server.ts's emergencyCleanup() and shutdown() used to
// call `cleanSingletonLocks(resolveChromiumProfile())` unconditionally, with
// no check that this process had ever launched a browser. A daemon started
// with BROWSE_HEADLESS_SKIP=1 — or one whose launch threw — still deleted the
// locks of whatever profile resolved at exit time. Since the profile is
// machine-global (`~/.gstack/chromium-profile`) while gstack's CLI
// single-instance lock is per-project, those locks routinely belong to a
// different, still-running browser.
//
// The fix is one guard at the level that can actually answer the question:
// BrowserManager records the profile it launched into, and both shutdown
// paths go through cleanOwnedSingletonLocks().

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const SRC_DIR = path.resolve(new URL(import.meta.url).pathname, '..', '..', 'src');

function makeProfile(): string {
  // basename must be `chromium-profile` so cleanSingletonLocks' shape guard
  // would ALLOW the delete — the ownership gate is what must stop it.
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'singleton-own-')), 'chromium-profile');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of LOCK_FILES) fs.writeFileSync(path.join(dir, f), 'held-by-a-live-peer');
  return dir;
}

function cleanup(profile: string): void {
  fs.rmSync(path.dirname(profile), { recursive: true, force: true });
}

describe('singleton-lock cleanup is gated on ownership', () => {
  test('a manager that never launched a browser owns nothing', () => {
    expect(new BrowserManager().getOwnedProfileDir()).toBeNull();
  });

  test('cleanOwnedSingletonLocks() leaves a live peer\'s locks alone', () => {
    const profile = makeProfile();
    try {
      // Stand in for a BROWSE_HEADLESS_SKIP=1 daemon, or one whose launch
      // threw: it reaches shutdown having never taken the profile.
      const mgr = new BrowserManager();
      mgr.cleanOwnedSingletonLocks();

      for (const f of LOCK_FILES) {
        expect(fs.existsSync(path.join(profile, f))).toBe(true);
      }
    } finally {
      cleanup(profile);
    }
  });

  test('CHROMIUM_PROFILE pointing at the peer does not re-open the hole', () => {
    const profile = makeProfile();
    const orig = process.env.CHROMIUM_PROFILE;
    // Pre-fix, shutdown re-resolved the profile from env at exit time, so
    // this is exactly the configuration that deleted someone else's locks.
    process.env.CHROMIUM_PROFILE = profile;
    try {
      new BrowserManager().cleanOwnedSingletonLocks();
      for (const f of LOCK_FILES) {
        expect(fs.existsSync(path.join(profile, f))).toBe(true);
      }
    } finally {
      if (orig === undefined) delete process.env.CHROMIUM_PROFILE;
      else process.env.CHROMIUM_PROFILE = orig;
      cleanup(profile);
    }
  });

  test('an owning manager DOES clean its own stale locks', () => {
    const profile = makeProfile();
    try {
      const mgr = new BrowserManager();
      // White-box: stand in for a successful launchPersistentContext, which
      // is the only thing that sets this record.
      (mgr as any).ownedProfileDir = profile;
      expect(mgr.getOwnedProfileDir()).toBe(profile);

      mgr.cleanOwnedSingletonLocks();
      for (const f of LOCK_FILES) {
        expect(fs.existsSync(path.join(profile, f))).toBe(false);
      }
    } finally {
      cleanup(profile);
    }
  });

  test('cleaning the owned profile twice does not throw (ENOENT swallowed)', () => {
    const profile = makeProfile();
    try {
      const mgr = new BrowserManager();
      (mgr as any).ownedProfileDir = profile;
      expect(() => mgr.cleanOwnedSingletonLocks()).not.toThrow();
      expect(() => mgr.cleanOwnedSingletonLocks()).not.toThrow();
    } finally {
      cleanup(profile);
    }
  });
});

describe('close() releases ownership only on a clean close', () => {
  // The subtlest branch in the fix. A clean close means Chromium removed its
  // own locks and we no longer hold the profile, so the record must drop —
  // otherwise a later shutdown deletes locks belonging to whoever claims the
  // profile next. A close that timed out or threw must KEEP the record: those
  // locks are ours and stale, and shutdown is what clears them.
  function headedManagerWith(contextClose: () => Promise<void>): BrowserManager {
    const mgr = new BrowserManager();
    (mgr as any).connectionMode = 'headed';
    (mgr as any).context = { close: contextClose };
    (mgr as any).ownedProfileDir = '/tmp/whatever/chromium-profile';
    return mgr;
  }

  test('clean close drops the ownership record', async () => {
    const mgr = headedManagerWith(async () => {});
    await mgr.close();
    expect(mgr.getOwnedProfileDir()).toBeNull();
  });

  test('failed close keeps the ownership record so shutdown can clear stale locks', async () => {
    const mgr = headedManagerWith(async () => { throw new Error('context close failed'); });
    await mgr.close();
    expect(mgr.getOwnedProfileDir()).toBe('/tmp/whatever/chromium-profile');
  });
});

describe('singleton-lock ownership invariants (static tripwires)', () => {
  // The robust invariant is the IMPORT, not the call shape. A call-site grep
  // alone is defeated by a one-line alias (`const c = cleanSingletonLocks`) or
  // by splitting the call across lines; server.ts not importing the symbol at
  // all closes both holes and survives refactors of the call itself.
  test('server.ts does not import the ungated singleton-lock helpers', () => {
    const content = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf-8');
    const configImports = (content.match(/import\s*\{[^}]*\}\s*from\s*'\.\/config'/gs) ?? []).join('\n');

    for (const symbol of ['cleanSingletonLocks', 'resolveChromiumProfile']) {
      expect(
        configImports.includes(symbol),
        `server.ts must not import ${symbol} from './config'. Shutdown-path
cleanup goes through BrowserManager.cleanOwnedSingletonLocks(), which no-ops
unless this process actually launched the browser. Re-importing ${symbol} is how
the shutdown paths regain the ability to delete the locks of whatever profile
resolves at exit time — including a different, still-running browser's.`,
      ).toBe(false);
    }
  });

  test('server.ts shutdown paths never call cleanSingletonLocks directly', () => {
    const content = fs.readFileSync(path.join(SRC_DIR, 'server.ts'), 'utf-8');
    const offenders: Array<{ line: number; text: string }> = [];
    content.split('\n').forEach((line, i) => {
      if (!/cleanSingletonLocks\s*\(/.test(line)) return;
      const trimmed = line.trim();
      // Documentation mentions are fine.
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      offenders.push({ line: i + 1, text: trimmed });
    });

    expect(
      offenders,
      `server.ts must route singleton-lock cleanup through
BrowserManager.cleanOwnedSingletonLocks(). Offenders:\n` +
        offenders.map((o) => `  server.ts:${o.line}  ${o.text}`).join('\n'),
    ).toEqual([]);
  });

  // Structural, not a count. Counting occurrences file-wide lets a third launch
  // site that FORGETS the claim pass whenever an unrelated line rebalances the
  // total, and hardcoding the local name `userDataDir` false-fails on a plain
  // variable rename. Match a claim inside each launch site's own method instead.
  test('every launchPersistentContext site records ownership in its own method', () => {
    const content = fs.readFileSync(path.join(SRC_DIR, 'browser-manager.ts'), 'utf-8');
    const launchRe = /chromium\.launchPersistentContext\s*\(/g;
    const sites: number[] = [];
    for (let m = launchRe.exec(content); m !== null; m = launchRe.exec(content)) {
      sites.push(m.index);
    }

    expect(sites.length).toBeGreaterThan(0);

    const missing: number[] = [];
    for (const idx of sites) {
      // A method body ends at the first class-member-indented closing brace.
      const end = content.indexOf('\n  }\n', idx);
      const body = content.slice(idx, end === -1 ? content.length : end);
      // Any assignment that isn't clearing the record counts, so renaming the
      // local variable doesn't false-fail this.
      if (!/this\.ownedProfileDir\s*=\s*(?!null)/.test(body)) {
        missing.push(content.slice(0, idx).split('\n').length);
      }
    }

    expect(
      missing,
      `Each chromium.launchPersistentContext() call takes the profile's
ProcessSingleton, so each must record ownership (\`this.ownedProfileDir = ...\`)
in the same method — otherwise shutdown won't clear the locks that launch
created. Launch site(s) missing a claim at browser-manager.ts line(s): ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
