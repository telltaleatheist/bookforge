# Multi-Server Bookshelf

Design for turning the Bookshelf app from a single-server client into one that
connects to **many BookForge servers at once**, merges their libraries into one
shelf, consolidates reading analytics under a single phone-owned identity, and
treats the phone itself as a local library.

Status: **design agreed, implementation in slices** (see the bottom of this doc).

---

## Motivation

Today the app is single-server by design: one `baseUrl` in
`ServerConfigService` drives every fetch, and the reader token, analytics,
positions, and covers are all scoped to that one server. The user runs BookForge
on several machines (`owens-pc`, `owens-mac-studio`) whose libraries are synced
by Syncthing, and wants their phone to see **all** their books at once, with one
combined reading history — regardless of which machine served a given book.

---

## Servers

`ServerConfigService` holds a persisted **list** of servers instead of a single
base URL:

```ts
interface ServerEntry {
  id: string;        // stable, generated once
  label: string;     // display name (defaults to the host)
  url: string;       // base origin; '' = same-origin web; local entry is virtual
  enabled: boolean;  // checkbox in the menu: show/hide this server's books
  local?: boolean;   // the phone's own on-device library
}
```

- The old `SUGGESTED_SERVERS` chips (`Mac Studio`, `PC`) become **seed
  suggestions for adding** to this list, not a hardcoded target.
- A **dropdown menu** at the top of the shelf lists every server with a
  checkbox. **Checked** = its books are loaded and showing. **Unchecked** =
  hidden. The **X** on a row removes the entry entirely.
- Servers stay in the list permanently. Checking/unchecking only shows/hides
  books — it does **not** connect/disconnect. The app stays "connected" to all
  of them; removal is only via the X.

### Offline behavior

An offline server's books simply aren't in the shelf, and it sits **unchecked**
in the menu. The offline UX lives in the **menu**, not on book rows:

- Clicking an unchecked server to enable it kicks off a fetch and shows a
  **spinner** on that row while it pulls.
- Success → the row goes checked and its books appear.
- Failure → the row shows **"offline"** and stays unchecked. Tapping again is
  the retry gesture.

So the checkbox effectively means "enabled **and** reachable." No dead/greyed
book rows ever clutter the shelf.

---

## Book model

**One row per server. No dedup.** Even though Syncthing means the same book
exists on multiple machines, each server's copy renders as its own row.

- Every `Audiobook` / `Ebook` carries an **`originServerId`** plus a small
  origin badge so you can tell which machine it came from.
- The shelf = the concatenation of each enabled server's books.
- **Full per-server routing:** every call for a given book — cover, audio,
  chapters, VTT, position, heard, bookmarks, analytics, heartbeat — routes to
  that book's origin server, with that server's auth. No global "active server"
  for book operations.
- **Per-server position/heard/bookmarks**, keyed by `(serverId, bookPath)`. No
  cross-server progress sync — each server owns its own progress. (This is why
  the localStorage caches must be namespaced by `serverId`; today they're keyed
  by book path alone and would collide across servers.)

---

## Identity & analytics

The requirement — "consolidate the analytics from all connected servers so it
shows the total read" — only works if the app knows that "Owen on `owens-pc`"
and "Owen on `owens-mac-studio`" are the **same human**. Plex solves this with a
central cloud account (plex.tv). BookForge has **no cloud**, so the **local
profile on the device is the anchor** — it is the one place that knows every
server you've claimed a profile on, which makes it the natural aggregator.

### Trust model

We assume you only connect to a server you've been **explicitly granted access
to**, and that such servers are **trusted**. That single assumption removes the
entire "defend against a malicious server" problem — no keypairs, no signed
challenges, no recovery phrases. Two credentials ride on requests:

- **Server access key** — a shared per-server secret ("like a password to
  connect") that **gates the whole API**. Checked on *every* request, not just at
  connect — otherwise anyone who can reach the URL is in. (This is real new work
  on the desktop server: today the read endpoints have no auth at all.)
- **Reader token** — who you are, from your PIN login. This already exists
  (`ReaderService`: `createReader(name, pin)` / `loginReader(id, pin)`).

### The local profile (mandatory) and claiming it on a server

- Every device (desktop, iPhone, web) keeps a **mandatory local profile**. You
  set a **PIN once** when you create it.
- The PIN is **cached on the device** after first use — you never re-type it on
  that device. You only enter it again on a **new** device.
- When you connect to a server, it asks **"use an existing profile?"** Choosing
  yours **claims** the server-side profile with the PIN (proving it's you), then
  the device caches that login. From then on the server "ports your profile in"
  automatically.
- The server holds the **canonical** profile; devices are trusted local caches
  that sync to it. Losing a device strands nothing — reconnect, claim with the
  PIN, done. (This is what replaces Plex's cloud and our old recovery phrase.)

### Consolidation stays on the device

The phone is logged into your profile on each server, so it just fans
`getAnalytics()` across enabled servers and **combines them locally**. "You" is
implicitly "whoever the device is logged in as on each server" — no global user
ID needed.

### Merging without double-counting — the idempotent rule

**The danger:** on first connect, the local profile has reading history and the
server has (some of) the *same* history. Naively adding local totals + server
totals **multiplies the overlap**. Same risk when the offline queue re-flushes,
or when a device re-syncs.

**The fix: never add across the local↔server boundary. Give every reading
contribution a stable identity so identical data lands in the *same slot* on
both sides, and merge by union/upsert — then derive totals from the deduped
set.** Concretely, analytics are stored as **keyed buckets**, not running totals:

```
key   = (readerId, bookKey, dayBucket, deviceId)
value = seconds that device accrued for that book on that day
```

- A given **device × book × day** is exactly **one** bucket. Syncing **upserts**
  it (replace / keep-the-larger), never adds — so the same session on both sides
  collapses to one copy. **Re-syncing is a no-op.**
- Different **devices** are different keys, so reading on your phone *and* your
  laptop the same day legitimately **sums** — that's not double-counting.
- The displayed total = **sum over the deduped bucket set**. Merge and the
  offline flush are therefore **idempotent**: running them twice yields the same
  number.
- Each queued offline event (slice 5) carries its bucket key, so replaying the
  queue can't inflate the total either.

**Server-side change:** today `/api/analytics/heartbeat` accumulates a per-book
running sum. To make merge idempotent, analytics storage must become
**device-partitioned buckets** (the key above) with an **upsert** endpoint, and
totals computed by summing buckets. Reading *coverage* (`/api/heard` intervals)
and *position* already dedupe naturally — heard by interval **union**, position
by newest-timestamp — so only the seconds/daily analytics need this rework.

Note: the same book read from two **different servers** is genuinely two
engagements (per-server position, one row per server), so summing those across
servers is correct — it is not the double-count case. The double-count case is
strictly **local cache vs the same server's own record**, which the bucket key
dedupes.

---

## Phone as a local server

The phone is just another server entry — a synthetic **"This iPhone"** with
`local: true` and **no analytics** (per product decision). Its books live on the
device, and it's **self-contained** — your own finished media just works,
offline, with no real server involved:

- **Imported audiobook (M4B/MP3/...)** — self-contained audio. Plays on-device
  with the existing AVPlayer / HTMLAudio backend. Nearly free.
- **Imported EPUB** — self-contained text. Rendered by a **new on-device EPUB
  reader** (the real new work here, since today's reader streams text blocks
  from a server). No server needed to read it.

The `+ import` button — currently a server round-trip, which is why it "only
works for iOS / isn't wired up" — writes into this local library.

### Turning a local EPUB into an audiobook = TTS, which needs a server

The phone can't run TTS. That's the **only** case where a local file leaves the
device, and it's surfaced through the existing TTS action, not a separate
"transfer" concept (see next section).

---

## TTS in a multi-server world

TTS is a **server-side** operation, so in a multi-server world you pick which
server does the work:

- Hit **TTS** → a **server picker** pops up listing connected servers → choose
  one → the existing pipeline runs there, **unchanged**.
- **Server-resident EPUB**: exactly today's flow plus one "which server" tap.
- **Phone-local EPUB**: picking a server also **uploads** the EPUB to it to be
  voiced; the result lands as **that server's** book and appears under it in the
  list. (This is the user's earlier "transfer" idea, but only as the natural
  consequence of "run TTS on server X," not a standalone feature.)

---

## Offline download & offline analytics

The top-of-app **download button** saves a book for offline use. A downloaded
book is an **offline cache of a book that still belongs to its origin server** —
it stays origin-tagged so analytics keep crediting the right account.

### Web app

Plain file save: an `<a download>` on the book's file URL drops the M4B (or
EPUB) into the phone's Downloads. No offline *playback* in the browser — that
would need a PWA/service-worker cache, which is out of scope. The user just
wants the file on the phone.

### iOS app — real offline

- Download the book's files into device storage (Capacitor Filesystem) and mark
  it **available offline**.
- **Full offline bundle** for audiobooks: audio + cover + chapter marks + VTT
  transcript, so follow-along highlighting and chapter nav work with no server.
- **Ebooks download too**: the EPUB is saved for offline reading via the
  on-device reader (couples with slice 4).
- **Playback/read source resolution** becomes: *if downloaded → use the local
  file; else → stream from the origin server.* So a downloaded book plays in a
  subway tunnel.

### Offline analytics — durable queue + optimistic local tally

- Live analytics (heartbeat / position / heard / bookmarks) normally post to the
  origin server. When that server is unreachable, the events instead go into a
  **persistent queue** on the phone, keyed by origin server.
- A **flusher** drains each server's queue whenever it's reachable again.
- Meanwhile the phone's **consolidated total counts the listen immediately** —
  the phone is already the analytics aggregator (see Identity & analytics), so
  an offline listen bumps your on-phone total right away and the per-server copy
  catches up on reconnect. No double-counting: the queued events are the same
  ones that would have posted live.

This machinery is nearly identical to the phone-local library — a local file
that plays/reads offline. The only difference: a *downloaded* book has an origin
server to sync analytics back to; a *phone-imported* one does not.

## Book context menu

Per-book actions live in a context menu — **right-click on desktop, long-press
on iOS**. Every action routes to the book's **origin server** (per-server
progress), updates the server-namespaced local caches, and — offline — goes
through the analytics queue to flush on reconnect.

- **Download / Delete** — mirror images. Download saves the offline copy
  (slice 5). **Delete removes only the *local* copy**: for a downloaded book it
  drops the offline files (the book stays on its origin server, re-streamable);
  for a phone-imported book it removes it entirely (no server copy exists).
  Delete is shown **only when there is a local copy** — hidden for pure
  streaming books.
- **Mark completed** — sets progress to finished (position → end + completed
  flag); counts as completed in analytics.
- **Start over** — resets **position to the beginning AND the book's
  completion/progress %**, but **keeps lifetime analytics totals** (your
  time-read history is untouched). "Listen again from the top."
- **Erase history** — the nuclear option: wipes the book's analytics + position
  + heard + bookmarks on the origin server **and** the on-phone total, as if
  never read. Reuses the existing `/api/analytics/remove` endpoint. The book
  (and any download) remain.

## Implementation slices

Built in dependency order; each slice is meant to compile and be demoable on its
own.

1. **Servers-list data model** — `ServerConfigService` gains a persisted
   `ServerEntry[]` + active server, with `baseUrl()/url()/wsUrl()/setBaseUrl()/
   clear()/configured()/promptOpen` kept **backward-compatible** so every
   existing caller behaves identically in the single-server case. Adds
   `addServer/removeServer/toggleServer/setActive/enabledServers` and a
   per-server `url(path, serverId)`. *(foundation — everything depends on it)*

2. **Server dropdown menu + per-server book tagging** — the top-of-shelf menu
   (checkbox / X / spinner / "offline"); fan `getBooks`/`getEbooks` across
   enabled servers; tag books with `originServerId` + badge; route per-book
   calls (cover/audio/position/analytics) to origin. Namespace localStorage
   caches by `serverId`.

3. **Server access key + profile claim/merge + consolidated analytics**
   (trusted-server model — see Identity & analytics). Server side: require a
   shared **access key** on every request; convert analytics to
   **device-partitioned buckets** with an idempotent upsert. Client side: store
   the per-server access key + send it on every call; "use an existing profile?"
   → claim with PIN → cache the login so the PIN is never re-typed on that
   device; fan `getAnalytics()` across servers and combine with the **idempotent
   bucket merge** so local↔server overlap can't double-count. No keypair, no
   recovery phrase — identity is server-side, so recovery is just "log in again."

4. **Phone-as-local-server + on-device EPUB reader + TTS server picker** —
   synthetic "This iPhone" entry; local audio playback + on-device EPUB reader;
   wire the `+ import` button to the local library; add the server picker to the
   TTS action (with upload-to-voice for local EPUBs).

5. **Offline download + offline analytics** — the download button (web: file
   save; iOS: full offline bundle for audio, EPUB for ebooks). Playback/read
   source resolution prefers the local copy when the origin is unreachable.
   Durable per-server analytics queue with a reconnect flusher, plus optimistic
   crediting to the on-phone consolidated total. Ebook offline reading depends
   on the slice-4 on-device reader; analytics queue depends on slice 3.

6. **Book context menu** — right-click / long-press menu hosting Download,
   Delete (local-only), Mark completed, Start over, Erase history. All actions
   route to the book's origin server + server-namespaced caches. Delete's local
   half depends on slice 5; mark-completed / start-over / erase-history are
   per-server progress writes (slice 2/3).
