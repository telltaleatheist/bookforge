/**
 * WHICH EXPORTED EPUB A NARRATION READS — the choice, on its own.
 *
 * `foundryNarrationTarget` in main.ts does two separable things: it finds the
 * book a Foundry project belongs to and reads its version list (claims, the
 * manifest, the disk), and then it CHOOSES which of that project's exported
 * EPUBs the press meant. Only the second half is a decision about values, and
 * it is the half that can be wrong in a way nobody notices — so it lives here,
 * where a keeper can reach every branch from a hand-built array instead of from
 * two applications and a library with two exports in it.
 *
 * Nothing in this file imports anything. That is the point.
 *
 * ── THE RULE, WHICH IS OWEN'S IDENTITY LAW ──────────────────────────────────
 *
 * A press that NAMES A FILE names the answer. Since foundry e8396b4, an export
 * row's press — and the rail's TTS button — sends `export:<project-relative
 * file>` instead of a ledger step id (`exportNodeId` in their
 * shared/host-ops.ts; `export:` is a reserved prefix on the socket). The user
 * pressed the button ON that document, so second-guessing it with a uniqueness
 * rule would refuse a press that carried no ambiguity at all.
 *
 * A STEP-SHAPED id names no file, so it is answered by the step's own exports
 * and then by uniqueness among them: two files under two names mean the press
 * did not say which, and choosing one on any other ground would be this side
 * inventing a preference the press did not express.
 *
 * ── WHY THE ORDER OF THE REFUSALS IS LOAD-BEARING ───────────────────────────
 *
 * Zero exports is answered BEFORE the named file is looked at. A project with
 * nothing exported cannot have been pressed on an export row in this library's
 * present state, so "the press named X and there is no X" would be a true
 * sentence that sends the user hunting for a missing file when what they
 * actually need is to export the book once. The export-first sentence is the
 * useful one, and it wins.
 *
 * ── AND SINCE OWEN'S SECOND RULING, A STEP CAN MAKE ITS OWN FILE ────────────
 *
 * *"i dont think its intuitive to know you have to create an epub before you can
 * narrate. i think we should make any of the steps possible to narrate. if they
 * arent doing it from an epub then we export the epub automatically and then run
 * the task they assigned."*
 *
 * That does not change the law above; it adds a THIRD answer beside "this
 * variant" and "no", and `resolveNarrationTarget` is where the three meet. A
 * press on a ledger step asks which exports were CAST FROM THAT STEP
 * (`FoundryVariantSource.stepId`), and none is no longer a refusal — it is the
 * signal to go and make one. Which is why the decision stopped being a string:
 * "make the file first" is an instruction and cannot be spelled as a variant id.
 *
 * The uniqueness rule survives inside that answer rather than beside it. One
 * step CAN be behind two filed exports — a re-export under a name the book's
 * metadata changed, most plainly — and choosing between them is the very
 * question `chooseNarrationExport` already answers, asked of the exports from
 * that step instead of of all of them. So a step press with two files behind it
 * refuses in the same words a nameless press always did, and nothing about
 * "which of these did you mean" is written twice.
 */

/** One exported EPUB, reduced to what the choice actually needs. */
export interface NarrationExport {
  /** The manifest variant id — what the caller turns back into a path. */
  readonly id: string;
  /**
   * `FoundryVariantSource.fileName`: the basename the landing was filed under,
   * which is what an `export:` id's project-relative path is matched against.
   */
  readonly fileName: string;
  /**
   * THE LEDGER STEP THIS EXPORT WAS CAST FROM, when the landing that filed it
   * said so — `FoundryVariantSource.stepId`.
   *
   * ABSENT MEANS "I DO NOT KNOW", never "no step", and the two would be the same
   * value if this were spelled as an empty string. Every export filed before
   * Foundry began announcing the step has none, and every export a sweep found
   * sitting in a tray has none either, because a sweep reads files rather than
   * announcements. Absent can therefore never equal a pressed step id, which is
   * exactly the behaviour those records should have: they cannot answer the
   * question, so they do not.
   */
  readonly stepId?: string;
}

/**
 * WHAT A NARRATION SHOULD READ — either a file this library already holds, or
 * the instruction to go and make one.
 *
 * A UNION AND NOT A NULLABLE STRING, because "make it first" is not a missing
 * answer. A caller that had to read absence as an instruction would be a caller
 * that cannot tell "no file, go and export step X" from "this decision failed",
 * and those two want opposite things done about them.
 */
export type NarrationTarget =
  /** This variant, already filed. `variantId` is the manifest's own id. */
  | { readonly kind: 'variant'; readonly variantId: string }
  /**
   * NOTHING THIS PROJECT HAS FILED CAME FROM THAT STEP, so the file has to be
   * made from it before anything can read it. `stepId` is the pressed id
   * verbatim — the caller hands it straight back to Foundry, which proves it
   * against its own ledger and refuses by name for a step that is not there.
   */
  | { readonly kind: 'export-from-step'; readonly stepId: string };

/**
 * The project-relative file an `export:`-shaped node id names, or null.
 *
 * Our own minted ids (`bf-node:job:step`) cannot collide with the prefix, and
 * engine step ids carry no colon at all. A bare `export:` with nothing after it
 * names no file, so it is treated as step-shaped rather than as a file called
 * the empty string.
 */
export function exportFileOfNodeId(nodeId: string): string | null {
  if (!nodeId.startsWith('export:')) return null;
  const file = nodeId.slice('export:'.length);
  return file === '' ? null : file;
}

/**
 * WHICH OF THESE FILES THE PRESS MEANT — the half of the decision whose answer
 * must be one of the exports it was handed.
 *
 * Reached through `resolveNarrationTarget`, which is the door, and reached twice
 * for two different lists: ALL of a project's exports when the press named a
 * file, and only the exports cast from one step when it named a step. That is
 * what lets the identity law, the missing-name refusal and the "you have not
 * said which" refusal be written once and asked of both.
 *
 * `projectId` appears only in the refusals — it is the folder name the user
 * would go looking at — and never in the choosing.
 */
export function chooseNarrationExport(
  nodeId: string,
  exported: readonly NarrationExport[],
  projectId: string,
): string {
  if (exported.length === 0) {
    /*
     * NOTHING TO CHOOSE FROM, and this function does not make files. Auto-export
     * is a real answer since Owen's ruling, but it belongs to a press that named
     * a STEP — a step is a point in the book's history and there is a definite
     * file to cast from it. A press that named a FILE this library does not hold
     * has named something exporting cannot produce, so the honest answer is still
     * the sentence, and `resolveNarrationTarget` is where the two are told apart.
     */
    throw new Error(
      `${projectId} has no exported EPUB from this project, and narration reads a book file. `
      + 'Export the book from Foundry first (it lands on the version list as a version), then '
      + 'press Narrate again.');
  }

  /*
   * THE PRESS NAMED A FILE — resolve that file and no other. The id carries the
   * catalogue's project-relative path; `fileName` records the basename every
   * landing was filed under, so the basename is the join.
   */
  const named = exportFileOfNodeId(nodeId);
  if (named !== null) {
    const base = named.split('/').pop()!;
    const variant = exported.find((v) => v.fileName === base);
    if (variant === undefined) {
      throw new Error(
        `The press named "${named}", but ${projectId}'s version list has no exported EPUB filed `
        + `under that name — it has ${exported.map((v) => v.fileName).join(', ')}. `
        + 'Export the book from Foundry again, then press Narrate on the new row.');
    }
    return variant.id;
  }

  if (exported.length > 1) {
    throw new Error(
      `This Foundry project has exported ${exported.length} EPUBs — `
      + `${exported.map((v) => v.fileName).join(', ')} — and this press does not `
      + 'say which one it is. Press Narrate on the export row itself, or start the narration '
      + `from the version you want on ${projectId}'s versions page.`);
  }

  return exported[0]!.id;
}

/**
 * THE WHOLE ANSWER TO "WHAT DOES THIS PRESS WANT NARRATED" — the door.
 *
 * ── The two currencies, and why one function answers both ───────────────────
 *
 * Narrate is declared on `['book', 'export']` now, so the id that arrives is
 * either an export row's `export:<file>` or a ledger step's bare uuid, and which
 * it is decides the whole shape of the answer rather than a detail inside it. A
 * caller that branched on the id shape itself and then asked two different
 * questions would be a caller where the export path and the step path could come
 * to disagree about what a filed export is — which is the drift the pure module
 * exists to make untestable.
 *
 * ── A NAMED PRESS IS UNCHANGED IN EVERY RESPECT ─────────────────────────────
 *
 * It goes to `chooseNarrationExport` whole: the identity law, the zero-exports
 * refusal that wins over it, the basename join. An export row press behaves
 * exactly as it did before any of this, which is the compatibility promise the
 * widening is only safe under.
 *
 * ── A STEP PRESS ASKS ITS OWN QUESTION, AND NEVER THE OTHER ONE ─────────────
 *
 * Which exports were cast FROM THIS STEP — nothing else. It deliberately does
 * NOT fall through to "well, there is only one export, they must have meant
 * that": an export sitting in the tray may have been made from a completely
 * different point in the book's history, and narrating it because it was the
 * only one there would hand back an audiobook of words the user was not standing
 * on. Making the file is cheap (an export is arithmetic over a bank already on
 * disk, seconds, no model) and it is CORRECT, so the honest answer to "none of
 * these came from here" is to go and make the one that did.
 *
 * That is also why an old record — one filed before the step was announced, or
 * found by the sweep — reads as a miss rather than as a match. It cannot say
 * which step it came from, and treating "unknown" as "yours" is the substitution
 * this codebase refuses everywhere else. The cost is one re-export, after which
 * the record knows its own step and the next press resolves instantly.
 */
/**
 * ONE LEDGER STEP, reduced to what the translation check needs.
 *
 * Read out of Foundry's own catalogue (`project.json`, `ledger.steps`) by the
 * caller — this module still imports nothing. `language` is the translate
 * step's `params.language`: the language translated INTO, which is the word the
 * refusal needs to say.
 */
export interface LedgerStepLite {
  readonly id: string;
  readonly parent: string | null;
  readonly action: string;
  readonly label?: string;
  readonly language?: string;
}

/** What `stepPressTranslationCheck` decided, for the caller that says it. */
export type StepPressTranslationCheck =
  /** The pressed chain holds every translation the book has (or it has none). */
  | { readonly kind: 'ok' }
  /**
   * The press names a step this ledger does not hold. NOT judged here: Foundry's
   * own `stepOf` refuses an unknown id by name, and that sentence — from the side
   * that owns the ledger — beats one this side would invent about it.
   */
  | { readonly kind: 'unknown-step' }
  /**
   * The book HAS translations and the pressed step's chain contains none of
   * them, so an export cast from this press would be in the untranslated
   * language. `languages` is what the book was translated into; `pressedLabel`
   * is the pressed step's own name, for the sentence.
   */
  | {
      readonly kind: 'leaves-out-translations';
      readonly languages: readonly string[];
      readonly pressedLabel: string;
    };

/**
 * WOULD AN EXPORT FROM THIS STEP SKIP THE BOOK'S TRANSLATIONS — the guard on the
 * auto-export arm, from the 2026-08-24 incident.
 *
 * A narrate press resolved to the German READ step of a book whose English
 * translation — and the English EPUB cast from it — sat right there; the
 * auto-export arm obeyed the press and cast the German, and the queue narrated
 * it for hours of wrong GPU. The press was wrong (a position parked upstream,
 * fixed on Foundry's side), but this side obeyed it SILENTLY, and a cast whose
 * language differs from the book's translations is a thing to say out loud
 * before spending a render on it.
 *
 * The rule: Foundry's `exportEpubFromStep` replays the ledger up to and
 * including the pressed step, so a translation rides exactly when it is the
 * pressed step or one of its ancestors. A translate step ELSEWHERE in the
 * ledger means the book has a translated line this press does not reach — and
 * pressing Narrate upstream of it is almost always the parked-position
 * accident, not a request for the untranslated text. The deliberate case has a
 * door the refusal names: export from that step in Foundry, then press Narrate
 * on the export row, which the identity law answers without ever reaching this
 * check.
 *
 * A book with NO translate steps answers ok however the press falls: there is
 * only one language, and this check has nothing to protect.
 */
export function stepPressTranslationCheck(
  pressedId: string,
  steps: readonly LedgerStepLite[],
): StepPressTranslationCheck {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const pressed = byId.get(pressedId);
  if (pressed === undefined) return { kind: 'unknown-step' };

  const chain = new Set<string>();
  for (let cur: LedgerStepLite | undefined = pressed; cur !== undefined && !chain.has(cur.id);
    cur = cur.parent === null ? undefined : byId.get(cur.parent)) {
    chain.add(cur.id);
  }

  /*
   * A chain that holds ANY translation is ok as pressed — the ledger is a tree,
   * and a sibling branch's translation (an abandoned second language, say) is
   * not something this press left out; the press stands on a translated line.
   * Only a chain with NONE, in a ledger with SOME, is the parked-upstream shape.
   */
  if (steps.some((s) => s.action === 'translate' && chain.has(s.id))) return { kind: 'ok' };
  const leftOut = steps.filter((s) => s.action === 'translate');
  if (leftOut.length === 0) return { kind: 'ok' };
  /*
   * The languages, deduplicated in ledger order, absent ones dropped: a
   * translate step that did not record one has nothing sayable, and the check
   * still refuses — it is the STEP being left out that matters, not our ability
   * to name its language.
   */
  const languages = [...new Set(
    leftOut.map((s) => s.language).filter((l): l is string => l !== undefined))];
  return {
    kind: 'leaves-out-translations',
    languages,
    pressedLabel: pressed.label ?? pressed.action,
  };
}

export function resolveNarrationTarget(
  nodeId: string,
  exported: readonly NarrationExport[],
  projectId: string,
): NarrationTarget {
  if (exportFileOfNodeId(nodeId) !== null) {
    return { kind: 'variant', variantId: chooseNarrationExport(nodeId, exported, projectId) };
  }

  const fromStep = exported.filter((v) => v.stepId === nodeId);
  if (fromStep.length === 0) {
    return { kind: 'export-from-step', stepId: nodeId };
  }
  /*
   * ONE STEP, MORE THAN ONE FILE is rare and it is real: a re-export under a
   * name the book's metadata changed leaves two rows whose provenance is the
   * same step. Which of them the press meant is precisely the question a
   * nameless press has always asked, so it is asked of these — the same words,
   * the same refusal, one implementation.
   */
  return { kind: 'variant', variantId: chooseNarrationExport(nodeId, fromStep, projectId) };
}
