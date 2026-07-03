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
and "Owen on `owens-mac-studio`" are the **same human**. Today reader tokens are
independent per server, so we add a phone-owned cross-server identity.

### One profile = one keypair, born on the phone

- First run generates an **Ed25519 keypair**. The **hash of the public key is
  the user ID** — servers key analytics to it, and it's fine for servers to know
  it.
- The **private key never leaves the device**: iOS Keychain (Secure
  Enclave-backed) on native; PIN-derived-key-encrypted in localStorage on web.
- A **PIN**, set once, is the **local unlock** for the private key. It is never
  sent anywhere — it protects "someone picks up your unlocked phone," not the
  network.

### Why not just send a shared ID

If presenting an ID were all it took to read that ID's analytics, the ID would
be a **bearer secret handed to every server** — and a single malicious or
breached server could then impersonate you on all the others. Making the ID
longer doesn't help, because the whole point is that you give it out. So we
split the **identifier** (public, fine to share) from the **authenticator**
(private, never shared).

### Signed-challenge auth (TOFU)

- On first connect, the phone registers its **public key** with the server
  (trust-on-first-use).
- Every analytics read/write carries a **signature over a server-issued nonce**:
  server sends a random challenge → phone signs it → server verifies against the
  stored public key and scopes the response to the **proven** identity only.
- The server must **never** accept an identity as a raw request parameter and
  return its data — it returns only the identity that just proved itself. That
  is the actual defense against the injection/enumeration concern.
- A malicious server learns your public ID but **cannot impersonate you
  elsewhere**: it never sees the private key, and the signatures it collects are
  valid only for its own nonces.

### Consolidation stays on the phone

The phone fans `getAnalytics()` across all enabled servers (each call signed for
that server), then **sums totals and merges the per-book / per-day maps
locally**. Reading a book streamed from `owens-pc` posts its heartbeat to
`owens-pc`, signed by your key → credited to your unified identity on that
server → rolls up into your one total on the phone. A bad server can't reach
into the others.

### Recovery & multi-device (designed in from day one)

Because the profile *is* a key on the phone, losing the phone would otherwise
strand your history, and the web app / a tablet would be a different identity.
So:

- **Recovery phrase** (BIP39-style mnemonic) shown once at profile creation —
  reconstructs the private key on a replacement device.
- **Device pairing via QR**: an existing device displays a QR that transfers the
  key to the web app or a tablet, so all your devices share **one** identity
  (same ID → servers already trust it, no re-registration).

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

3. **Keypair identity + consolidated analytics** — Ed25519 keypair, Keychain /
   PIN-encrypted storage, PIN unlock, TOFU public-key registration,
   signed-challenge auth, on-device analytics consolidation, BIP39 recovery +
   QR pairing. Requires a server-side verify endpoint.

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
