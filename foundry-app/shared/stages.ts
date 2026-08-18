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
 * Every function below takes the project summary and the step being asked about,
 * and reads nothing else. No injection, no signals, no disk: a possibility is a
 * fact about a catalogue row and a ledger row, so it is computable wherever both
 * are in hand — the dock (which asks about the standing step), the tree (which
 * asks about the row under the pointer), and the dialogs (which ask about the
 * position they are aimed at). That is the only shape in which one function can
 * serve all three.
 *
 * ── THE STEP ARGUMENT IS "AS IF STANDING THERE" ─────────────────────────────
 *
 * The dock passes the step the book is actually standing on. The tree passes THE
 * ROW ITSELF, because pressing an act in the tree stands on that row first and
 * then opens the dialog (`run`, open-documents) — so the honest question for a
 * row is "would this be possible if I were standing here", which is the same
 * question with a different step in it.
 */
import { bookRow } from './original';
import type { LedgerStep, ProjectSummary } from './types';

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
 * IS THERE A BOOK AT THIS STAGE — the fact three of Foundry's four acts turn on.
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
