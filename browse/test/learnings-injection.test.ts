import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT_PATH = path.join(import.meta.dir, '../../bin/gstack-learnings-search');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf-8');
const BIN_DIR = path.join(import.meta.dir, '../../bin');

describe('gstack-learnings-search injection safety', () => {
  it('must not interpolate variables into JS string literals', () => {
    const jsBlock = SCRIPT.slice(SCRIPT.indexOf('bun -e'));
    expect(jsBlock).not.toMatch(/const \w+ = '\$\{/);
    expect(jsBlock).not.toMatch(/= \$\{[A-Z_]+\};/);
    expect(jsBlock).not.toMatch(/'\$\{CROSS_PROJECT\}'/);
  });

  it('must use process.env for parameters', () => {
    const jsBlock = SCRIPT.slice(SCRIPT.indexOf('bun -e'));
    expect(jsBlock).toContain('process.env');
  });
});

// The script resolves GSTACK_HOME first and only falls back to $HOME/.gstack,
// so overriding HOME alone is not isolation: a GSTACK_HOME leaked into
// process.env by another test file (telemetry, domain-skills-*, cdp-e2e all set
// it at module top level) silently outranks HOME and the script reads that
// directory instead. Pin the state vars explicitly so the fake HOME decides.
const FAKE_HOME = '/tmp/nonexistent-gstack-test';
const FAKE_STATE_DIR = path.join(FAKE_HOME, '.gstack');

describe('gstack-learnings-search injection behavioral', () => {
  it('handles single quotes in query safely', () => {
    const result = spawnSync('bash', [
      path.join(BIN_DIR, 'gstack-learnings-search'),
      '--query', "test'; process.exit(99); //",
      '--limit', '1'
    ], {
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        ...process.env,
        HOME: FAKE_HOME,
        GSTACK_HOME: FAKE_STATE_DIR,
        GSTACK_STATE_ROOT: FAKE_STATE_DIR,
        GSTACK_STATE_DIR: FAKE_STATE_DIR,
      },
    });
    expect(result.status).not.toBe(99);
  });
});
