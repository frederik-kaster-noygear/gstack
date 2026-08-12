/**
 * Navigation provenance guard — turns "silently returned the wrong page" into
 * a loud error.
 *
 * ## The failure this exists to stop
 *
 * The browse server is ONE daemon per git root with ONE global `activeTabId`.
 * `goto` and `text` arrive as separate HTTP requests from separate CLI
 * processes, and `handleCommandInternalImpl` is async — it yields at every
 * await, so requests interleave. When two agents share a worktree:
 *
 *     agent A: goto https://example.com/a     ← commits, returns "Navigated to …"
 *     agent B: goto https://other.com/b       ← same tab, clobbers A
 *     agent A: text                           ← reads other.com/b
 *
 * A receives B's page wrapped in an UNTRUSTED envelope whose `source:` banner
 * says other.com/b. The banner is truthful; nothing warns A that this is not
 * the page it asked for. In one observed research session, 113 of 535 reads
 * (21%) came back from a different host than the preceding goto.
 *
 * ## What is checked
 *
 * Two independent signals, both cheap and both computed from state the tab
 * already owns (see TabSession.recordGoto / recordContentRead):
 *
 *   1. Cross-origin drift — the page's origin at read time differs from the
 *      origin the last goto committed to. `lastGotoUrl` is captured AFTER the
 *      navigation settles, so ordinary redirects are already absorbed and do
 *      not trip this. Same-origin path/query drift (SPA pushState, Cloudflare
 *      challenge tokens, tracking params) is deliberately tolerated.
 *
 *   2. Unread navigations — two or more gotos landed with no page-content read
 *      between them. That is the clobber signature above, and it catches the
 *      same-origin case that check 1 cannot see.
 *
 * ## What is deliberately NOT done
 *
 * The guard does not compare against a daemon-global "last goto", because on a
 * shared daemon the clobbering client updates that too — in the sequence above
 * a global lastGoto would read other.com/b and match, and the wrong content
 * would still be returned silently. Provenance must be per-tab.
 *
 * This detects the collision; it does not prevent it. Agents sharing a repo
 * still share a tab, so under sustained parallel use they will keep refusing
 * each other. Per-agent tab isolation is the actual fix and is not built yet.
 */

import { sanitizePageUrl } from './commands';

/** Scheme + host + port, or null if `url` is not a parseable absolute URL. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch (err: any) {
    if (!(err instanceof TypeError)) throw err;
    return null;
  }
}

/**
 * Non-http(s) pages the guard must not reason about as "content".
 * A read landing on one of these is a failed navigation, reported separately.
 */
export function isNonContentUrl(url: string): boolean {
  return /^(about:|chrome-error:|chrome:|data:)/.test(url);
}

export interface NavGuardInput {
  /** page.url() at read time. */
  currentUrl: string;
  /** URL the last goto on this tab committed to, or null if none. */
  lastGotoUrl: string | null;
  /** Gotos on this tab since the last page-content read. */
  gotosSinceRead: number;
  /** Command being run, for the error message. */
  command: string;
}

export interface NavGuardVerdict {
  ok: boolean;
  error?: string;
  hint?: string;
}

/**
 * Decide whether a page-content read is safe to return.
 *
 * Returns ok:true when there is no recorded goto — reads after `back`,
 * `reload`, `load-html`, or against a user-driven headed tab are legitimate
 * and have no requested-URL to check against. The guard only speaks when a
 * goto established an expectation that the page then failed to meet.
 */
export function checkNavProvenance(input: NavGuardInput): NavGuardVerdict {
  const { gotosSinceRead, command } = input;
  // Both URLs are page-controlled (history.pushState) and these messages go
  // straight to an LLM OUTSIDE the untrusted-content envelope, so they get the
  // same sanitization the envelope applies. Comparison below uses origins, which
  // truncation cannot affect for any realistic host.
  const currentUrl = sanitizePageUrl(input.currentUrl);
  const lastGotoUrl = input.lastGotoUrl === null ? null : sanitizePageUrl(input.lastGotoUrl);

  // No goto on this tab yet — nothing was promised, nothing to verify.
  if (!lastGotoUrl) return { ok: true };

  // One daemon per git root serves every agent in it, and they share one tab.
  // There is no per-tab isolation yet, so the honest advice is: re-navigate and
  // read immediately, and don't run browse from several agents at once.
  const isolationHint =
    `Re-run goto and read immediately. If several agents are using browse in this ` +
    `repo at once they share one tab and will keep clobbering each other — run them ` +
    `one at a time.`;

  // ── 1. Navigation landed somewhere that is not a page ──
  if (isNonContentUrl(currentUrl)) {
    return {
      ok: false,
      error:
        `Refusing to run "${command}": navigation to ${lastGotoUrl} did not load a page ` +
        `(tab is now at ${currentUrl}).`,
      hint: `The page failed to load or was navigated away. Re-run goto and check its ` +
            `reported URL before reading.`,
    };
  }

  // ── 2. Cross-origin drift since the goto committed ──
  const nowOrigin = originOf(currentUrl);
  const gotoOrigin = originOf(lastGotoUrl);
  if (nowOrigin && gotoOrigin && nowOrigin !== gotoOrigin) {
    return {
      ok: false,
      error:
        `Refusing to run "${command}": this tab is no longer on the page that was ` +
        `requested.\n  goto committed to: ${lastGotoUrl}\n  tab is now at:     ${currentUrl}\n` +
        `Returning this content would attribute ${nowOrigin} text to ${gotoOrigin}.`,
      hint: isolationHint,
    };
  }

  // ── 3. A navigation was discarded unread ──
  if (gotosSinceRead > 1) {
    return {
      ok: false,
      error:
        `Refusing to run "${command}": ${gotosSinceRead} navigations landed on this tab ` +
        `with no read between them, so the page that was read may not be the page this ` +
        `caller navigated to (current: ${currentUrl}).`,
      hint: isolationHint,
    };
  }

  return { ok: true };
}
