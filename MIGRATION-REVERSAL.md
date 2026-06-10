# Library → Projects Migration (2026-06-10) — Reversal Guide

## What the migration did

On 2026-06-10 the archival ebooks in `{library}/ebooks/` were reconciled into
manifest projects so every book became a project holding all its versions.

- **191 new projects created** in `{library}/projects/` — each is an
  archival-only project (a `source/original.*`, an `archive/` copy, a cover in
  `{library}/media/`, and a `manifest.json`). Every one carries a
  `migratedFrom` field naming its source ebook, so they are unambiguously
  identifiable.
- **5 archival originals attached** to pre-existing projects (their archive
  gained one `role:'original'` entry dated `2026-06-10`):
  - `Die_Moorsoldaten_-_Langhoff,_Wolfgang_(1935)` (+pdf)
  - `Ecclesiastical_Investigations_..._Father_Andras_Kun_...` (+pdf)
  - `For_the_Soul_of_the_People_Barnett_Victoria_J_-_Unknown` (+epub)
  - `Jehovah_s_Witnesses_Proclaimers_of_God_s_Kingdom_...` (+pdf)
  - `What_Did_You_Do_In_The_War,_Sister_...` (+epub)
- **48 skipped** (true duplicates / already-archived) and **10 junk-titled
  ebooks left in `ebooks/`** — no projects made for these.

**`ebooks/` was never modified.** Every copy was SHA-256-verified against its
source. `ebooks/` remains the source of truth, so reversal only has to remove
what the migration *added* to `projects/`.

## How to reverse it

The migration tool is `scripts/migrate-library-to-projects.mjs`; the reversal
tool is `scripts/reverse-migration.mjs`, driven by an authoritative snapshot
(`scripts/migration-2026-06-10-snapshot.json`) generated from the live disk
right after migrating.

```bash
# 1. (already done) capture the snapshot of what to undo
node scripts/reverse-migration.mjs --snapshot

# 2. preview the reversal — changes nothing
node scripts/reverse-migration.mjs

# 3. execute
node scripts/reverse-migration.mjs --apply
```

Reversal:
- **Deletes** the 191 created project folders — but **skips any project that
  has gained pipeline work** since migration (non-empty `stages/` or
  `output/`), printing a warning instead of destroying that work.
- **Removes** the 5 attached archive files and their manifest entries, leaving
  the rest of those pre-existing projects untouched.
- Leaves `ebooks/` completely alone.

## Belt-and-suspenders

A full pre-migration backup also exists outside the synced folder:
`/Volumes/Callisto/Shared/BookForge-backup-2026-06-10.zip` (everything except
regenerable `*.flac`/`*.wav`/`cache/`).

## Caveats

- If you've edited metadata or processed any migrated book in the app since the
  migration, that project will have a non-empty `stages/`/`output/` and the
  reversal will **skip** it (safe). Delete such a folder by hand only if you're
  sure you want to lose that work.
- The snapshot reflects the disk at generation time. If you migrate more books
  later, re-run `--snapshot` to refresh it.
