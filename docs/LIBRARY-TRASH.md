# Deleting a tree in the library is a rename

*Written 2026-09-21, from a measurement on the live library.*

## The measurement

The library is ONE shared tree on a NAS, reached over SMB by both machines. A
project delete — `fs.promises.rm(projectDir, { recursive: true })` in
`electron/manifest-service.ts` — issued **2,694 unlinks in 28 s**, about 96
metadata operations a second, and the Mac's SMB client stalled mid-burst: every
process touching the share went into uninterruptible wait until a reboot. Twice
in two days.

The mount is soft now (EIO after ~30 s instead of a hang) and the NAS's
server-side recycle bin is off. The narration scratch went machine-local the
same day (`87d50e7d`), so the share no longer receives a render's working
files. What was left on the share was the DELETES: a project, an old cached TTS
session, the stage directories a "Start over" removes. `fs.rm(..., { recursive:
true })` is exactly the burst that wedges the client, issued as fast as the
kernel can pump it.

## The rule

**Library code never removes a directory tree. It discards it.**

`electron/library-trash.ts` is the one module that may, and
`discardLibraryTree(absPath, reason)` is the one door:

1. It renames the tree, in ONE operation, into
   `<libraryRoot>/.trash/<basename>-<ISO timestamp>-<6 hex>`. Same volume, so
   this is a rename on the share — instant, atomic, one metadata operation. **The
   user-facing delete is done the moment it returns**: the project is out of
   `projects/`, no scan can see it, no consumer can reach it.
2. A paced background remover drains `.trash` afterwards.

It refuses, by name, three paths that would be a catastrophe rather than a
delete: one outside the library root, the library root itself, and one already
inside `.trash`. A path that is not there answers `{ found: false }` — a discard
of something already gone is the answer the caller asked for, and with both
machines draining the same `.trash` that race is real.

## The pace

**40 unlinks a second** (`UNLINKS_PER_SECOND`). The burst that wedged the client
was ~96/s; 40 is well under half of it, with room for the other machine draining
the same `.trash` at the same time. A 2,694-file project takes ~67 s to actually
disappear from the disk instead of 28 s, and nobody can feel the difference —
the delete the user pressed finished at the rename.

One entry at a time, oldest first, depth first, yielding between every file. The
loop starts at app ready and restarts after `library:set-root`; it stops on quit
between files, so a quit costs less than one unlink.

## The grace

**60 seconds** (`SETTLE_GRACE_MS`). Both machines drain the same `.trash` over
SMB, where a directory listing is cached and a rename takes a moment to become
visible everywhere. An entry younger than the grace is left alone, so a remover
never walks a tree the other machine's rename has not finished publishing.

## Weather, not misconfiguration

The drain runs against a network share that can go away. `EIO`, `ETIMEDOUT` and
the rest of `isWeather` (`electron/bounded-copy.ts`) **pause** the drain; the
next pass picks the tree up where it stopped. Never a red row, never a crash,
never a sentence to the user — the files are already unreachable, and an hour
later is as good as now.

What IS named by throwing is misconfiguration: the three refusals above.

## The folder that will not move

Measured the same day. Owen deleted a project while macOS QuickLook had its
archive PDF memory-mapped from a Finder preview. Over SMB an open file cannot be
unlinked: the macOS client silly-renamed it to `archive/.smbdeleteAAA34f44.4`
(server-side smbd holds a read lease on it), `fs.rm` then failed with
`ENOTEMPTY: directory not empty, rmdir '.../archive'`, and the user was shown
"Couldn't delete 1 item: ENOTEMPTY…". Samba refuses to **rename** a directory
with an open file anywhere below it the same way — `NT_STATUS_ACCESS_DENIED`,
reaching the client as `EACCES`/`EPERM` — so the rename-aside hits the same wall.

None of that is a failure. Every one of those errnos (`HELD_CODES`: `EACCES`,
`EPERM`, `EBUSY`, `ENOTEMPTY`, `EEXIST`) stops being true when the holder closes
the file. So:

- `discardLibraryTree` writes `.bookforge-discarded` at the top of the tree —
  JSON: `{ reason, discardedAt, by: <hostname> }`, written through a temp name
  and a rename, which Samba allows even while a sibling below is held. **It is
  the user's own press recorded in place**, which is what makes finishing the
  job later a continuation rather than the app deciding to delete somebody's
  folder.
- It returns success with a `note`: *"… is deleted, but one file in it is still
  open in another program (a preview, Finder, or the other machine) — the folder
  finishes clearing when it is closed."* `deleteProject`'s IPC result carries it
  and Studio shows that line instead of a red error.
- **`listProjects` skips a directory carrying the marker**, so the project is
  gone from Studio and from the bookshelf the moment the marker lands — before
  anything inside it is touched.
- The remover sweeps `projects/` and `language-learning/projects/` for markers
  on every pass (one readdir plus one stat per project — nothing next to the
  burst this module exists to avoid), and for each marked tree it asks for the
  rename again first; if that is still refused it drains the tree in place at the
  pace, leaving the marker for last, and retries next pass. When the holder
  closes, the `.smbdelete*` stand-in disappears by itself and the folder goes.
- A `.smbdelete*` leftover under a tree already in `.trash` behaves the same:
  the rmdir answers `ENOTEMPTY`, the tree is reported `held`, not removed, and
  the next pass tries again.

## Both machines, no lock

There is none, and none is wanted. Two removers deleting the same tree is
harmless: whoever loses a file gets `ENOENT`, which the remover treats as
"already gone, keep going". The only thing the two must not do is race a rename
that is still settling, which the grace handles.

## A half-removed tree is a correct state

The rename comes first precisely so that this is true. A tree in `.trash` with
half its files gone is already out of the library; the next start continues it.
Nothing needs to be recovered, and nothing is left in an unrecoverable state by
a quit, a crash, or a share that vanishes mid-drain.

## Emptying it by hand

```sh
rm -rf "<library>/.trash"
```

From the NAS's own shell if you can, where the unlinks are local and no SMB
client is involved. Nothing in the app depends on anything in there, and
`.trash` sits beside `projects/` — every scan in the app reads `projects/`,
`foundry/`, `audiobooks/` or `bookshelf/`, never the library root itself, so
nothing sees it.

## What still removes trees directly, and why

Machine-local, scratch and staging paths are unchanged: the trash is the SHARED
library's answer to a metadata burst over SMB, and a local disk has no such
problem. That includes the render scratch (`narrator-paths.ts`), the page render
cache (`~/Documents/BookForge/cache`), the foundry run directories
(`~/Documents/BookForge/foundry-runs`), `/tmp/bookforge-staging`, the e2a temp
sessions, and every component/model install directory under `userData`.

## Keeper

`npm run test:library-trash` — the rename-aside shape, each refusal by name, the
pace asserted in a fake clock, ENOENT-under-foot skipped, weather pausing and
resuming, the settling grace, oldest-first, a stop that leaves a recoverable
tree, a rename refused by an open file writing the marker and answering with a
note, the remover draining a marked tree, and a `.smbdelete*` leftover retried
rather than reported.
