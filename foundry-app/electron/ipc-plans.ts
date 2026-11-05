/**
 * ipc-plans — working out what a job would do before it is queued.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { readAnalysisReport } from '@owen/foundry-core/node/projects';
import { planExportFrom, planTranslationFor, planSimplificationFor, hostPassOfferFor, planCleanupFor, planAnalysisFor } from '@owen/foundry-core/node/doors-plan';
import { planReading } from '@owen/foundry-core/node/workspace';
import type { ReadAsk } from '@owen/foundry-core/shared/ledger';
import type { ConversionKind, RewriteMode } from '@owen/foundry-core/shared/types';

export function registerPlanDoors(): void {
  // ── Projects ─────────────────────────────────────────────────────────────
  /*
   * TWO PLANS, because there are two jobs. `plan-reading` names the bank an OCR
   * run will fill and nothing else; `plan` names the file a rendering will write
   * and rotates the one it replaces. Splitting them is what stops an OCR job
   * having to invent a format in order to be planned.
   */
  /*
   * The ASK reaches the reading plan, because which bank this run fills depends
   * on whether it is the same question a reading of this book already answered.
   * A renderer that sent nothing asks the plain question — the whole book, no
   * language declared — which is the same default `recordReading` takes, so an
   * old renderer against a new main is consistent rather than merely tolerated.
   */
  ipcMain.handle('workspace:plan-reading', (_event, inputPath: string, asked?: ReadAsk) =>
    planReading(inputPath, asked ?? {}));
  /*
   * THREE PLANS NOW, and the third one is the same rendering with a different
   * destination. An export is a Generate that lands in the project's tray rather
   * than in the layer this app treats as an origin — nothing is ever made from it,
   * so it gets no chain, no working tree and no step (docs/WORKBENCH.md §3). The
   * split is at the plan rather than at the enqueue because `final/` and
   * `generated/` are refused on different grounds: only the second one can have a
   * book unpacked out of it and being read in a tab. See `planExport`.
   *
   * NO ALLOW-LIST CHECK, exactly as `workspace:plan` has none, and the reason is
   * the same: the rendering plans do not read the path they are
   * given. They resolve which PROJECT it belongs to and then compose every path
   * they return out of the project's own catalogue — the pixels come from
   * `archive/`, the bank from the position's read step — so a renderer naming a
   * file it never opened gets a plan about somebody's project or an error, and no
   * bytes. The translation plan is the one that checks, because it is the one that
   * reads the input to export a working copy of it.
   */
  /*
   * ── AND THE THIRD ARGUMENT, WHICH IS OWEN'S PENDING-NODE RULING ARRIVING ───
   *
   * *"i click the grayed out row and hit the export epub tile."* The dialog aims at
   * the POSITION unless the tree pressed from a card that is not it — a landed row
   * further up, or a promise that has not landed at all — and `from` is how it says
   * which. `aimedAt` resolves the three cases once for all four plan doors and
   * refuses an id that is neither, by name.
   *
   * THE CHANNEL IS WIDENED RATHER THAN REPLACED, which is the standing rule for
   * this seam: docs/IPC-CHANNELS.md is BookForge's collision audit, and a new name
   * is a name to audit plus an old one to prove retired — paid for a door whose
   * behaviour is unchanged for every caller that does not pass the argument. A
   * renderer built against the older preload sends two arguments and gets exactly
   * what it always got.
   */
  ipcMain.handle(
    'workspace:plan-export',
    (_event, inputPath: string, kind: ConversionKind, from?: string) => planExportFrom(inputPath, kind, from),
  );
  /*
   * A translation is asked ABOUT a file the renderer already has open, so the
   * path is checked against the SAME allow-list every other read is. Without it
   * this handler would resolve — and then plan against — any path a compromised
   * renderer named.
   *
   * ── `exportWorkingCopy` USED TO RUN FIRST, AND ITS REASON IS GONE ──────────
   *
   * It repacked the open book's working tree into `working/` and handed the job
   * THAT, because the engine is a separate process given a path and a book edited
   * since it was cast would otherwise have been translated as it was before the
   * edits. The run does not read an EPUB any more: `planTranslation` materialises
   * the position's own book file — every applied change replayed into it — and
   * that is what the engine is handed (`TranslateRequest.bookPath`). So the
   * repack bought nothing, and the refusal inside it ("that is not the book
   * Foundry has open in that project") had become a refusal about a file nothing
   * in the run would ever open. A guard whose premise has been removed is not a
   * safety margin; it is a stop sign in a field.
   *
   * The path that comes back is the one admitted here, so the queue's re-check of
   * `inputPath` against the same allow-list finds exactly what this admitted.
   */
  ipcMain.handle(
    'workspace:plan-translation',
    (_event, inputPath: string, targetLanguage: string, from?: string) =>
      planTranslationFor(inputPath, targetLanguage, from),
  );

  /*
   * A SIMPLIFY IS A TRANSLATION AND IS ADMITTED THE SAME WAY. It is the same
   * plan, about the same open document, reading the same input to materialise the
   * same book — so the allow-list check above is not a pattern being copied here,
   * it is the same check about the same act. The mode is the only thing this door
   * carries that the other does not, and it is not a path: `planSimplification`
   * takes it as one of three values and the engine refuses anything else.
   */
  ipcMain.handle(
    'workspace:plan-simplify',
    (_event, inputPath: string, mode: RewriteMode, from?: string) => planSimplificationFor(inputPath, mode, from),
  );

  /*
   * A CLEANUP IS ADMITTED THE SAME WAY, AND IT ASKS NOTHING AT ALL.
   *
   * It is the same plan about the same open document, materialising the same book
   * — so the allow-list check is not a pattern being copied here, it is the same
   * check about the same act. What it carries that the two above do not is a
   * STAMP path in the answer; what it does not carry is a question: a cleanup has
   * no language to go into and no mode to be asked in, so this door takes the
   * document and nothing else.
   *
   * IT IS NOT REFUSED HOSTED, WHICH IS `queue:enqueue-analysis`' OPPOSITE. That
   * one refuses because the host's queue has never heard of an analysis; this act
   * exists ONLY on the host's behalf (Owen, 2026-09-05: *"cleanup will only ever
   * be done on behalf of bookforge and wont be available in foundry"*), so the
   * gate is the other way round — the tile is drawn only in a hosted window
   * (`@if (hosted())`, action-menu.component.ts), and this door serves it. It is
   * not gated on `hosted()` in main because main's own gate would be a second
   * copy of a rule the renderer already enforces, and because a host act that
   * reached this from the mount seam would meet a refusal about a window rather
   * than about a book.
   */
  /*
   * THE HOST'S SECTION ON THE CLEAN TEXT CARD (`HostPassOffer`, shared/host-ops.ts).
   *
   * The step is resolved EXACTLY as `workspace:plan-clean` below resolves it — the
   * row the card is aimed at, a promise it waits on, or the position — but NOTHING
   * is planned, minted or written: this is asked every time the card opens, and a
   * card closed unpressed must leave no trace. Standalone, and for a host with no
   * `passOffer`, it is null before anything is read.
   */
  ipcMain.handle('host-ops:pass-offer', (_event, inputPath: string, from?: string) =>
    hostPassOfferFor(inputPath, from));

  ipcMain.handle('workspace:plan-clean', (_event, inputPath: string, from?: string) =>
    planCleanupFor(inputPath, from));

  /*
   * AN ANALYSIS IS ADMITTED THE SAME WAY A TRANSLATION IS, and for the identical
   * reason: it is asked ABOUT a file the renderer already has open, and the plan
   * materialises that position's book to hand to the engine. Without the check
   * this handler would resolve — and then plan against — any path a compromised
   * renderer named.
   *
   * THE CATEGORIES ARE NOT PATHS AND ARE STILL NOT TAKEN ON TRUST. Every name is
   * checked against the CLOSED SET this app can name — the engine's built-ins
   * (`ANALYSIS_CATEGORY_IDS`) plus the ids of the categories this user has
   * written down (`app-settings.json`) — before it reaches the ledger. A request
   * naming something outside that set is refused by name rather than quietly
   * dropped, because a silently narrowed checklist is a report that is missing a
   * category nobody can see was missing.
   *
   * ── THE SET IS WIDER THAN IT WAS, AND IT IS STILL CLOSED ──────────────────
   *
   * Owen's *"maybe the user can add more categories"* means free text now DOES
   * become a category name, so the sentence this comment used to carry — no free
   * text ever reaches a model's question — needed a new true form rather than a quiet
   * deletion. It is this: free text becomes a category ONLY by being written
   * into the user's own settings file through the door below, where it is
   * slugged into `customCategoryId`'s shape, length-capped and collision-checked
   * (`clampAnalysisCategories`); and this handler admits a name only if that file
   * already holds it. So the path from a text box to a prompt runs through a
   * deliberate act of saving, and the string that arrives here is always one main
   * itself minted.
   */
  ipcMain.handle('workspace:plan-analysis', (_event, inputPath: string, categories: string[]) =>
    planAnalysisFor(inputPath, categories));

  /**
   * ONE ANALYSIS STEP'S REPORT, for the panel that draws it.
   *
   * THE RENDERER STAYS FILE-FREE, which is this whole family's rule: it names a
   * project directory and a step id, main proves the directory is one of Home's
   * before it opens anything, and what comes back is the header, the findings and
   * one sentence about staleness. The cache rows — one per sentence in the book —
   * never cross (`readAnalysisReport`, electron/projects.ts).
   *
   * A REFUSAL IS A SENTENCE INSIDE THE ANSWER RATHER THAN A REJECTION, on
   * `BookOutcome`'s rule: "that step was deleted" and "the report is not on the
   * disk" are ordinary states a person should meet as a line on a panel, not as a
   * console error and an empty column. The one thing that still rejects is the
   * directory gate, which refuses before a byte is read.
   */
  ipcMain.handle('workspace:read-analysis', (_event, projectDir: string, stepId: string) =>
    readAnalysisReport(projectDir, stepId));
}
