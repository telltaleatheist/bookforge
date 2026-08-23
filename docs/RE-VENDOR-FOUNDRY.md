# Re-vendoring `foundry-app/`

BookForge hosts the Foundry window inside its own process. The code that does it
is a **mechanical copy** of the Foundry repo's `app/` folder, living at
`foundry-app/`. When Foundry changes, the copy is refreshed — never edited here.
`foundry-app/VENDORED.md` is the running log of every refresh; this file is the
recipe.

Whole thing takes about five minutes, most of it the Angular build.

---

## 0. Get a sha first

The copy is taken with `git archive <sha>`, which **cannot copy a dirty working
tree**. If the Foundry checkout has uncommitted changes, the refresh is blocked
until they are committed — the sha is the only thing that identifies a build.

```sh
git -C /c/Users/tellt/Projects/foundry status --short
git -C /c/Users/tellt/Projects/foundry log --oneline -5
```

If it is dirty, ask the Foundry side to land it. There is usually a live Foundry
Claude session on this machine — `ListAgents` lists it as `Owen's PC - Foundry 1`
and `SendMessage` delivers straight into its turn. That is the fastest route;
the `C:\tmp\bookforge-to-foundry.md` file board is the slow fallback. Ask for the
sha and for anything in the change that touches the host seam.

Also make sure **BookForge's** tree is clean before you start, so the refresh is
the only thing in the diff.

## 1. Copy

Sources only. The three source directories are deleted first so that a file
deleted upstream actually disappears here.

```sh
SHA=<the sha>
SCRATCH=<your scratchpad dir>
BF=/c/Users/tellt/Projects/bookforge
FO=/c/Users/tellt/Projects/foundry

git -C "$FO" archive "$SHA" app > "$SCRATCH/foundry-app.tar"
rm -rf "$BF/foundry-app/electron" "$BF/foundry-app/shared" "$BF/foundry-app/src"
cd "$BF/foundry-app" && tar --force-local -xf "$SCRATCH/foundry-app.tar" --strip-components=1
git -C "$FO" show "$SHA:docs/IPC-CHANNELS.md" > "$BF/foundry-app/IPC-CHANNELS.md"
```

`--force-local` matters on Windows: without it `tar` reads `C:\...` as a remote
host. `--strip-components=1` drops the leading `app/`.

`IPC-CHANNELS.md` is **not** part of `app/` — it is `docs/IPC-CHANNELS.md`,
carried along because it is the authority `tools/test-ipc-collision.js` parses.
Take it from the same sha, always.

Two files in `foundry-app/` are ours and must survive the copy: `VENDORED.md`
(this side's log) and the extracted `IPC-CHANNELS.md`. Nothing else here is.

## 2. Verify the copy is exact

Compare **index blob shas**, not file bytes. BookForge has `core.autocrlf=true`,
so the working files here are CRLF and the Foundry ones are LF — `md5sum` and
`diff` will disagree for no reason, but git stores both sides LF-normalized, so
blob shas are the honest comparison.

```sh
git -C "$BF" add -A foundry-app          # stage, so the index reflects the copy

ok=0; bad=0
while read -r f; do
  src=$(git -C "$FO" rev-parse "$SHA:app/$f" 2>/dev/null)
  dst=$(git -C "$BF" ls-files -s "foundry-app/$f" | awk '{print $2}')
  if [ -n "$src" ] && [ "$src" = "$dst" ]; then ok=$((ok+1));
  else bad=$((bad+1)); echo "MISMATCH $f"; fi
done < <(git -C "$FO" ls-tree -r --name-only "$SHA" app | sed 's|^app/||')

# and the channels doc, which comes from docs/ not app/
[ "$(git -C "$FO" rev-parse "$SHA:docs/IPC-CHANNELS.md")" \
  = "$(git -C "$BF" ls-files -s foundry-app/IPC-CHANNELS.md | awk '{print $2}')" ] \
  && ok=$((ok+1)) || { bad=$((bad+1)); echo "MISMATCH IPC-CHANNELS.md"; }

echo "$ok match, $bad problems"
```

Also glance at `git status --short foundry-app` — the changed files should be
exactly the ones the Foundry commit names. Anything else means the copy went
wrong.

## 3. Install deps — only if the copy moved them

```sh
git -C "$BF" status --short foundry-app | grep -E 'package(-lock)?\.json'
```

If neither moved, **skip this step**. If either did:

```sh
cd "$BF/foundry-app" && npm ci
```

`npm ci`, never `npm install` — `ci` installs exactly what the arriving lockfile
says and never rewrites `package.json`. `npm install` on this machine has been
observed dropping a `package.json`'s whole `scripts` block.

## 4. Build the subtree

The subtree has its own `package.json`, its own `node_modules` and its own
Angular major. **BookForge's build does not compile a line of it** —
`tsconfig.electron.json` and `tsconfig.app.json` are `include`-based and name
only `electron/`, `shared/`, `packages/quire/src/` and `src/`. So this build is
the only one that matters, and running BookForge's own build proves nothing
about the refresh.

```sh
cd "$BF/foundry-app" && npm run build
```

That is `tsc -p tsconfig.electron.json` → `dist/electron` + `dist/shared`, then
`ng build` → `dist/renderer`. Expect one WARNING (initial bundle over the 500 kB
budget, ~800 kB) — pre-existing, not yours.

Confirm the one file BookForge actually imports now exists and is fresh:

```sh
ls -l "$BF/foundry-app/dist/electron/mount.js"
```

BookForge **refuses to start** without it. `dist/` and `node_modules/` are
gitignored by the subtree's own `.gitignore`, so they never appear in the commit.

### Restart the app — a running BookForge does not pick this up

If BookForge was running while you refreshed, **quit and relaunch it before
testing anything**. Electron reads main-process code once, at launch, but the
Foundry window loads its renderer bundle from `dist/renderer` every time it
opens. So a window opened after a refresh pairs a NEW renderer with the OLD main
process, and the first thing the change added is the first thing that breaks:

```
Error invoking remote method 'queue:run': No handler registered for 'queue:run'
```

That is the shape of every version of this — a channel the renderer knows about
and the running main does not. It is not a bad copy and not a failed build;
check `dist/electron/ipc.js` for the channel and the process start time against
the build time before chasing anything else.

Quit it properly rather than killing it: `stopFoundry()` runs in `before-quit`
ahead of the global WSL sweep, and that order is what keeps a GPU holder from
being orphaned.

## 5. Run the keepers

```sh
cd "$BF" && node tools/run-keepers.js
```

The one that exists for this is `test-ipc-collision` — it parses the refreshed
`IPC-CHANNELS.md` against BookForge's own `electron/**/*.ts` sources and fails if
a Foundry channel name now collides with one of ours. Both apps register into the
same main process and `ipcMain.handle` throws on a duplicate, so a collision is
an app that will not launch.

Trust the exit code / `ALL KEEPERS GREEN`, not a line count.

If it does collide: the fix is on **our** side by precedent — BookForge renamed
`window:close` → `window:close-main` when Foundry added `window:close`, because
the subtree is sealed.

## 6. Read the diff for host-seam changes

The copy compiles and the keepers pass, and the change can still mean something
for BookForge. Read the Foundry commit — particularly `docs/BOOKFORGE-HANDOFF.md`,
which is where the two sides record the contract — and check whether:

- the mount seam's exports moved (`mountFoundry`, `openFoundryWindow`,
  `stopFoundry`, `hostedLibraryDir`, `setHostNodes`, `setHostStatus`, …), which
  would need `electron/main.ts` to move with them;
- a host callback's payload changed (`onExport`, `onImport`, `onNodeAction`);
- routing changed — e.g. `eb24afa` made the Export dialog stop enqueueing
  entirely, so exports pressed there never reach BookForge's queue, while the
  `onExport` landing was untouched.

Behaviour changes like that need a paragraph in `VENDORED.md` even when no code
of ours has to change, because nothing in the build or the keepers can see them.

## 7. Log it and commit

Update `foundry-app/VENDORED.md`:

- the header table's **Source sha**, its one-line description, **Copied on**, and
  the sha inside the `Copied by` command;
- a paragraph appended to the running history, before the
  "`IPC-CHANNELS.md` beside this file…" line — what the commit does, what it
  means for the host, and the verification numbers (blobs matched, whether deps
  moved, build result, keeper result).

`VENDORED.md` is the **one file in this directory that is ours to edit**.

```sh
git -C "$BF" add -A foundry-app
git -C "$BF" commit -m "chore(foundry-app): vendor <sha> — <what it does>"
```

---

## The rules that don't change

**The subtree is sealed.** Never edit anything under `foundry-app/` except
`VENDORED.md`. A fix made here is lost at the next refresh and, worse, makes two
copies disagree while both look authoritative. If something in there is wrong,
it is wrong in Foundry — say so on the `bookforge-sync` switchboard channel or
straight to the Foundry session, and take the next sha.

**Never `cp`/`rsync` between the checkouts.** `git archive` only. Copying
CRLF working files into a Linux/macOS checkout injects CRLF and leaves that
checkout permanently dirty (see `CLAUDE.md`).

**A version bump is a separate act.** `foundry-app/` is the Foundry *app*; the
`foundry.exe` *engine* is a managed component installed from a GitHub release.
Refreshing the subtree does nothing to the engine. If the change needs a newer
engine, that is a Foundry release — bump `package.json` first (nothing else moves
that number), then build, package and `gh release create`. BookForge's component
check compares the version *number*, so an engine rewritten without a bump is
invisible to it. This has bitten twice.
