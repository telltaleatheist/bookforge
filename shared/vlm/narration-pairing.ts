/**
 * Pairing an element of the NARRATION COPY back to the element of the BOOK it
 * was cut from.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-09: "maybe they forgot to remove a footnote and on their final
 * review they want to cut it. they can delete it, hit save, and then process."
 *
 * The narration copy is a preview of what TTS will read, and the last place a
 * stray footnote actually looks wrong. But a strike recorded against the COPY
 * would be recorded against a file that is rewritten from scratch on every
 * export — so it would survive exactly until the next cut and then vanish. The
 * durable record keys against the BOOK (`outputs.epub.narrationDeletions`), so a
 * gesture made on the copy has to be TRANSLATED into the book's own key before
 * it can be written. That translation is this file.
 *
 * ── Why by SEQUENCE, not by looking a signature up ──────────────────────────
 *
 * The obvious design is "take the copy element's text, find the element in the
 * book that says the same thing". It does not survive contact with real books.
 * A signature is `tag|text-with-the-whitespace-removed`, and the elements a user
 * most wants to strike out of a narration copy are precisely the ones that
 * repeat: running heads, `* * *` separators, a `<p>` that is only a page number.
 * Looking those up by text is ambiguous for every single one of them, so a
 * lookup-based pairing would refuse the common case and accept the rare one.
 *
 * `writeNarrationEpub` already knows this. Its own verification
 * (`verifyNarrationCut` in electron/epub-processor.ts) checks the multiset of
 * signatures FIRST — which says which strike survived — and the SEQUENCE second,
 * which says the survivors are in the right places. It has to: "a key is an INDEX
 * and every index after a removal has shifted by construction". The sequence is
 * what makes an element identifiable when its text is not.
 *
 * So this reuses that pairing rather than inventing a weaker one. The copy is
 * the book minus what the cut took out, per document, in order. Therefore the
 * copy's Nth surviving element of a document IS the book's Nth surviving element
 * of that document — exactly, with no candidates to choose between. The
 * signatures are still compared, element for element, but as a PROOF that the
 * two files are still the same two files rather than as the means of pairing.
 *
 * ── The refusal ─────────────────────────────────────────────────────────────
 *
 * When the sequences do not agree, the copy and the book have come apart: the
 * book was rewritten by a pass since the copy was cut, or the record moved. That
 * is refused BY NAME — naming the document, the position and what the two sides
 * say there — and never reconciled. Reconciling would mean this code deciding
 * which of two disagreeing files is right, and a strike landing on the wrong
 * paragraph is silently worse than a strike that did not land.
 *
 * ── What the caller owes it ─────────────────────────────────────────────────
 *
 * The signatures and the `admitted` flag, both computed with
 * `signNarrationElements` (electron/epub-processor.ts) — the writer's own rule,
 * called rather than restated. This file stays pure so the pairing can be tested
 * against fixtures without a DOM. Two things the caller must get right, because
 * the cut transforms the book on its way out:
 *
 *   • FOOTNOTE MARKERS come out of the copy when `stripSupMarkers` is on, which
 *     is the default. Sign BOTH sides with the strip applied: on the book it
 *     removes the markers, on the copy it finds none to remove, and the two meet
 *     whichever way the cut was actually made. That is why nothing here has to
 *     know what the cut chose — a question the record did not always answer.
 *   • CHAPTER OPENINGS speak their chapter's stored name in the copy
 *     (`chapterSpeechOverrides` in electron/narration-export.ts), so the book's
 *     signature for one of those elements must be taken after the same override
 *     is applied to it.
 */
import {
  type NarrationElementKey,
  parseNarrationElementKey,
} from './narration-deletions';

/** One element, as the pairing sees it: what names it, and what it says. */
export interface SignedNarrationElement {
  readonly key: NarrationElementKey;
  /**
   * `tag|text` for a unit, `tag|src` for a picture — what
   * `narrationUnitSignature` and `narrationImageSignature` produce.
   */
  readonly signature: string;
}

/** A book element, plus whether the cut book still holds it. */
export interface PairableBookElement extends SignedNarrationElement {
  /**
   * Will a walk of the CUT book still enumerate this element?
   *
   * FALSE for a struck element, and also for one the cut removes the meaning of
   * without ever naming: an image-only wrapper whose picture was struck, a
   * picture inside a struck paragraph. `signNarrationElements` answers this —
   * it is not `!struck`, and treating it as `!struck` puts a strike made on the
   * copy of an illustrated book onto the wrong paragraph.
   */
  readonly admitted: boolean;
}

export interface NarrationCopyPairingInput {
  /**
   * Every element of the BOOK, in enumeration order — the order
   * `enumerateNarrationElements` walks it in, which is the order the keys were
   * minted in.
   */
  readonly book: readonly PairableBookElement[];
  /** Every element of the NARRATION COPY, walked the same way. */
  readonly copy: readonly SignedNarrationElement[];
  /**
   * Spine documents struck out of the book WHOLE (`<file>#doc`).
   *
   * Separate from the element flags because a document key names no element, so
   * nothing in `book` carries it — and the cut drops the document from the zip
   * entirely rather than emptying it.
   */
  readonly struckDocuments: readonly string[];
}

/**
 * The whole translation table, or the reason there isn't one.
 *
 * All-or-nothing on purpose. A partial table would let a gesture on one
 * paragraph succeed while the document it is in is provably out of step, which
 * is the shape of a strike landing somewhere nobody looked.
 */
export type NarrationCopyPairing =
  | { readonly ok: true; readonly pairs: ReadonlyMap<NarrationElementKey, NarrationElementKey> }
  | { readonly ok: false; readonly reason: string };

/** The stock ending: what the user can actually do about a copy out of step. */
const REGENERATE =
  'Nothing was struck. Generate the TTS copy again from your book, then try the deletion again.';

/** The readable half of a signature, for a sentence a person has to act on. */
function says(signature: string): string {
  const bar = signature.indexOf('|');
  const text = bar < 0 ? signature : signature.slice(bar + 1);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Group elements by their document, keeping enumeration order within each. */
function byDocument<T extends SignedNarrationElement>(
  elements: readonly T[],
  whose: string,
): Map<string, { units: T[]; images: T[] }> {
  const out = new Map<string, { units: T[]; images: T[] }>();
  for (const element of elements) {
    const parsed = parseNarrationElementKey(element.key);
    if (parsed.kind === 'doc') {
      throw new Error(
        `${element.key} names a whole document, and a document is not an element the pairing can `
        + `sign. Enumerate ${whose} units and pictures, not its deletion record.`,
      );
    }
    let group = out.get(parsed.file);
    if (!group) { group = { units: [], images: [] }; out.set(parsed.file, group); }
    (parsed.kind === 'image' ? group.images : group.units).push(element);
  }
  return out;
}

/**
 * Translate every element of the narration copy into the book element it came
 * from, or refuse and say why.
 *
 * The pairing is per document and per kind: text units and pictures are two
 * numbered namespaces walked separately (`<file>#12` and `<file>#img0`), and the
 * cut removes from each independently, so they line up independently too.
 */
export function pairNarrationCopyToBook(
  input: NarrationCopyPairingInput,
): NarrationCopyPairing {
  const struckDocuments = new Set(input.struckDocuments);
  const book = byDocument(input.book, 'the book\'s');
  const copy = byDocument(input.copy, 'the narration copy\'s');

  const pairs = new Map<NarrationElementKey, NarrationElementKey>();

  for (const [file, copyGroup] of copy) {
    const bookGroup = book.get(file);
    if (bookGroup === undefined) {
      return {
        ok: false,
        reason: `The TTS copy contains ${file}, and your book has no document by that name. The two `
          + `files have come apart. ${REGENERATE}`,
      };
    }
    if (struckDocuments.has(file)) {
      return {
        ok: false,
        reason: `${file} is struck out of your book whole, so the TTS copy should not contain it at `
          + `all — the copy on disk was cut before that strike. ${REGENERATE}`,
      };
    }

    for (const [what, copySide, bookSide] of [
      ['text element', copyGroup.units, bookGroup.units],
      ['picture', copyGroup.images, bookGroup.images],
    ] as Array<[string, SignedNarrationElement[], PairableBookElement[]]>) {
      // What the cut leaves behind, in the book's own order. The same list
      // `writeNarrationEpub` builds as its expectation before it removes
      // anything, from the same rule — so comparing against it here is the same
      // comparison its verifier makes after it writes.
      const survivors = bookSide.filter((element) => element.admitted);

      if (survivors.length !== copySide.length) {
        return {
          ok: false,
          reason: `${file} should hold ${survivors.length} ${what}(s) once everything struck out of `
            + `your book is taken out, and the TTS copy holds ${copySide.length}. The copy on disk `
            + `was cut from a different book, or before your last strike. ${REGENERATE}`,
        };
      }

      for (let at = 0; at < copySide.length; at++) {
        const fromCopy = copySide[at];
        const fromBook = survivors[at];
        if (fromCopy.signature !== fromBook.signature) {
          return {
            ok: false,
            reason: `The TTS copy and your book disagree about ${what} ${at + 1} of ${file}. The `
              + `copy says "${says(fromCopy.signature)}" and the book says `
              + `"${says(fromBook.signature)}". ${REGENERATE}`,
          };
        }
        pairs.set(fromCopy.key, fromBook.key);
      }
    }
  }

  // Every document the book still has something in must be IN the copy. The cut
  // prunes a document only when it loses everything, so one that kept an element
  // and is missing from the copy means the copy predates the record — the same
  // coming-apart the sequence checks above catch inside a document, caught here
  // for a document that is not in the copy to check.
  for (const [file, bookGroup] of book) {
    if (copy.has(file) || struckDocuments.has(file)) continue;
    const survivors = [...bookGroup.units, ...bookGroup.images].filter((e) => e.admitted);
    if (survivors.length === 0) continue;  // emptied by the strikes, so pruned on purpose
    return {
      ok: false,
      reason: `Your book's ${file} still has ${survivors.length} element(s) nobody struck, and the `
        + `TTS copy does not contain that document at all. ${REGENERATE}`,
    };
  }

  return { ok: true, pairs };
}

/**
 * The book keys for a gesture made on the narration copy, or the refusal.
 *
 * The narrow thing a caller actually wants: it has the copy's keys from the
 * blocks under the gesture, and it needs the book's keys to write. Refuses the
 * WHOLE gesture when any one key cannot be translated, for the same reason the
 * table is all-or-nothing — half a deletion is not a smaller deletion, it is a
 * deletion the user cannot see the shape of.
 */
export function bookKeysForCopyKeys(
  pairing: NarrationCopyPairing,
  copyKeys: readonly NarrationElementKey[],
): { ok: true; keys: NarrationElementKey[] } | { ok: false; reason: string } {
  if (!pairing.ok) return { ok: false, reason: pairing.reason };
  const keys: NarrationElementKey[] = [];
  const unknown: NarrationElementKey[] = [];
  for (const key of copyKeys) {
    const inBook = pairing.pairs.get(key);
    if (inBook === undefined) unknown.push(key);
    else keys.push(inBook);
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `${unknown.length} of the ${copyKeys.length} element(s) you deleted are not in the TTS `
        + `copy this window measured — the first is ${unknown[0]}. Nothing was struck. Reopen the `
        + 'TTS copy and try again.',
    };
  }
  return { ok: true, keys };
}
