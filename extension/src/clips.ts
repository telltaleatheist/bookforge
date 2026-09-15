/**
 * THE ZERO-SHOT CLIP STORE — this browser's own reference recordings.
 *
 * docs/EXTENSION-TO-CRUCIBLE-PLAN.md §4b, crucible `docs/PHASE3-TTS.md` §5's
 * amendment. A `zeroshot` voice is the base weights plus somebody's voice: the
 * WEIGHTS are the server's, pulled at the manifest's pin, and the CLIP is the
 * client's. BookForge keeps its four in
 * `<userData>/runtime/higgs-models/refs/`; this extension keeps its own here.
 * Two clients, two clip stores, ONE voice subject — picking a clip is a
 * per-client choice like the voice pick itself, so there is no second owner.
 *
 * ── WHY INDEXEDDB AND NOT `chrome.storage.local` ──────────────────────────
 *
 * `chrome.storage.local` holds JSON. A fifteen-second wav is ~1.4 MB of
 * binary, and putting it there means base64 in a settings object that every
 * `loadSettings()` in three contexts reads and re-parses on every call — a
 * settings read that costs two megabytes of string work is a settings read
 * somebody will later move off the hot path and break. IndexedDB stores the
 * ArrayBuffer as bytes, is asked only when a clip is actually wanted, and is
 * the same per-profile, page-unreachable storage the tokens sit in.
 *
 * The CHOICE — which clip the Load button will send — is a settings key
 * (`zeroshotClipId`), because it is one short string and it belongs beside the
 * voice it qualifies.
 *
 * ── NOTHING HERE REPAIRS ANYTHING ─────────────────────────────────────────
 *
 * A file that is not a RIFF/WAVE container, a clip over narrator's 30-second
 * budget, a clip over the 32 MiB ceiling and a blank transcript are all
 * refused AT ADD TIME with the server's own `reference_malformed`
 * (`shared/crucible/voice-reference.ts`), so a bad clip never reaches the
 * store and therefore never reaches a load. None of them is trimmed,
 * converted or transcribed: a clone from audio nobody chose, or against a
 * transcript nobody wrote, is a whole book in a subtly wrong voice reported as
 * success.
 */

import {
  VoiceReferenceRefused,
  encodeReferenceData,
  refuseBlankTranscript,
  refuseUnusableClip,
} from '../../shared/crucible/voice-reference';

const DB_NAME = 'bookforge-reader-clips';
const DB_VERSION = 1;
const STORE = 'clips';

/** One stored clip, without its bytes — what the pickers and the list draw. */
export interface ClipSummary {
  /** Stable id, minted on add. The `zeroshotClipId` setting names one of these. */
  readonly id: string;
  /** The short label a person typed. Sent as the reference's `name`. */
  readonly name: string;
  /** The BOOK-EXACT text spoken in the clip. Required, never an ASR guess. */
  readonly transcript: string;
  /** From the wav's own header, never estimated from the file size. */
  readonly seconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** The whole file, header included. */
  readonly byteLength: number;
  /** ISO 8601. */
  readonly added: string;
}

interface StoredClip extends ClipSummary {
  readonly bytes: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    // A browser that will not open its own database is said out loud. There is
    // no in-memory second store to fall back to: a clip nobody can save is a
    // clip that silently disappears on the next popup.
    request.onerror = () => reject(new Error(
      `The clip store (IndexedDB "${DB_NAME}") could not be opened: `
      + `${request.error?.message ?? 'no reason given'}.`,
    ));
  });
}

/**
 * One IDBRequest as a promise.
 *
 * NOT called `run`, and the reason is not style. Every module esbuild bundles
 * into `offscreen.js` shares one top-level scope, so a top-level `run` here
 * collides with `foldCapsRun`'s own `let run = 0` in
 * `shared/listen-text/normalize.ts` and esbuild renames the LOCAL one to
 * `run2`. Nothing breaks — but `tools/test-listen-text-one-source.js` compares
 * the shipped bundle's function bodies against a second bundle of the shared
 * source BYTE FOR BYTE, and a renamed local is a byte difference. That keeper's
 * header names this exact collision and prescribes this exact fix: rename the
 * colliding TOP-LEVEL symbol in the extension's own source, because licensing
 * `X` ≡ `X<digits>` there would also license a genuine paste that happened to
 * be numbered.
 */
function awaitRequest<T>(store: IDBObjectStore, request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(
      `The clip store refused a ${store.name} operation: `
      + `${request.error?.message ?? 'no reason given'}.`,
    ));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  try {
    return await fn(db.transaction(STORE, mode).objectStore(STORE));
  } finally {
    db.close();
  }
}

function summaryOf(clip: StoredClip): ClipSummary {
  return {
    id: clip.id,
    name: clip.name,
    transcript: clip.transcript,
    seconds: clip.seconds,
    sampleRate: clip.sampleRate,
    channels: clip.channels,
    byteLength: clip.byteLength,
    added: clip.added,
  };
}

/** Every clip in this browser, oldest first. */
export async function listClips(): Promise<ClipSummary[]> {
  const all = await withStore('readonly', (s) => awaitRequest(s, s.getAll() as IDBRequest<StoredClip[]>));
  return all
    .slice()
    .sort((a, b) => a.added.localeCompare(b.added))
    .map(summaryOf);
}

/** One clip by id, or null — null is "it was removed", not an error. */
export async function findClip(id: string): Promise<ClipSummary | null> {
  const got = await withStore('readonly', (s) => awaitRequest(s, s.get(id) as IDBRequest<StoredClip | undefined>));
  return got === undefined ? null : summaryOf(got);
}

/**
 * Add a clip, or refuse it BY THE SERVER'S NAME.
 *
 * Every check the bytes can answer happens here, before a byte is stored:
 * size, container, duration, transcript. A clip that would be refused
 * `reference_malformed` on the wire is refused with the same word in the
 * Options page, where the person can act on it — sending 40 MB across a LAN
 * so the server can say the same thing is a defect, not a safety net.
 */
export async function addClip(input: {
  name: string;
  transcript: string;
  bytes: Uint8Array;
}): Promise<ClipSummary> {
  const name = input.name.trim();
  if (name === '') {
    throw new VoiceReferenceRefused(
      'reference_malformed',
      'a clip needs a short name. It is what `/v1/activity` reports as the resident clip, and it '
      + 'is how you and anybody else on that server tell two recordings apart.',
    );
  }
  const facts = refuseUnusableClip(input.bytes, input.transcript, `the clip "${name}"`);
  // A COPY, not the caller's view: a Uint8Array over a larger buffer (a slice
  // of a FileReader result) would otherwise store the whole buffer and hand
  // back the wrong bytes on read.
  const bytes = input.bytes.slice().buffer;
  const clip: StoredClip = {
    id: `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    transcript: input.transcript.trim(),
    seconds: facts.seconds,
    sampleRate: facts.sampleRate,
    channels: facts.channels,
    byteLength: facts.byteLength,
    added: new Date().toISOString(),
    bytes,
  };
  await withStore('readwrite', (s) => awaitRequest(s, s.put(clip)));
  return summaryOf(clip);
}

/** Forget a clip. Removing one that is not there is not an error. */
export async function removeClip(id: string): Promise<void> {
  await withStore('readwrite', (s) => awaitRequest(s, s.delete(id)));
}

/**
 * The clip, in the shape `loadVoice(voice, {reference})` takes.
 *
 * Re-checked on the way out rather than trusted: a clip stored by an older
 * build of this extension, or one whose transcript was edited into blankness,
 * is refused here with the same name the server would use rather than sent and
 * refused there.
 */
export async function referenceFor(id: string): Promise<{
  data: string;
  transcript: string;
  name: string;
}> {
  const stored = await withStore('readonly', (s) => awaitRequest(s, s.get(id) as IDBRequest<StoredClip | undefined>));
  if (stored === undefined) {
    throw new VoiceReferenceRefused(
      'reference_required',
      `the clip this extension was told to use (${id}) is no longer in its clip store. Pick `
      + 'another in the popup, or add it again under Options → Zero-shot clips.',
    );
  }
  const bytes = new Uint8Array(stored.bytes);
  refuseUnusableClip(bytes, stored.transcript, `the stored clip "${stored.name}"`);
  refuseBlankTranscript(stored.transcript, `the stored clip "${stored.name}"`);
  return {
    data: encodeReferenceData(bytes),
    transcript: stored.transcript,
    name: stored.name,
  };
}
