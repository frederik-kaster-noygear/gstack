import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const TMP_HOME = path.join(os.tmpdir(), `gstack-telemetry-test-${process.pid}-${Date.now()}`);
const TELEMETRY_FILE = path.join(TMP_HOME, 'analytics', 'browse-telemetry.jsonl');

// Use GSTACK_HOME env to redirect telemetry writes (read each call,
// not cached at module-load).
//
// Bun runs test files sequentially in one process (module-load → tests →
// afterAll, then the next file), so an unrestored write here leaks into every
// file loaded afterwards. Anything that then spawns a gstack bin script picks
// it up, and GSTACK_HOME outranks both $HOME and GSTACK_STATE_DIR in those
// scripts — so the leak silently redirects a supposedly isolated child. Save
// and restore so the leak dies with this file.
const PRIOR_GSTACK_HOME = process.env.GSTACK_HOME;
const PRIOR_TELEMETRY_OFF = process.env.GSTACK_TELEMETRY_OFF;
process.env.GSTACK_HOME = TMP_HOME;
process.env.GSTACK_TELEMETRY_OFF = '0';

beforeEach(async () => {
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

afterAll(async () => {
  // Drain before restoring. logTelemetry is fire-and-forget and resolves the
  // path TWICE — once for ensureDir(), then again inside the .then() for
  // telemetryFile(). Restoring GSTACK_HOME in that window makes the append
  // re-resolve to os.homedir()/.gstack and land in the developer's REAL
  // analytics file. Let in-flight writes settle into TMP_HOME first.
  await new Promise((r) => setTimeout(r, 50));
  if (PRIOR_GSTACK_HOME === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = PRIOR_GSTACK_HOME;
  if (PRIOR_TELEMETRY_OFF === undefined) delete process.env.GSTACK_TELEMETRY_OFF;
  else process.env.GSTACK_TELEMETRY_OFF = PRIOR_TELEMETRY_OFF;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

async function readEvents(): Promise<any[]> {
  // Wait briefly for fire-and-forget appends to flush.
  await new Promise((r) => setTimeout(r, 30));
  try {
    const raw = await fs.readFile(TELEMETRY_FILE, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('telemetry: signals fire to ~/.gstack/analytics/browse-telemetry.jsonl', () => {
  it('logTelemetry writes a JSONL line with ts injected', async () => {
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    logTelemetry({ event: 'domain_skill_saved', host: 'test.com', scope: 'project', state: 'quarantined', bytes: 42 });
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('domain_skill_saved');
    expect(events[0].host).toBe('test.com');
    expect(events[0].bytes).toBe(42);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('GSTACK_TELEMETRY_OFF=1 silences all events', async () => {
    process.env.GSTACK_TELEMETRY_OFF = '1';
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    logTelemetry({ event: 'cdp_method_called', domain: 'X', method: 'y' });
    const events = await readEvents();
    expect(events).toHaveLength(0);
    process.env.GSTACK_TELEMETRY_OFF = '0';
  });

  it('telemetry never throws even if disk fails', async () => {
    // Point HOME to a path that doesn't exist + can't be created (root-owned)
    // — but that's hard to set up cross-platform. Just check that calling
    // logTelemetry on a missing directory doesn't throw.
    const { logTelemetry, _resetTelemetryCache } = await import('../src/telemetry');
    _resetTelemetryCache();
    expect(() => logTelemetry({ event: 'noop_test' })).not.toThrow();
  });
});
