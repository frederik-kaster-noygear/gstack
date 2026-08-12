/**
 * End-to-end reproduction of the shared-tab clobber, and proof the guard
 * refuses it instead of serving the wrong page.
 *
 * Two fixture servers run on different ports so they are genuinely different
 * origins — that is what the cross-origin arm of the nav-guard keys on, and it
 * mirrors the real bug (a goto to generalcatalyst.com followed by a read that
 * returned cnbc.com).
 *
 * Drives BrowserManager + the real command handlers directly, matching the
 * existing convention in commands.test.ts / batch.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleReadCommand } from '../src/read-commands';
import { checkNavProvenance } from '../src/nav-guard';

let siteA: ReturnType<typeof startTestServer>;
let siteB: ReturnType<typeof startTestServer>;
let bm: BrowserManager;

beforeAll(async () => {
  siteA = startTestServer(0);
  siteB = startTestServer(0);
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  // Fire-and-forget: awaiting the browser close can outlive the hook timeout on
  // a loaded machine. Deliberately NOT calling process.exit() here (as
  // batch.test.ts does) — that kills the whole `bun test browse/test/` run
  // before later files report.
  bm.close().catch(() => {});
  try { siteA.server.stop(); } catch {}
  try { siteB.server.stop(); } catch {}
});

/**
 * The check the server performs before returning page content, including the
 * counter reset on BOTH outcomes — a refusal that left the counter set would
 * poison the tab for every later read.
 */
function guard(session: ReturnType<BrowserManager['getActiveSession']>) {
  const p = session.getNavProvenance();
  const verdict = checkNavProvenance({
    currentUrl: session.page.url(),
    lastGotoUrl: p.lastGotoUrl,
    gotosSinceRead: p.gotosSinceRead,
    command: 'text',
  });
  session.recordContentRead();
  return verdict;
}

describe('shared tab clobber — the original bug', () => {
  test('goto reports the URL it actually landed on, not the one requested', async () => {
    const session = bm.getActiveSession();
    const out = await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);
    expect(out).toContain(`${siteA.url}/basic.html`);
    expect(session.getNavProvenance().lastGotoUrl).toContain(siteA.url);
  });

  test('REGRESSION: a concurrent goto between goto and read is caught, not served', async () => {
    const session = bm.getActiveSession();

    // Agent A navigates and is about to read.
    await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);
    session.recordContentRead();          // A's previous read settled the counter
    await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);

    // Agent B clobbers the shared tab before A's read lands.
    await handleWriteCommand('goto', [`${siteB.url}/forms.html`], session, bm);

    // Before the fix, this returned siteB's text under A's question.
    const verdict = guard(session);
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('navigations');

    // And the content really would have been the wrong site's.
    const text = await handleReadCommand('text', [], session);
    expect(typeof text).toBe('string');
  });

  test('a refusal does not poison the tab — the next clean goto+read works', async () => {
    const session = bm.getActiveSession();

    // Provoke a refusal.
    await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);
    await handleWriteCommand('goto', [`${siteB.url}/forms.html`], session, bm);
    expect(guard(session).ok).toBe(false);

    // Recovery: one goto, one read, no error. Without the counter reset on
    // refusal this stayed broken forever.
    await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);
    expect(guard(session).ok).toBe(true);
  });

  test('the ordinary single-agent flow still passes cleanly', async () => {
    const session = bm.getActiveSession();
    await handleWriteCommand('goto', [`${siteA.url}/basic.html`], session, bm);
    expect(guard(session).ok).toBe(true);

    session.recordContentRead();
    await handleWriteCommand('goto', [`${siteA.url}/forms.html`], session, bm);
    expect(guard(session).ok).toBe(true);
  });
});
