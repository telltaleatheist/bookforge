/**
 * shared/stages — WHAT IS POSSIBLE FROM A STAGE, asked once and answered once.
 *
 * ── The ruling this module exists to keep ───────────────────────────────────
 *
 * Owen, after using the tree on a project with no export (2026-08-17 20:30, via
 * the bridge):
 *
 *   *"just put 'export EPUB' as the only option on things that aren't capable of
 *   narration or whatever. The only options that exist are the ones that are
 *   possible for that stage."*
 *
 * A BUTTON WHOSE ONLY POSSIBLE OUTCOME IS A REFUSAL IS NOT DRAWN. That is the
 * whole rule, and this file is where it becomes enforceable rather than
 * repeated: every act this app offers has exactly one predicate saying whether
 * it is possible from a given stage, and both the OFFER and the ACT'S OWN
 * REFUSAL read it. Two copies of a test are two answers waiting to disagree, and
 * the way that disagreement presents is the failure the ruling is about — a
 * button that lights up and then explains why it will not work.
 *
 * ── Why the tests had to be collected before they could be gated ────────────
 *
 * They were already written, five times over, in five files: the dock's
 * `canExport` and `canTranslate` (identical bodies), `canSimplify` (delegating
 * to one of them), and the `source()` computeds inside the translate and
 * simplify dialogs (the same body a third and fourth time, spelling the refusal
 * rather than the enablement). Every one of them was correct; none of them could
 * be reached from the tree, which is why the tree offered Translate on stages
 * that could only refuse it. Hoisting them here is what let the tree ask the
 * same question the dialog would answer.
 *
 * ── PURE, AND OVER RECORDS RATHER THAN OVER SERVICES ────────────────────────
 *
 * Every function below takes records — the project summary, the step being asked
 * about, and in one case the ledger those steps came out of — and reads nothing
 * else. No injection, no signals, no disk: a possibility is a fact about a
 * catalogue row and a ledger row, so it is computable wherever both are in hand —
 * the dock (which asks about the standing step), the tree (which asks about the
 * row under the pointer), and the dialogs (which ask about the position they are
 * aimed at). That is the only shape in which one function can serve all three.
 *
 * THE ONE FUNCTION THAT TAKES THE WHOLE LEDGER is `hostActPositionFrom`, and it
 * is not a possibility at all — it is what a press SENDS once a possibility has
 * said yes. It sits here because it is the direct consequence of the refusal
 * `canRunHostActFrom` drops, and a reader who has just been told the import row
 * may order a host act must find, in the next paragraph, what such a press names.
 *
 * ── THE STEP ARGUMENT IS "AS IF STANDING THERE" ─────────────────────────────
 *
 * The dock passes the step the book is actually standing on. The tree passes THE
 * ROW ITSELF, because pressing an act in the tree stands on that row first and
 * then opens the dialog (`run`, open-documents) — so the honest question for a
 * row is "would this be possible if I were standing here", which is the same
 * question with a different step in it.
 */
import { importedAsEpub } from './ledger';
import { bookRow } from './original';
import type { LedgerStep, ProjectLedger, ProjectSummary } from './types';

/**
 * DID THIS BOOK ARRIVE AS A BOOK — an EPUB rather than a scan?
 *
 * Such a project has no bank and never will: a bank models pages and an EPUB has
 * none, so its book is exploded straight out of the container
 * (docs/RENDERER.md §6). Everything below has a second case for it, because the
 * rules that begin "there is nothing until the pages are read" are true of a scan
 * and false of a book that was already finished when it arrived.
 *
 * THE ONE IMPLEMENTATION, and `ProjectsService.arrivedAsBook` now delegates here.
 * It was a method on that service and had to become a function the moment the
 * tree, the dock and the dialogs all needed to ask the same question of the same
 * record — the alternative was every caller injecting a service to answer a
 * question about an object it was already holding.
 */
export function arrivedAsBook(project: ProjectSummary | null): boolean {
  if (project === null || project.problem !== null) return false;
  return bookRow(project.documents)?.kind === 'epub' && !project.reading.done;
}

/**
 * IS THERE A BOOK AT THIS STAGE — the fact THIS APP'S OWN acts turn on.
 *
 * ── Two conditions, and the second is the one people forget ─────────────────
 *
 * THE PAGES HAVE BEEN READ (or the book arrived as one). Everything this app
 * makes is arithmetic over that bank; before it lands there is nothing for a
 * translation to translate or an export to export.
 *
 * AND THE STAGE IS NOT THE IMPORT. Standing on the import is standing BEFORE the
 * reading — the user has deliberately stepped back to the untouched scan — and an
 * act from there would quietly work on the book they had just stepped away from
 * (docs/WORKBENCH.md §6c: *"Translate on … the import row = disabled. Same rule
 * for Export and Metadata"*).
 *
 * THAT SECOND CONDITION IS ABOUT DERIVATION, WHICH IS WHY IT IS NOT UNIVERSAL.
 * Every act named in §6c makes A NEW THING OUT OF THE POSITION, and the mistake
 * being prevented is a real one: a translation of the untouched scan, made
 * because somebody clicked the top row to look at their PDF and then pressed
 * Translate. An act that does not derive from the position has no such mistake
 * to make, and the host's do not — `canRunHostActFrom` drops this clause and
 * argues why where it drops it. Nothing else does, and a new act reaching for a
 * predicate should take this one unless it can say the same sentence.
 *
 * EXCEPT WHERE THE IMPORT ROW IS THE BOOK. That second refusal is about stepping
 * back PAST a reading, and a project that arrived as a book has no such step to
 * step past: its ledger holds the import and nothing else, and that row is the
 * only position such a project can ever occupy. Applying the sentence to both
 * would shut the door on the whole project.
 *
 * A STEP THIS WINDOW HAS NOT READ YET ANSWERS TRUE, and that is deliberate rather
 * than lax: `standing` is null while a project's history is still in flight, and
 * treating that silence as "the import" would grey every act on a book for the
 * first moment it is on screen. Main's own refusal is the backstop — this rail's
 * standing preference for a door that opens onto an explanation over one shut on
 * a guess.
 */
export function hasBookAt(project: ProjectSummary | null, standing: LedgerStep | null): boolean {
  if (project === null) return false;
  const arrived = arrivedAsBook(project);
  if (!project.reading.done && !arrived) return false;
  return arrived || standing?.action !== 'import';
}

/**
 * CAN THE PAGES BE READ FROM HERE — the one act an unread scan CAN offer.
 *
 * ── It is the answer to "what can this stage do instead" ────────────────────
 *
 * The ruling has two halves and this is the second one: a stage that cannot be
 * translated or exported is not a stage with nothing to offer, it is a stage
 * whose one possible act is the one everything else is waiting on. A pdf import
 * with no reading offers Read and nothing else, which is exactly what the dock
 * has always said about the same project by lighting the OCR button.
 *
 * `reading.needed` IS MAIN'S OWN ANSWER, derived once when the library was
 * listed: *"true when this book HAS pages to read and nobody has read them"*. It
 * is false for a project that arrived as an EPUB (no pages to read) and false
 * once a bank lands, so this is the whole test and there is no second case.
 *
 * THE STEP IS NOT ASKED. Reading is a fact about the PROJECT rather than about a
 * position — the bank is made from the archived original whatever row somebody is
 * standing on — which is why this is the one predicate here with no `standing`
 * parameter, and why the dock's own OCR light never consulted the ledger either.
 */
export function canReadPages(project: ProjectSummary | null): boolean {
  return project !== null && project.reading.needed;
}

/**
 * CAN A TRANSLATION BE MADE FROM HERE.
 *
 * `hasBookAt`, and a loose file answers FALSE: what this app translates is a
 * position read off a ledger, and a file with no project behind it has none. The
 * translate dialog's own `source()` refuses on exactly this, which is the point
 * of the function existing — the button and the refusal are one test.
 */
export function canTranslateFrom(
  project: ProjectSummary | null,
  standing: LedgerStep | null,
): boolean {
  return hasBookAt(project, standing);
}

/**
 * CAN A SIMPLIFY BE MADE FROM HERE.
 *
 * The same question as Translate, asked by name rather than by delegation. A
 * simplify IS a translate step carrying a mode, so the two have never differed —
 * but they are two acts on two buttons in two dialogs, and a shared name that
 * says which act it is about is what lets one of them grow a condition later
 * without the other silently inheriting it.
 */
export function canSimplifyFrom(
  project: ProjectSummary | null,
  standing: LedgerStep | null,
): boolean {
  return hasBookAt(project, standing);
}

/**
 * CAN A FINISHED COPY BE EXPORTED FROM HERE.
 *
 * `hasBookAt`, with ONE DIFFERENCE from Translate that is documented rather than
 * accidental: a document with NO PROJECT gets the benefit of the doubt. The dock
 * has always kept this door open for a loose PDF somebody dropped on the window
 * — main's own refusal is the backstop, and an export is the one act whose
 * subject can be a file rather than a position.
 */
export function canExportFrom(
  project: ProjectSummary | null,
  standing: LedgerStep | null,
): boolean {
  if (project === null) return true;
  return hasBookAt(project, standing);
}

/**
 * CAN THE HOST'S OWN ACTS BE RUN FROM HERE.
 *
 * ── The ruling that moved this off the export tray ──────────────────────────
 *
 * It used to be `hasEpubExport` — zero finished EPUBs was the grayed state, on
 * the reasoning that what a host act consumes is a FILE and a project with no
 * file has nothing to offer one. Owen overturned the premise rather than the
 * gray: *"i dont think its intuitive to know you have to create an epub before
 * you can narrate. i think we should make any of the steps possible to narrate.
 * if they arent doing it from an epub then we export the epub automatically and
 * then run the task they assigned."*
 *
 * So the question is no longer "is there a file" but "COULD THERE BE ONE" — the
 * export is what would be made, so a stage an export could be made from is a
 * stage a host act can run from.
 *
 * ── And the ruling that took the import row back out of the gray ────────────
 *
 * Owen, using the hosted window (2026-08-18, over the switchboard): *"the
 * narrate button in the bottom left of the foundry window is disappearing and
 * disabling seemingly at random. it should be available pretty much anywhere the
 * user clicks."* Clicking the top row of a book is an ordinary thing to do —
 * it is where you go to look at the scan you imported — and from the chair, a
 * button that greys when you click there and lights when you click one row down
 * is not a rule, it is randomness.
 *
 * SO THIS IS `hasBookAt` MINUS EXACTLY ONE CLAUSE, and the one it drops is the
 * import refusal. What is left is that predicate's first condition, asked in the
 * same words and answering the same way: the pages have been read, or the book
 * arrived as one. An unread scan is still no, a document with no project behind
 * it is still no, and a book whose history this window is still loading is still
 * yes — there is no position left in the question for that silence to be
 * mistaken for the import.
 *
 * THE CLAUSE GOES BECAUSE A HOST ACT DOES NOT DERIVE FROM THE POSITION. §6c's
 * refusal is about acts that make a NEW THING out of where you are standing, and
 * stepping back past a reading to translate the untouched scan is a mistake
 * worth preventing. A host act makes nothing here: its position names
 * PROVENANCE — which row the work is recorded as coming from, echoed straight
 * back into the tree — and names WHAT TO EXPORT for it to consume. Neither of
 * those is ambiguous at the import row, because THE IMPORT ROW'S BOOK IS THE
 * READING'S BOOK: a project has one book, the import is the row above it, and
 * there is nothing else a narrate ordered from there could mean.
 *
 * FOUNDRY'S OWN ACTS KEEP THE CLAUSE — `canTranslateFrom`, `canSimplifyFrom`,
 * `canExportFrom` and the metadata gate are untouched by this, and `hasBookAt`
 * itself is untouched, which is what makes that sentence checkable rather than a
 * promise.
 *
 * AN UNREAD SCAN IS STILL GREY, and deliberately: no reading means no bank,
 * which means no book, which means there is nothing for `exportEpubFromStep` to
 * mint the file this act would consume. That is not the ruling failing to reach
 * a case — it is the ruling's other half working, because Read is the act
 * already offered there and it is the one everything else is waiting on
 * (`canReadPages`).
 *
 * ── Why it is a named act rather than a call to `hasBookAt` ─────────────────
 *
 * `canSimplifyFrom`'s reason, said about somebody else's operations: the surfaces
 * that gate the host's acts and the surface that refuses one must read ONE
 * function, and that function has to be named for the act so that the day a host
 * act grows a condition an export does not have, there is a body to put it in
 * rather than a shared predicate to fork. That day has arrived, which is this
 * body — the delegation was never the point, the shared answer was.
 *
 * NO STEP IS ASKED ANY MORE, on `canReadPages`'s precedent exactly. Once the one
 * clause that read the position is gone, what is left is a fact about the
 * PROJECT — does this book have a book — and a parameter kept for the shape of
 * the family would be a parameter every caller has to compute and no reader can
 * trust. What the position decides is what the press SENDS, which is the
 * function below.
 *
 * IT IS THE PROJECT'S SIDE OF THE ANSWER AND NOT THE WHOLE OF IT. Whether the
 * host can actually do the work — a voice it has, a queue that will take it — is
 * the host's own to refuse at invoke, exactly as every predicate here stops at
 * what a catalogue row can say and leaves the dialogs their own sentences.
 */
export function canRunHostActFrom(project: ProjectSummary | null): boolean {
  if (project === null) return false;
  return project.reading.done || arrivedAsBook(project);
}

/**
 * THE POSITION A HOST ACT ORDERED FROM THIS ROW SHOULD NAME — the other half of
 * the ruling above, and the half a press reads.
 *
 * ── Why the gray and the id are two different questions ─────────────────────
 *
 * The gray asks whether the act is POSSIBLE from here and now answers yes at the
 * import row. The press asks what to put in the invoke's `nodeId`, and there the
 * import is the one answer that cannot be sent: the host takes that id back to
 * `exportEpubFromStep` (electron/mount.ts) to make the file its work consumes,
 * and that path is `canExportFrom` — which still refuses the import, because an
 * export DOES derive from the position. Sending the import would hand somebody
 * else's queue a node whose own export path declines it, which is a refusal
 * arriving in another application's log instead of on the strip where the button
 * was pressed.
 *
 * SO AN IMPORT NAMES THE READING AND EVERYTHING ELSE NAMES ITSELF. That is the
 * whole rule, and it is the same sentence the gray is argued on: the import
 * row's book is the reading's book, so a press there is an order about the
 * reading, said one row too high.
 *
 * ── THE LINEAGE CONSEQUENCE, which is worth stating out loud ────────────────
 *
 * The host echoes the invoke's `nodeId` into `HostNode.parentStepId` verbatim
 * (shared/host-ops.ts), so a narration ordered from the import row comes back
 * hanging under the READING in the tree, not under the row that was clicked.
 * That is honest — the work was made from the reading's book — and drawing it
 * under the import would be the fabrication: it would claim audio was made from
 * an untouched scan that has no words in it.
 *
 * ── The three answers, in the order they are asked ──────────────────────────
 *
 * NOT AN IMPORT: ITSELF. A reading, a save, a translation, an edit — every one
 * of them is a position an export can be made from, and the press has always
 * sent exactly this.
 *
 * AN IMPORT WITH A READING UNDER IT: THAT READING. A reading's parent is always
 * the import (`originOf`, shared/ledger.ts, argues why), so the readings are
 * precisely the import's `read` children and no walk is needed to find them. THE
 * NEWEST WINS where a book has been read twice into two branches — a re-run
 * replaces in place and only a genuinely different question (another page range)
 * branches, so this is rare, and the newest pass is the one whose bank the
 * project's book is. It is a choice rather than a deduction, and a person who
 * meant the other pass has a row of its own to press.
 *
 * AN IMPORT THAT IS ITSELF THE BOOK: ITSELF, and this is not a fallback. A
 * project that arrived as an EPUB has one step in its whole ledger and that row
 * IS the book (`arrivedAsBook`); there is no reading to name and none is
 * missing. `importedAsEpub` is the ledger's own way of saying so, asked here
 * because this function is given a ledger rather than a catalogue row.
 *
 * ── AND NULL IS A REFUSAL, NOT A FALLBACK TO THE IMPORT ─────────────────────
 *
 * A scan whose bank exists but whose ledger holds no `read` step is a real
 * state: `summarise` accepts the engine's own completion marker beside a bank as
 * evidence of a reading, so a bank filled by `foundry vlm-read` from a terminal
 * makes `reading.done` true with nothing in the history to name. The gray lets
 * the press through and this cannot answer it, so it says nothing and the caller
 * says a sentence. Sending the import instead would be handing the host an id
 * whose export declines — the exact failure this function exists to prevent —
 * and doing it silently.
 */
export function hostActPositionFrom(
  ledger: ProjectLedger | null,
  standing: LedgerStep | null,
): LedgerStep | null {
  if (ledger === null || standing === null) return null;
  if (standing.action !== 'import') return standing;
  let reading: LedgerStep | null = null;
  for (const step of ledger.steps) {
    if (step.action !== 'read' || step.parent !== standing.id) continue;
    if (reading === null || step.createdAt >= reading.createdAt) reading = step;
  }
  if (reading !== null) return reading;
  return importedAsEpub(ledger) ? standing : null;
}

/**
 * IS THERE A FINISHED EPUB IN THE TRAY ALREADY.
 *
 * ── What it stopped meaning, which is worth saying plainly ──────────────────
 *
 * It was the gate on the host's acts (*"if the step the user has selected cant
 * run tts then its grayed out"*, 2026-08-17 21:45) and it is not any more: an act
 * that can have its EPUB made for it is possible from a step that has none, so a
 * test about the tray was answering a question about capability with a fact about
 * history. `canRunHostActFrom` above is that gate now.
 *
 * WHAT IT STILL ANSWERS IS TRUE AND IS A DIFFERENT QUESTION: has this book been
 * exported yet — which is "does an act ordered here need one made for it first",
 * the decision a host takes on its own side of the seam before it asks Foundry to
 * export (`exportEpubFromStep`, electron/mount.ts). No surface in this app reads
 * it today; it is kept because the question is real and because the honest home
 * for it is beside the other stage predicates rather than inlined wherever it is
 * next needed.
 *
 * NO `standing` PARAMETER, on `canReadPages`'s reasoning: the tray of finished
 * files is a fact about the PROJECT, not about the row somebody is standing on.
 * `exports` lists only files still on disk, so a tray somebody tidied by hand
 * answers false rather than claiming a ghost.
 */
export function hasEpubExport(project: ProjectSummary | null): boolean {
  return (project?.exports ?? []).some((made) => made.kind === 'epub');
}
