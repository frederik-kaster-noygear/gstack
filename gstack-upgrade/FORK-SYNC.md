# Fork sync (Step 3.5 of /gstack-upgrade)

Read this only when Step 3.5 detected `FORK_INSTALL=yes`. Vanilla installs never
reach here.

## Why this exists

A fork-with-carried-patch install has `origin` = your personal fork, carrying
local commits on top of upstream, plus a separate `upstream` remote pointing at
the official repo. On that layout Step 4's `git reset --hard origin/main` resets
to the FORK's main: it keeps your patch but pulls no new upstream. Syncing the
fork first makes the upgrade do both — rebase the carried commits onto the
latest upstream, push, and let Step 4 pull the result.

## Run this

```bash
cd "$INSTALL_DIR"
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
UPSTREAM_URL=$(git remote get-url upstream 2>/dev/null || echo "")
FORK_SYNC_RESULT="skip"
if [ -n "$UPSTREAM_URL" ] && [ "$UPSTREAM_URL" != "$ORIGIN_URL" ]; then
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    FORK_SYNC_RESULT="dirty-skip"        # don't rebase over uncommitted edits
  elif ! git fetch upstream --quiet 2>/dev/null; then
    FORK_SYNC_RESULT="fetch-failed"      # offline: upgrade to current fork state
  else
    UP_HEAD=$(git remote show upstream 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -1)
    UP_HEAD=${UP_HEAD:-main}
    git checkout main --quiet 2>/dev/null || true
    if git rebase "upstream/$UP_HEAD" >/tmp/gstack-fork-rebase.log 2>&1; then
      if git push --force-with-lease origin main >/tmp/gstack-fork-push.log 2>&1; then
        FORK_SYNC_RESULT="ok"
      else
        FORK_SYNC_RESULT="push-failed"
      fi
    else
      git rebase --abort 2>/dev/null || true
      FORK_SYNC_RESULT="conflict"
    fi
  fi
fi
echo "FORK_SYNC_RESULT=$FORK_SYNC_RESULT"
```

## Then branch on the result

Proceed to Step 4, EXCEPT on `conflict` / `push-failed`, which STOP the upgrade.

- **`skip`** — not actually a fork layout. Proceed to Step 4 unchanged.
- **`ok`** — rebased and pushed; Step 4 now pulls upstream + your patch. Tell the
  user: "Synced your fork onto the latest upstream, keeping your local patch."
- **`dirty-skip`** — uncommitted tracked edits, so the sync was skipped. Tell the
  user their edits are preserved and the upgrade goes to the current fork state
  (patch kept, no new upstream). Proceed to Step 4.
- **`fetch-failed`** — couldn't reach upstream, likely offline. Same outcome as
  `dirty-skip`: say so, then proceed to Step 4.
- **`conflict`** — **STOP. Do NOT run Step 4.** Your carried patch conflicts with
  new upstream. The rebase was aborted and the tree left clean. Tell the user to
  resolve it once:

  ```
  cd $INSTALL_DIR && git fetch upstream && git rebase upstream/main
  # fix the conflicts, then:
  git push --force-with-lease origin main
  ```

  Then re-run `/gstack-upgrade`. Point them at `/tmp/gstack-fork-rebase.log`.
- **`push-failed`** — **STOP. Do NOT run Step 4** — its `reset --hard origin/main`
  would discard the rebase you just made locally but could not push. Tell the
  user to run:

  ```
  cd $INSTALL_DIR && git push --force-with-lease origin main
  ```

  Then re-run `/gstack-upgrade`. Point them at `/tmp/gstack-fork-push.log`.
