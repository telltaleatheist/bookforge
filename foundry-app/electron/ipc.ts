/**
 * ipc — every door the renderer may knock on, in one place.
 *
 * Split out of main.ts when the app learned to be hosted (docs/BOOKFORGE-HANDOFF.md
 * §8): registering these is what MOUNTING Foundry means, and it is the same
 * registration whether this process belongs to Foundry or to BookForge. What
 * stayed behind in main.ts is only what a standalone shell owns — the menu, the
 * command line, the process's own lifecycle.
 *
 * EVERY CHANNEL IS NAMESPACED `family:verb`, and that is not a style rule: hosted,
 * these handlers are registered into a main process that has doors of its own, so
 * a bare name is a collision waiting for a version bump. docs/IPC-CHANNELS.md is
 * the enumeration, and it is the input to the audit the copy depends on.
 *
 * The renderer has no Node: it names a path and main decides whether that path is
 * a thing this app will open. `admitted` (electron/documents.ts) is where that is
 * decided, once, for every door that reads.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { TERMINAL_OUTCOME_STATES } from '@crucible/bootstrap';
import { startPairing, pollPairing, type Pairing } from '@crucible/client';
import { RemotePairingSessions } from './crucible-remote-pairing';

import { actGates } from './act-gates';
import {
  clampCrucibleUrl,
  sameCrucibleAddress,
  readAppSettings,
  writeAppSettings,
  type CrucibleServerEntry,
} from './app-settings';
import { probeCloud, writeCloudProviders } from './cloud-providers';
import { openCrucibleUi } from './crucible-ui';
import {
  coordinateEveryServer,
  prepareFoundryForUse,
  coordinateServer,
  coordinationStates,
  onCoordination,
} from './crucible-coordinate';
import {
  addCrucibleServer,
  addLocalCrucible,
  cloudSettingsView,
  crucibleServers,
  crucibleServerViews,
  crucibleServerNamed,
  crucibleSettingsView,
  computeSlots,
  forgetEngineTargets,
  clientFor,
  engineClientFor,
  probeCrucible,
  slotAvailability,
  probeCrucibleAt,
  removeCrucibleServer,
  writeCrucibleServers,
} from './crucible-registry';
import { readCapability } from './crucible-dispatch';
import { readEngineSettings, testUpstream, writeEngineSettings } from './crucible-settings';
import { crucibleFaultWords, crucibleRunState, startCrucible } from './crucible-start';
import { engineCatalog, pullSubject, removeModel } from './crucible-models';
import type {
  SettingsDocument,
  SettingsPatch,
  UpstreamName,
  UpstreamProbe,
} from '../shared/engine-settings';
import { crucibleInstallPlan } from './crucible-install';
import { crucibleInstallDoor, runInstallNarrated } from './crucible-install-door';
import {
  crucibleUninstallAvailability,
  crucibleUninstallDryRun,
  crucibleUninstallPerform,
  uninstallStoppedTheEngine,
} from './crucible-uninstall';
import type {
  CrucibleUninstallFlags,
  CrucibleUninstallPlan,
  CrucibleUninstallRun,
} from '../shared/uninstall-wire';
import { pairingFileRead, readConnectCode } from './crucible-pairing';
import { anyServerServing, forgetCrucibleFacts, refreshCrucibleFacts } from './crucible-provider';
import {
  tidySlotName,
  type CloudProviderEdit,
  type ConnectCodePreview,
  type CrucibleProbe,
  type CrucibleServerEdit,
  type LocalCrucibleAdd,
  type NewJobsWaitFor,
} from '../shared/slots';
import {
  ensureCapture,
  intakePhotos,
  mintAbort,
  mintBegin,
  mintCommit,
  mintPage,
  onIntakeProgress,
  openCapture,
  pdfStageBegin,
  pdfStagePage,
  pdfStageRelease,
  removePhotos,
  writeRecipe,
} from './capture';
import {
  amendBookOps,
  applyBookOps,
  clearPendingStack,
  correctBookBlock,
  loadBook,
  loadBookAt,
  readPendingStack,
  savePendingStack,
  viewExportedBook,
} from './book';
import { admit, admitted, openDocument, promptForDocument } from './documents';
import {
  engineInfo,
  readEpubMetadata,
  stampMintMetadata,
  readPdfMetadata,
  runDoctor,
  writeEpubMetadata,
  writePdfMetadata,
} from './engine';
import { catalogForThisMachine, onEnvInstallProgress } from './env-install';
import { hosted, hostMintMeta } from './host';
import {
  actOnHostNode, hostNodesFor, hostOffers, hostOpensStatus, hostStatus,
  invokeHostOperation, openHostStatus,
} from './host-ops';
import type { HostNodeAction } from '../shared/host-ops';
import * as queue from './job-queue';
import { finishSetup, finishPreparedSetup, setupState } from './setup';
import { probeSystem } from './system-probe';
import {
  createCaptureProject,
  deletableStep,
  deleteDocument,
  deleteProject,
  deleteStep,
  describeStepDelete,
  documentAssets,
  documentAtPosition,
  documentAtStep,
  exportInTray,
  goToStep,
  inspectProject,
  type ProjectInventory,
  isArchived,
  isManaged,
  listProjects,
  metadataDir,
  onProjectsChanged,
  positionStepId,
  projectDirOf,
  readAnalysisReport,
  readManifest,
  readStepLedger,
  recordMetadata,
  recordMintMeta,
  standForDocument,
} from './projects';
import {
  clearRecents,
  forgetRecent,
  forgetRecentsUnder,
  listRecents,
} from './recents';
import { readSettings, writeSettings } from './settings';
import { answerLetGo, broadcast, foundryWindow } from './window';
import {
  planAnalysis, planCleanup, planExport, planReading, planSimplification, planTranslation,
} from './workspace';
import { fold, isBook } from '../shared/original';
import {
  ANALYSIS_CATEGORY_IDS,
  type CustomAnalysisCategory,
} from '../shared/analysis-categories';
import { cleanupInEffect } from '../shared/ledger';
import type { ReadAsk } from '../shared/ledger';
import { admitPending, deferralFor, pendingStepOf, rowMinting, withPending } from '../shared/pending';
import type { Deferral } from '../shared/pending';
import type { BookOp, PendingStack } from '../shared/ops';
import { RE_READ_CANCEL, RE_READ_PROCEED } from '../shared/reread';
import type { ReReadPrompt } from '../shared/reread';
import type {
  AppQuestion,
  Asked,
  BackendSettingsPatch,
  CaptureRecipe,
  CloseAnswer,
  CloseWarning,
  ConversionKind,
  DeletionPrompt,
  DocumentDeletion,
  EnvInstallRequest,
  Job,
  JobRequest,
  LedgerStep,
  MetadataPatch,
  MetadataWriteOutcome,
  MintMeta,
  StepLedgerView,
  ProjectDocument,
  ProjectFacsimile,
  ProjectFinal,
  ProjectLedger,
  ProjectSummary,
  StepRow,
  ReReadAnswer,
  RewriteMode,
  StepDeletion,
  TextPassRequest,
  AnalyzeRequest,
  ModelClass,
  UnappliedAnswer,
  UnappliedWarning,
} from '../shared/types';

/**
 * The closing question's buttons — the words, beside the answers they mean.
 *
 * ── The lookup table that used to be here, and why it is gone ───────────────
 *
 * A NATIVE BOX ANSWERED WITH AN INDEX, and an index was the wrong thing for this
 * dialog to hold in its head: the box had two buttons for a file copy and three
 * for a set of corrections, so `response === 0` meant "close it" in one shape and
 * "save first" in the other. Two shapes, two meanings, one number — and the way
 * that went wrong was silent, because both were valid answers and neither threw.
 * The defence was to look the answer up by its own LABEL, through a `Record` that
 * lived right here.
 *
 * The card answers with the KEY of the button that was pressed, and the key is a
 * `CloseAnswer` — so the label is now nothing but the words on a button, the
 * table has nobody left to serve, and the compiler checks what a `Record` keyed
 * by prose used to check at runtime. The labels stay written once because two
 * spellings of one button is still two spellings.
 */
const KEEP = 'Keep it open';
const CLOSE = 'Close it';
/*
 * The book pane's two, which say what its own gestures are called rather than
 * borrowing the pair above. "Save these corrections" is the block editor's verb
 * over the block editor's noun, and neither is what a person did on the proof
 * sheet. DISCARD keeps its weight and has earned more of it: closing itself no
 * longer scraps a stack (Owen's reversal, 2026-08-22 — see `aboutTheEdits`), so
 * this button is now the only gesture in the app that throws unapplied work
 * away, and "Close it" was never the word for that.
 */
const APPLY = 'Apply these changes, then close';
const DISCARD = 'Discard them and close';
/*
 * And the unapplied card's two.
 *
 * ── THE RULING THAT MADE THEM TWO (Owen, 2026-08-22, verbatim) ──────────────
 *
 * *"if the user has 'this book' selected with un-applied changes, the export
 * option shouldnt be grayed out. but any action they take, whether it's
 * switching to a different step or narrating or anything at all, should ask if
 * they want to apply changes in a modal. discard/apply changes. if they hit
 * discard, it does whatever action they selected to the step theyre on after
 * dropping changes they made. if they hit apply changes, the action they select
 * is executed after applying all changes. and maybe there should be another
 * apply changes button somewhere obvious. the button on the side of the
 * workbench works but it isnt obvious"*
 *
 * `APPLY_AND_CONTINUE`, `WITHOUT_THEM` AND `CANCEL` STOOD HERE. The first was
 * "Apply them and continue" and is now simply "Apply changes" — the ruling's own
 * words, and the same words the second obvious button in the book pane wears, so
 * there is ONE name in this app for the one press. The second, "Continue without
 * them", is retired with the answer behind it (`UnappliedAnswer` carries the
 * argument). The third was a button; a cancel is now the app's own dismissal —
 * Escape or a click outside — because a card with three buttons where one of
 * them is "do nothing" makes the two that mean something harder to read, and the
 * ruling asked for two.
 *
 * DISCARD WEARS THE ERROR COLOUR HERE TOO, on the closing card's precedent and
 * for its reason: this is now the SECOND gesture in the app that can throw
 * unapplied work away, and a button that destroys has to be aimed at rather than
 * fallen onto. It is the only difference in weight between the two answers —
 * both are legitimate, one is irreversible.
 */
const APPLY_CHANGES = 'Apply changes';
const DISCARD_CHANGES = 'Discard changes';

/**
 * Whether a path sits inside a directory, on Windows' terms.
 *
 * Case-insensitively and separator-blind, because one folder is spelled three
 * ways here, and with the separator APPENDED to the folder first — so a project
 * called `Kershaw-a1b2c3d4` cannot claim a job writing into
 * `Kershaw-a1b2c3d4-notes` beside it and block a delete that has nothing to do
 * with it.
 *
 * Note what this is NOT: it is not the check that decides what may be erased.
 * That is `deletableProjectDir`, which proves a path is a direct child of the
 * projects directory. This one only answers "is that run writing in here".
 */
function within(dir: string, filePath: string): boolean {
  const fold = (target: string): string => path.resolve(target).replace(/\\/g, '/').toLowerCase();
  return fold(filePath).startsWith(`${fold(dir).replace(/\/+$/, '')}/`);
}

/**
 * A byte count as a person reads it — for the delete dialog, which has to say
 * how much of the disk is about to be handed back.
 *
 * Binary units, one decimal, and no `Intl` unit formatting: this goes into a
 * sentence that already reads plainly, and "1.4 GB" is the whole of what is
 * being communicated.
 */
/**
 * WAS THE NARRATION CLEANUP IN EFFECT where this host act was ordered from — the
 * one field of `HostInvokeContext`, answered against the project's own ledger.
 *
 * ── Why the node id has to be resolved rather than trusted ──────────────────
 *
 * `nodeId` is three different things (`HostOperation.invoke`, electron/host-ops.ts):
 * a ledger step id when the act was ordered from a row Foundry made, one of the
 * HOST's own ids when it was chained onto work that has not happened yet, and
 * `export:<file>` when it came off an export row. Only the first names a position
 * this app can ask a question about, so the lookup is `stepOf`-shaped and every
 * other shape falls to the same answer as a step that is not there.
 *
 * ── FALSE IS THE ANSWER FOR EVERY OTHER SHAPE, AND IT IS NOT A SHRUG ────────
 *
 * `HostInvokeContext.cleaned` documents it: nothing HERE says these words were
 * cleaned. A host that needs the distinction between "not cleaned" and "Foundry
 * could not tell" has the durable record on the file itself — the OPF's
 * `bookforge:narration-text`, written by the compile — which is the answer a
 * narration should act on in any case. Inventing a third state on this seam would
 * be a tri-state boolean crossing a process boundary to say "ask the file",
 * which the host can do unconditionally.
 *
 * IT NEVER THROWS. An unreadable manifest, a project that has moved, a ledger this
 * build refuses — none of those is a reason to fail a button somebody pressed, and
 * the console keeps the record.
 */
async function cleanupAtNode(projectDir: string, nodeId: string): Promise<boolean> {
  try {
    const view = await readStepLedger(projectDir);
    if (view === null) return false;
    /*
     * ── THE PROMISES ARE IN THE WALK, AS OF 2026-09-07 ────────────────────────
     *
     * Owen's pending-node ruling makes a narration orderable from a cleanup that
     * has not landed, which is exactly the shape this field exists to describe. So
     * the ledger is composed with the live queue's promises in it and the ordinary
     * `cleanupInEffect` answers through the chain unchanged (`withPending`,
     * shared/pending.ts, argues why a composed ledger beats an extra parameter on
     * five walks).
     *
     * TRUE HERE IS NOT A GUESS. The file the host will narrate is made by
     * `exportEpubFromStep`, which is itself chained behind the same promise and
     * cannot produce a book until it lands — so by the time there is anything to
     * act on, either the words are cleaned or the whole chain was cancelled by
     * name. Answering false instead would send the host to clean a book Foundry is
     * already cleaning, which is the duplicated-hour failure `HostInvokeContext`
     * was written to prevent.
     */
    const composed = withPending(view.ledger, promisedStepsIn(projectDir, view.ledger));
    const step = composed.steps.find((row) => row.id === nodeId) ?? null;
    return step === null ? false : cleanupInEffect(composed, step);
  } catch (err) {
    console.error(
      `[ipc] could not tell whether ${nodeId} in ${projectDir} stands under a cleanup `
      + `(${err instanceof Error ? err.message : String(err)}); the host is told it does not.`,
    );
    return false;
  }
}

/**
 * EVERY QUEUE ROW ABOUT THIS BOOK, from whichever list is scheduling.
 *
 * `shelfJobs()` AND NOT `listJobs()`, which is the whole of what makes this work
 * hosted: with a host queue registered the rows in this window are the HOST's, and
 * the promises a person clicked in the tree were drawn from those. Asking Foundry's
 * own list would answer empty for every chain there is.
 *
 * FILTERED BY THE PRODUCT'S PROJECT, whole path against whole path through
 * `projectDirOf` — this codebase's oldest house rule, and it matters here because
 * the shelf is one global list across every book on the machine.
 */
function rowsIn(projectDir: string): Job[] {
  return queue.shelfJobsFor(projectDir);
}

/**
 * A RUNNING GHOST IS LOCKED, and the tree is not the door — Owen's ruling
 * (2026-09-08): *"maybe we turn it red while its running and lock it. the user
 * has to remove it from the queue itself. again, if it's removed as a ghost,
 * everything under it is removed as well. that simplifies the logic so it doesnt
 * hit a bug where narration is trying to run on the wrong thing, or nothing at
 * all."*
 *
 * THE LAST CLAUSE IS THE REASON AND IT IS NOT TIDINESS. Stopping a run from here
 * means deciding, at the moment the work is half done, what becomes of everything
 * chained under it — and the two queues answer that differently (a host's remove
 * drops the subtree, this app's cancel marks it). One door, the queue's own, is
 * one answer; two doors is where a narration ends up pointed at a step nobody is
 * going to make. A QUEUED ghost is untouched by this: nothing has begun, and its
 * delete is still the removal `promisedDeletion` describes.
 */
function refuseRunningGhost(row: Job): void {
  if (row.state !== 'running') return;
  const label = row.title ?? path.basename(row.outputPath);
  throw new Error(
    `“${label}” is running, so it cannot be removed from here. Stop it in the queue, which takes `
    + 'everything queued behind it away in the same gesture — the one place that can end a run and '
    + 'settle what happens to the work waiting on it.',
  );
}

/**
 * A DELETE PRESSED ON A GHOST — the id is minted by a live row, not held by the
 * ledger, and `stepOf` would refuse it by name ("This ledger has no step called
 * …", which is what Owen saw, 2026-09-08). A promise is a queue row, so the
 * question is answered from the queue: what goes is the row and every row chained
 * behind it, and the removal is the queue's own — which hosted forwards to the
 * host's `remove`, whose cascade is the same one the tree draws.
 *
 * NULL FOR A REAL STEP, and the ordinary delete goes on exactly as it did.
 */
/**
 * DROP ONE STEP — the door a HOST reaches, and the one the handler runs.
 *
 * BookForge lists a Foundry export as a version nested under its parent book,
 * and Owen's ruling of 2026-09-17 makes those two rows one fact: deleting the
 * version there must drop the step here. That host lives in another process's
 * renderer and can never send this app's `ipcMain` message, so what it needs is
 * a FUNCTION — re-exported through `mount.ts` beside `exportEpubFromStep`.
 *
 * IT IS A HOLDER RATHER THAN THE BODY ITSELF because the body belongs to
 * `registerIpc`'s scope: the two proofs it must run (`refuseBusyStepDelete`,
 * and `refuseBusyJob` under it) close over locals there. Lifting those to module
 * scope to satisfy this caller would be rearranging the file around its newest
 * reader. So the body is assigned once, where it is written, and this is the
 * only way in from outside — which keeps ONE body rather than a copy shaped like
 * it. A copy would have to carry the ghost branch, both busy proofs and the
 * subtree cascade, and the first edit to either would leave a press in Foundry
 * and a press in BookForge deleting different things.
 *
 * BEFORE `registerIpc` RUNS IT REFUSES BY NAME. Answering "deleted" from an app
 * that has not mounted would be the silent success this codebase refuses
 * everywhere else.
 */
let stepDeleteDoor: ((projectDir: string, stepId: string) => Promise<unknown>) | null = null;

export function deleteLedgerStep(projectDir: string, stepId: string): Promise<unknown> {
  if (stepDeleteDoor === null) {
    return Promise.reject(new Error(
      'Foundry has not been mounted, so there is no ledger to delete a step from. '
      + '`mountFoundry` must run before a host can drop a step.'));
  }
  return stepDeleteDoor(projectDir, stepId);
}

function promisedDeletion(projectDir: string, stepId: string): StepDeletion | null {
  const rows = rowsIn(projectDir);
  const row = rowMinting(rows, stepId);
  if (row === null) return null;
  refuseRunningGhost(row);
  // The chain behind it, transitively, by `after` — the cascade's own edge.
  const going: Job[] = [row];
  const seen = new Set<string>([row.id]);
  for (let i = 0; i < going.length; i += 1) {
    for (const other of rows) {
      if (other.after === going[i]!.id && !seen.has(other.id)) {
        seen.add(other.id);
        going.push(other);
      }
    }
  }
  const nameOf = (one: Job): string => one.title ?? path.basename(one.outputPath);
  const label = nameOf(row);
  return {
    stepId,
    label,
    queued: true,
    casualties: going.map((one, at) => ({
      id: one.mints ?? one.id,
      label: nameOf(one),
      cost: at === 0
        ? `“${nameOf(one)}” is ${one.state === 'running' ? 'running' : 'queued'} and has made nothing yet — `
          + 'removing it makes nothing and destroys nothing.'
        : `“${nameOf(one)}” was to be made from it, and leaves the queue with it.`,
      stale: false,
    })),
    belongings: null,
    files: [],
  };
}

/**
 * THE PROMISES THIS BOOK'S QUEUE ROWS MAKE, as synthetic steps — the list every
 * walk in main composes a ledger with.
 *
 * The orphan rule is `admitPending`'s and is applied here rather than at each
 * caller: a row whose parent is neither a step nor another live promise is not
 * drawn and is not walked, which is the derivation half of Owen's cascade and must
 * be one rule rather than two implementations that can disagree about what the
 * window is showing.
 */
function promisedStepsIn(projectDir: string, ledger: ProjectLedger): LedgerStep[] {
  return admitPending(ledger, rowsIn(projectDir))
    .map(pendingStepOf)
    .filter((step): step is LedgerStep => step !== null);
}

/**
 * WHAT A PLAN IS AIMED AT — a real row, a promised one, or a refusal naming the id.
 *
 * ── The one resolution, made once for four doors ────────────────────────────
 *
 * Every plan door now takes an optional step id, because a person can press an act
 * on a card that is not the position: a landed row further up the tree, or — since
 * Owen's ruling — a row that has not landed at all. The three outcomes are decided
 * here so that the four doors cannot come to three answers about what an id means,
 * and so that the REFUSAL is spelled once.
 *
 * A LEDGER STEP answers `{ at: step }`, and the plan is composed against it exactly
 * as it would be against the position.
 *
 * A LIVE PROMISE answers `{ deferral }`, and the plan composes only what is
 * deterministic (`WorkspacePlan.deferred`).
 *
 * NEITHER IS A REFUSAL, and it names both halves of what it looked in. That
 * sentence is the one a person sees if they press an act on a card whose row left
 * the queue in the same instant — the derivation would have taken the card off the
 * screen a repaint later, and this is what happens if the press wins the race.
 *
 * NO `from` AT ALL IS THE POSITION, which is every press this app had before this
 * wave and is what the dock still sends.
 */
async function aimedAt(
  source: string,
  from?: string,
): Promise<{ at: LedgerStep | null; deferral?: Deferral }> {
  if (from === undefined || from.length === 0) return { at: null };
  const dir = projectDirOf(source);
  if (dir === null) {
    throw new Error(
      `This document does not belong to a project in this app’s library, so “${from}” cannot be a `
      + 'step of it.',
    );
  }
  const view = await readStepLedger(dir);
  if (view === null) {
    throw new Error(`${dir} is no longer a project in this app’s library.`);
  }
  const step = view.ledger.steps.find((row) => row.id === from) ?? null;
  if (step !== null) return { at: step };
  const deferral = deferralFor(view.ledger, rowsIn(dir), from);
  if (deferral === null) {
    throw new Error(
      `“${from}” is not a step of this book and no queued work will make it, so there is nothing to `
      + 'make this from. Click a step that exists and press again.',
    );
  }
  return { at: null, deferral };
}

/**
 * THE ROW A HOST'S OWN WORK MUST WAIT BEHIND, when the act was ordered from
 * something that has not happened yet — `HostInvokeContext.pendingRow`.
 *
 * ONE LOOKUP FOR BOTH SHAPES OF ID. A promised STEP and a promised EXPORT are told
 * apart everywhere else in this feature (`exportOfNodeId`), and here they are not:
 * `Job.mints` carries whichever id the row is going to land, so asking "which live
 * row mints this" answers for a narration ordered from a grayed cleanup and for one
 * ordered from a grayed EPUB with the same line.
 *
 * UNDEFINED FOR EVERY ORDINARY PRESS — a landed step, a file in the tray — which is
 * every host act before this wave, and means "nothing to wait for".
 */
function pendingRowAt(projectDir: string, nodeId: string): string | undefined {
  return rowMinting(rowsIn(projectDir), nodeId)?.id;
}

function sizeOnDisk(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * SOMETHING THAT DECIDES A TILE MOVED. Say so; say nothing about what.
 *
 * The dock's gates are composed in main off three facts (act-gates.ts), and every
 * one of them is changed by a door in this file: the SERVER REGISTRY, whose
 * capability reads are the only thing that lights a text tile (`afterRegistryChanged`
 * below is that door), the page reader's directory, and the settings file. The
 * hardware probe and Ollama's library were two more until 2026-09-15, and both
 * described a machine that does not run the work.
 *
 * Without this push a person would connect an engine and watch Translate stay gray
 * until they restarted the app — which is the exact failure Owen's rule was written
 * to prevent, arriving from the other direction.
 *
 * NO PAYLOAD, on `projects:changed`'s reasoning. The gates are one composed
 * answer and composing them costs a probe, so this says only that the machine
 * moved and the renderer asks again through `acts:gates`. Pushing the shape
 * would give the app two writers of it, and the pushed copy would be the one
 * that goes stale.
 */
function gatesChanged(): void {
  broadcast('acts:gates-changed', null);
}

/**
 * THE REGISTRY CHANGED — everything that follows from that, in one place.
 *
 * Adding, enabling, renaming or removing a server moves three things at once and
 * they have to move in this order:
 *
 *   1. FORGET the cached capability answers. They were measured against the old
 *      list and every one of them may now be wrong; a fifteen-second stale
 *      window after a deliberate press is the one case a person reads as the app
 *      ignoring them (`crucible-provider.ts`).
 *   2. MEASURE again, so the deletion below is decided on what the servers say
 *      NOW rather than on a silence that has not been broken yet. `unknown` is
 *      not a permission to delete, so skipping this would simply mean nothing
 *      happens — which is safe and is also not what somebody who just registered
 *      their local Crucible is expecting to see.
 *   3. APPLY docs/SLOTS.md §5b: if a LOCAL Crucible now serves `pages`, Foundry's
 *      own copy of the page reader is a duplicate and goes, out loud.
 *
 * THE REMOVAL IS ANNOUNCED TWICE OVER, on purpose. `acts:gates-changed` moves
 * the OCR tile's sentence, and `models:changed` moves the two cards that draw
 * the files themselves — they are different questions with different readers,
 * and one push doing both would be a card re-reading an inventory because a
 * tooltip changed.
 */
/**
 * THE REGISTERED SERVER OF THAT NAME, or a rejection that says the name.
 *
 * The four `crucible:engine-*` doors take a NAME, and the address and the token
 * behind it are looked up here — `crucible:open`'s rule, so nothing a renderer
 * holds could send a key to an engine this app has not been told about.
 *
 * IT THROWS RATHER THAN ANSWERING NULL. A card drew that row a moment ago, so a
 * missing name means the registry moved underneath it (another window saved, or
 * the host's list changed hosted); "there is no server called X" is the honest
 * sentence and the card's next read redraws the list.
 */
function namedServerOr(serverName: string): CrucibleServerEntry {
  const entry = crucibleServerNamed(serverName);
  if (entry === null) throw new Error(`there is no registered server called ${serverName}`);
  return entry;
}

async function afterRegistryChanged(): Promise<void> {
  /*
   * THE RESOLVED HOPS GO FIRST, AND BEFORE THE CAPABILITY ANSWERS, because the
   * capability read is made THROUGH one (crucible docs/PHASE17-ORCHESTRATOR.md
   * §6, `engineClientFor`). Re-pointing an entry from a tray to its engine — or
   * the other way — changes which process every later read reaches, and a
   * refresh that ran against a remembered hop would fill the capability cache
   * from the machine the person has just stopped naming.
   */
  forgetEngineTargets();
  forgetCrucibleFacts();
  await refreshCrucibleFacts();
  /*
   * THE AUTOMATIC REMOVAL WENT WITH THE THING IT REMOVED. SLOTS.md 5b had a
   * Crucible on this machine take over page reading, at which point Foundry
   * deleted its own copy of the reader and printed a receipt. Foundry has no
   * copy of anything to delete (2026-09-17), so the gates are still re-read --
   * a registry change moves the OCR tile -- and nothing is swept.
   */
  gatesChanged();
}

/**
 * COORDINATE WITH A SERVER BECAUSE SOMETHING CONNECTED US TO IT.
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a: every time Foundry finds a Crucible
 * it makes sure that Crucible has what Foundry needs — nobody presses anything.
 * The moments are app start (every enabled server), a server being added, and a
 * server being switched back on or newly named by a registry save; all of them
 * go through `crucible-coordinate.ts`'s one function, which is also what makes
 * two of them arriving together ONE run.
 *
 * A FAILED COORDINATION NEVER FAILS THE ACT THAT TRIGGERED IT. The server was
 * added, the switch was flipped; what did not happen is a conversation with a
 * machine, and that is the coordination STATE's to say, in the row. So this
 * catches everything and logs ONE line — and `coordinateServer` is already
 * written never to throw, which makes this the belt to that braces rather than
 * the place the outcome is decided.
 */
async function coordinateWithServer(name: string, because: string): Promise<void> {
  try {
    const state = await coordinateServer(name);
    console.log(`[crucible] "${name}" coordinated ${because}: ${state.phase}`);
  } catch (err) {
    console.error(
      `[crucible] could not coordinate with "${name}" ${because}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * WHICH SERVERS A REGISTRY SAVE CONNECTED US TO — new by name, or switched on.
 *
 * `crucible:save` replaces the whole list in one message (see
 * `writeCrucibleServers` for why it is one door), so "what just changed" is a
 * DIFF and there is nowhere else to take it from. Two answers count as a
 * connection and the rest do not:
 *
 *   - a name the registry did not have before is a server this app has just met;
 *   - `enabled` going false → true is the exact reverse of the one gesture that
 *     means "not that one" (Owen, 2026-09-14), so switching it back on is the
 *     moment to find out what it is missing.
 *
 * A RENAMED, RE-ADDRESSED OR RE-TOKENED ROW IS NOT IN THIS LIST unless its name
 * is new, and that is the honest reading of a card that saves on every edit: a
 * person dragging rows around has connected to nothing, and coordinating with
 * six servers because one of them moved up the order would be this app spending
 * somebody's afternoon on a reorder.
 */
function serversConnectedBySave(
  before: readonly { name: string; enabled: boolean }[],
  after: readonly { name: string; enabled: boolean }[],
): string[] {
  const was = new Map(before.map((entry) => [entry.name.toLowerCase(), entry.enabled]));
  return after
    .filter((entry) => {
      if (!entry.enabled) return false;
      const previously = was.get(entry.name.toLowerCase());
      return previously === undefined || previously === false;
    })
    .map((entry) => entry.name);
}

/**
 * THE FIRST OF PHASE15 §5.1's THREE WAYS IN: the connect code a Crucible left on
 * this machine, read and registered under THE NAME THE LINE CARRIES, with nobody
 * typing anything.
 *
 * ── Why it is here and not in crucible-pairing.ts ───────────────────────────
 *
 * Because it WRITES THE REGISTRY, and everything that writes the registry ends
 * in `afterRegistryChanged` above — forget the capability answers, measure
 * again, apply docs/SLOTS.md §5b — which is this module's and deliberately
 * private to it. A second caller that wrote an entry and did not take that pass
 * would leave a registered engine behind gates that still say there is none, and
 * that is the exact failure the pass was written for. crucible-pairing.ts reads
 * a file; this decides what the app does about what it read.
 *
 * ── THERE IS NO RESERVED NAME. THE LINE NAMES THE SERVER ────────────────────
 *
 * This used to register the entry as `local`, and the doc-comment here used to
 * justify that word as parity with BookForge. Owen's ruling ends both halves:
 * *"it shouldnt be named 'local' anywhere. it might not be local. a local
 * crucible server shouldnt be treated any differently than a remote crucible
 * server. it should all be entered the exact same way… bookforge shouldnt even
 * know if it's local because it doesnt mater."* BookForge deleted its own
 * reserved identity (their `24b7bf67`), so there is nothing left to be in parity
 * with either.
 *
 * What replaces it was already in the line. A pairing file IS A CONNECT CODE the
 * machine left on disk — same spelling, same `parsePairing`, same `{name, url,
 * token}` — so this registers it EXACTLY as a pasted one is registered, through
 * {@link registerPairing}, which is the one writer both doors share. The name is
 * the server's own (`crucible@example-pc-wsl`, whatever the operator called it),
 * which is the same name a person would see in the preview if they pasted the
 * line by hand.
 *
 * RE-READING STILL FIXES A ROTATED TOKEN rather than growing a second row:
 * `addCrucibleServer` replaces an existing NAME in place, keeping its rank and
 * its enabled state, and the name is stable because it comes out of the line.
 *
 * ── IT DECLINES WHEN THIS URL IS ALREADY REGISTERED ─────────────────────────
 *
 * Not when ANY loopback entry is — that was the same "local is special"
 * assumption one layer down, and wrong on its own terms: somebody with a tailnet
 * Crucible registered AND a pairing file on disk got neither, because the
 * tailnet row's address happened to be loopback. The question actually being
 * asked is "do I already have THIS server", so the test is the clamped URL
 * against the registry's, which is name-free and locality-free. It is also
 * `addLocalCrucible`'s test (crucible-registry.ts), which has keyed on the URL
 * all along.
 *
 * ── HOSTED, THE REGISTRY IS THE HOST'S AND THIS DOES NOTHING ────────────────
 *
 * Refused at the door as well as skipped at the call, because `addCrucibleServer`
 * throws hosted (`refuseHostedRegistryChange`) and an unguarded startup call
 * would put that throw in a console every time BookForge opened the window.
 *
 * ── WHAT THE FILE NAMES IS WHAT IS REGISTERED, EVEN IF IT IS A TRAY ─────────
 *
 * crucible docs/PHASE17-ORCHESTRATOR.md §6: *"the pairing line an app reads is
 * the ENGINE's"* — on Windows the orchestrator writes the guest's line verbatim
 * — so this ordinarily registers an engine and the hop below never fires. When
 * a line names an ORCHESTRATOR anyway, registering it is still CORRECT and is
 * left alone: `resolveEngine` (crucible-registry.ts) follows the hop for every
 * call that does work, and the one door that does not is the console button,
 * which should open the process the person's machine actually named (see
 * `openCrucibleUi`, which argues it). Rewriting the address here would be this
 * app storing a fact it derived over the fact the machine stated.
 */
export async function adoptPairingFile(): Promise<LocalCrucibleAdd> {
  if (hosted()) {
    return {
      outcome: 'failed',
      code: 'no_local_config',
      message: 'The servers are the host application\'s while Foundry is running inside it.',
    };
  }
  const read = await pairingFileRead();
  if (read.found === 'absent') {
    // Debug volume, one line, and the SAME sentence the button shows — see
    // crucible-pairing.ts: an absent file is a fact about this machine.
    console.log(`[pairing] no pairing file at ${read.path} — nothing has left a code here.`);
    return {
      outcome: 'failed',
      code: 'no_local_config',
      message: `No Crucible has left a connect code on this machine (${read.path}). `
        + 'Install one here, or connect to one somewhere else.',
    };
  }
  if (read.found === 'refused') {
    console.error(`[pairing] refused: ${read.message}`);
    return { outcome: 'failed', code: 'config_unreadable', message: read.message };
  }
  /*
   * THE ADDRESS DECIDES, NOT THE ADDRESS'S SHAPE. Clamped first because that is
   * what the registry stored its own rows through, then compared with
   * `sameCrucibleAddress` — the registry's one duplicate rule, which also
   * settles host case and a default port.
   *
   * IT MUST BE THE SAME RULE THE WRITER USES, and that is not tidiness. Since
   * the writer began refusing a duplicate address, a check here that was even
   * slightly narrower would let a line through to `registerPairing` that the
   * writer then THREW on — turning this function's clean "already registered,
   * nothing to do" into a caught `config_unreadable`, on the startup path, on
   * every launch. The two rules being one is what keeps that unreachable.
   */
  const url = clampCrucibleUrl(read.pairing.url);
  const already = crucibleServers().find(
    (entry) => url !== null && sameCrucibleAddress(entry.url, url),
  );
  if (already !== undefined) {
    return {
      outcome: 'failed',
      code: 'already_registered',
      message: `${read.pairing.url} is already registered as "${already.name}".`,
    };
  }
  /*
   * A LINE THE REGISTRY WILL NOT TAKE IS A FACT, NOT A CRASH. `registerPairing`
   * goes through the one writer, which refuses BY NAME — a name with a `:` in
   * it, an address that is not http(s) — and this is the one road nobody
   * pressed: mount.ts calls it at startup and does not await it, on the stated
   * contract that it *"cannot reject"*. So the refusal is caught and worn as the
   * third outcome the type already has, which is also the sentence the "Look
   * again" button shows.
   */
  let name: string;
  try {
    name = registerPairing(read.pairing, '');
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    console.error(`[pairing] ${read.path} could not be registered: ${said}`);
    return {
      outcome: 'failed',
      code: 'config_unreadable',
      message: `${read.path} names a server this app cannot store: ${said}`,
    };
  }
  await afterRegistryChanged();
  console.log(`[pairing] registered "${name}" at ${read.pairing.url} from ${read.path}.`);
  // A server this app has just met, by the same rule as `crucible:add`:
  // finding it is the request (PHASE14 §4a), so it is coordinated with now.
  void coordinateWithServer(name, 'it was found in the pairing file');
  return {
    outcome: 'added',
    servers: crucibleServerViews(),
    serverName: name,
    url: read.pairing.url,
    configPath: read.path,
  };
}

/**
 * THE ENGINE ON THIS MACHINE, CONNECTED WITHOUT ANYBODY BEING ASKED.
 *
 * Owen, 2026-09-15, on opening the wizard to three doors over a Crucible that
 * was already running here: *"this should be idiot proof. it should check to
 * see if a server is installed here. if it is, it just connects. seamlessly…
 * it shouldnt talk about crucible unless it needs to, or to ask the user to add
 * a crucible server."*
 *
 * ── WHY TWO READS AND NOT ONE ─────────────────────────────────────────────
 *
 * There are two files a Crucible on this machine may have left, and which one
 * exists is not something a person should have to know:
 *
 *   * `<CRUCIBLE_HOME>/pairing` — the connect code, written by the installer.
 *     {@link adoptPairingFile}. Present on a machine somebody installed with a
 *     current Crucible.
 *   * that server's own `config.toml` — {@link addLocalCrucible}, the door
 *     labelled "Use the Crucible on this machine". Present on every machine
 *     with a server on it, including ones whose pairing file was never written
 *     or has been tidied away.
 *
 * The pairing file goes first because it is PHASE15 §5.1's own order and it
 * carries the server's chosen name; the config is the fallback that catches the
 * rest. A machine with neither has no engine here, which is a fact and the one
 * case where the wizard has something to say.
 *
 * ── `already_registered` IS A SUCCESS HERE, AND THAT IS THE WHOLE POINT ───
 *
 * Both doors refuse an address the registry already holds, and they are right
 * to: adding it twice would be two GPU lanes over one card. But the question
 * THIS function asks is not "did I write a row", it is *"is the engine on this
 * machine connected"* — and a door refusing because the row is already there
 * answers that with yes. Owen pressed the local door on exactly this machine
 * and was shown *"http://127.0.0.1:7100 is already registered as \"local\".
 * Rename or remove that entry first"*, which is a true sentence about the
 * registry and a useless one about his situation: he was connected and was
 * being told to dismantle it. So the refusal is READ rather than shown, the
 * second read is skipped, and nothing is drawn.
 *
 * ── IT SPENDS NOTHING AND CANNOT REJECT ───────────────────────────────────
 *
 * Two file reads and, at most, one registry write. No model is loaded, no job
 * is placed, and the network is touched only by the coordination the writers
 * already start for a server this app has just met (PHASE14 §4a). Every arm
 * answers a {@link LocalCrucibleAdd}, so `mount.ts` can call it unawaited on a
 * path that runs before the window exists.
 */
export async function connectLocalEngine(): Promise<LocalCrucibleAdd> {
  if (hosted()) return { outcome: 'failed', code: 'no_local_config',
    message: 'The local connection belongs to the host application.' };
  const local = await addLocalCrucible('');
  if (local.outcome === 'added') {
    console.log(`[engine] registered "${local.serverName}" at ${local.url} from ${local.configPath}.`);
    await afterRegistryChanged();
    /*
     * THE SAME MOMENT THE DOOR TAKES, because this IS that door: finding a
     * server is the request (PHASE14 §4a), and a row that arrived without
     * anybody pressing anything still has to be coordinated with or the tiles
     * stay dark until something else asks.
     */
    void coordinateWithServer(local.serverName, 'a Crucible was found on this machine');
    return local;
  }
  if (local.code === 'already_registered') {
    console.log(`[engine] ${local.message} Nothing to connect.`);
    return local;
  }
  console.log(`[engine] no Crucible on this machine: ${local.message}`);
  return local;
}

/**
 * REGISTER ONE PAIRING LINE — the ONE writer behind both doors that take one.
 *
 * A pairing FILE is a connect code the machine left on disk, and a pasted
 * connect code is the same line off somebody's operator page. Owen's ruling —
 * *"it should all be entered the exact same way"* — means the two cannot differ
 * in how they name the server, so they do not differ in the code either: same
 * `addCrucibleServer`, same refusals, same `slotNameRefusal` clamp on the way to
 * disk, same name source.
 *
 * THE NAME IS THE LINE'S UNLESS SOMEBODY TYPED ONE. `typed` is the connect-code
 * card's Name box: the preview filled it with the code's own name and a person
 * may have renamed it before pressing Add, and a door that re-read the name out
 * of the line would silently throw that away. Empty — which is what the pairing
 * file's path passes, because there is no box on that road — means the line's
 * own name.
 *
 * It answers THE NAME AS STORED, because that is what the caller has to
 * coordinate with and log: `addCrucibleServer` tidies whitespace, and a
 * coordination keyed on the untidied string would be a run under a name no card
 * draws.
 *
 * NO TOKEN CROSSES OUT OF HERE. The line carries one; it goes into the registry
 * and nowhere else, which is crucible-registry.ts's standing rule.
 */
function registerPairing(pairing: Pairing, typed: string): string {
  const wanted = tidySlotName(typed);
  const name = wanted.length > 0 ? wanted : tidySlotName(pairing.name);
  addCrucibleServer(name, pairing.url, pairing.token);
  return name;
}

export function registerIpc(): void {
  const pairingSessions = new RemotePairingSessions(async (pairing) => {
    const existing = crucibleServers().find((entry) => sameCrucibleAddress(entry.url, pairing.url));
    const stored = registerPairing(pairing, existing === undefined ? '' : existing.name);
    await afterRegistryChanged();
    void coordinateWithServer(stored, 'remote pairing was approved');
  }, startPairing, pollPairing);
  const pairingWindows = new Set<number>();
  ipcMain.handle('foundry:crucible-pair-start', async (event, address: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    if (typeof address !== 'string' || !address.trim()) throw new Error('Enter the other computer’s address.');
    const owner = event.sender.id;
    if (!pairingWindows.has(owner)) {
      pairingWindows.add(owner);
      event.sender.once('destroyed', () => {
        pairingSessions.cancelOwner(owner);
        pairingWindows.delete(owner);
      });
    }
    return pairingSessions.begin(owner, address.trim());
  });
  ipcMain.handle('foundry:crucible-pair-poll', (event, id: string) => {
    if (hosted()) throw new Error('Manage server connections in the host application.');
    return pairingSessions.poll(event.sender.id, id);
  });
  ipcMain.handle('foundry:crucible-pair-cancel', (event) => pairingSessions.cancelOwner(event.sender.id));
  ipcMain.handle('foundry:crucible-pair-requests', async (_event, name: string) => {
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    return client.listPairingRequests();
  });
  ipcMain.handle('foundry:crucible-pair-decide', async (_event, name: string, id: string, code: string, allow: boolean) => {
    if (typeof allow !== 'boolean') throw new Error('Choose Approve or Deny.');
    const entry = crucibleServerNamed(name);
    if (!entry) throw new Error('Choose a registered Crucible server.');
    const client = await engineClientFor(entry);
    await client.decidePairing(id, code, allow);
  });
  /*
   * ── `foundry:crucible-wsl-upgrade` AND ITS PUSH ARE GONE (PHASE19 §0) ─────
   *
   * They were the two halves of one button, "Set up WSL acceleration", which
   * submitted an `engine/wsl` task to a native Windows engine and followed it.
   * PHASE19 deletes the button on a ruling, not a refactor: Owen, 2026-09-18,
   * *"we should assume they have no idea how to do it and it should do it
   * automatically."* The move is the TRAY's now, decided at every start from
   * facts on disk (§2.3), and an app that could also ask for it would be the
   * second owner of "is this machine moving to the Linux engine".
   *
   * What replaces it on screen is a READOUT, not a control: the outcome the
   * tray writes (§2.2), reached through the three doors below. The one control
   * that survives is §2.5's Try again, and it exists only because a person can
   * change a BIOS setting and want the machine looked at again.
   */
  /**
   * Is this window Foundry's own, or is it standing inside another app?
   *
   * ── Why the renderer is told at all ─────────────────────────────────────────
   *
   * Because a few things on screen are answers to questions the host has already
   * answered, and showing them twice is worse than showing them once. The library
   * folder is the first: hosted, the books live in the host's data directory and
   * the control that moves them is a control that would strand the host's own
   * mappings, so it goes (see `library:set`). Home is the next: hosted, the book
   * list is BookForge's, and two library screens are two answers to "what books
   * do I have".
   *
   * ASKED ONCE AND NEVER PUSHED. Nothing can mount a host halfway through a
   * session — `mountFoundry` runs before the window is opened and there is one
   * process — so this is a fact for the lifetime of the page, and an event
   * channel for it would be a subscription that never fires.
   */
  ipcMain.handle('app:hosted', () => hosted());

  /*
   * ── THE HOST-OPERATIONS SOCKET — a family BookForge owns nothing in ───────
   *
   * `host-ops:` was chosen for exactly that reason. Hosting is additive only
   * while no FULL channel name is shared, and every family this app has ever
   * used was audited against the host's registry once (docs/IPC-CHANNELS.md);
   * a brand-new family with a hyphen in it cannot collide with anything, so
   * the socket is collision-safe by construction rather than by re-running an
   * audit every time it grows a door. It has grown three since — the
   * failed-node pair and the chrome's status chip — and that promise is what
   * made each of them free. A fourth name arrived on 2026-08-18 and is NOT a
   * door: `host-ops:offers-changed` is a broadcast, so it is registered where
   * every push in this app is (`broadcast`, electron/window.ts) and the count
   * below is unchanged by it.
   *
   * EVERY ONE IS REGISTERED WHETHER OR NOT ANYBODY MOUNTED A HOST. The
   * renderer asks the same questions in both worlds and gets an empty list or a
   * null standalone (electron/host-ops.ts): a door that existed only when hosted
   * would be a renderer that has to know which world it woke up in before it
   * can draw a tree.
   */
  /*
   * WHAT THE HOST REGISTERED AT MOUNT — the operations, and whether a failed
   * node's Retry and Dismiss have anywhere to go.
   *
   * IT ANSWERS AN OBJECT RATHER THAN AN ARRAY, and the shape change is the
   * cheapest of the three ways to let the tree ask that second question: it is
   * the same question as the first (what did the host register), asked in the
   * same round trip the renderer already makes at startup, and it adds no channel
   * name for BookForge's collision keeper to audit. See `hostTakesNodeActions`.
   *
   * AND THE ANSWER IS COMPOSED WHERE THE PUSH COMPOSES IT. `host-ops:offers-changed`
   * carries this very shape now that a host may revise its acts, and a door and a
   * broadcast spelling one fact twice are two answers waiting to disagree — so
   * both are `hostOffers()` and there is no second literal to keep in step.
   */
  ipcMain.handle('host-ops:offers', () => hostOffers());
  /*
   * ONE PROJECT'S HOST NODES — and, on the way past, the host's QUEUE rows for it.
   *
   * ── Why two answers ride one ask ──────────────────────────────────────────
   *
   * This is the moment main learns that a window is drawing a particular book,
   * and it is the only such moment: `queue:list` is global and names no project,
   * because the shelf has always been one list across the library. A host that
   * keeps its own queue pushes per project (`setHostQueueRows`), so a window that
   * opened AFTER the host's last push would draw an empty shelf until something
   * moved — the same gap `hostNodesFor` exists to close for the tree, one line up.
   *
   * IT ADDS NO CHANNEL, which is the reason it rides here rather than arriving as
   * a door of its own: the count in docs/IPC-CHANNELS.md stays where it is and
   * BookForge's keeper has nothing new to audit. A host that offers no `rows` is
   * unaffected, and standalone the seed is a function call that returns at its
   * first line.
   */
  ipcMain.handle('host-ops:nodes', (_event, projectDir: string) => {
    queue.seedHostQueueRows(projectDir);
    return hostNodesFor(projectDir);
  });
  /*
   * The user pressed one of the host's acts, from a node in the tree.
   *
   * MAIN OWNS THE FUNCTION AND THE RENDERER OWNS ONLY THE ID — the operation is
   * looked up in what the host registered at mount, and an id nothing registered
   * is a refusal naming it. The rejection is deliberately NOT caught: this is a
   * button, and the tree puts the host's own sentence on the notice strip when
   * it fails. See `HostOperation.invoke`.
   */
  ipcMain.handle(
    'host-ops:invoke',
    /*
     * `settings` IS THE THIRD ARGUMENT AND IT IS THE ANNOUNCED CHANGE — the
     * answers to the form the operation declared, or `{}` for one that declared
     * none (see `HostOperation.invoke`, electron/host-ops.ts). Defaulted at the
     * door as well as inside, because a renderer built against the older preload
     * would send two arguments and must go on working rather than handing the
     * host `undefined` for a record it is entitled to destructure.
     */
    /*
     * AND THE FOURTH ARGUMENT IS COMPOSED HERE RATHER THAN SENT — see
     * `HostInvokeContext` (shared/host-ops.ts). It is what FOUNDRY knows about the
     * position, so it is read off the ledger in main, at the moment of the press,
     * and not taken from a renderer that holds a mirror of the same file: a mirror
     * that had not caught up would tell somebody else's queue that a book was
     * cleaned when it was not.
     */
    async (
      _event,
      operationId: string,
      projectDir: string,
      nodeId: string,
      settings: Record<string, unknown> = {},
    ) => {
      /*
       * AND WHICH ROW THIS WORK IS DOWNSTREAM OF, when the act was ordered from
       * something that has not happened yet (`HostInvokeContext.pendingRow`).
       * Composed in main for `cleaned`'s reason exactly: it is a fact about the
       * queue that is scheduling, and a renderer's mirror of that queue can be a
       * repaint behind — which here would mean telling somebody else's scheduler to
       * wait for a row that finished a moment ago, or not to wait at all.
       */
      const pendingRow = pendingRowAt(projectDir, nodeId);
      return invokeHostOperation(operationId, projectDir, nodeId, settings, {
        cleaned: await cleanupAtNode(projectDir, nodeId),
        ...(pendingRow !== undefined ? { pendingRow } : {}),
      });
    },
  );

  /*
   * RETRY OR DISMISS A HOST NODE THAT FAILED.
   *
   * ── Why it is a door of its own and not another operation ─────────────────
   *
   * An operation is the HOST's — it has an id the host minted, a label the host
   * wrote, and a rule about what it may be chained onto. These two are FOUNDRY's
   * words for a thing every queue has: the tree draws them itself, on a fixed
   * pair (`HostNodeAction`), so that a failed card has a way out of it without
   * the host having had to think of registering one. Routing them through
   * `host-ops:invoke` would have meant inventing operation ids on this side and
   * hoping no host ever used the same string.
   *
   * THE REJECTION IS DELIBERATELY NOT CAUGHT, exactly as with `invoke`: this is a
   * button, the tree says the host's sentence where the button was, and a button
   * that appears to do nothing is the one outcome this socket must not have. A
   * host that registered no callback is refused BY NAME here rather than silently
   * — though the tree does not draw the buttons at all in that case, so the only
   * way to see it is a renderer and a host that disagree.
   */
  ipcMain.handle(
    'host-ops:node-action',
    (_event, projectDir: string, nodeId: string, action: HostNodeAction) =>
      actOnHostNode(projectDir, nodeId, action),
  );

  /*
   * ── THE STATUS CHIP — the one thing a host may draw in this window's chrome ─
   *
   * WHAT THE HOST IS DOING NOW, AND WHETHER A CLICK ON IT GOES ANYWHERE.
   *
   * Both in one answer, on `host-ops:offers`' precedent exactly: they are read
   * out of one registration, they are wanted in the same breath by the same
   * component, and a second channel for the probe would be one more name for
   * BookForge's collision keeper to audit for a boolean. Null standalone and
   * null for a host that has pushed nothing, which is the chip not being drawn
   * at all — the chrome is Foundry's alone unless somebody says otherwise
   * (shared/host-ops.ts, `HostStatus`).
   */
  ipcMain.handle('host-ops:status', () => ({
    status: hostStatus(),
    openable: hostOpensStatus(),
  }));
  /*
   * THE CHIP WAS CLICKED. What that means is the host's own — raising its queue
   * window is the obvious reading and Foundry neither requires nor inspects it
   * (`FoundryHost.onStatusOpen`).
   *
   * IT REFUSES BY NAME for a host that registered nothing, and the renderer
   * should never send it in that case: the chip is drawn WITHOUT a press when
   * `openable` is false, so the only way to reach this sentence is a renderer
   * and a host that disagree about what was registered. Said out loud rather
   * than returned quietly, on `host-ops:invoke`'s rule.
   */
  ipcMain.handle('host-ops:status-open', () => openHostStatus());

  ipcMain.handle('dialog:open-document', () => promptForDocument());

  // A drop hands the renderer a path (webUtils, in the preload); main decides
  // whether it is openable. The renderer never gets to assert that a file is.
  ipcMain.handle('document:open-path', (_event, candidate: string) => openDocument(candidate));

  /**
   * A whole open document's bytes, for the app's own PDF viewer.
   *
   * IPC RATHER THAN `fetch` ON `foundry-file://`, and it is the renderer's own
   * policy that decides it: the page is served under `connect-src 'self'`, which
   * refuses a fetch to any other scheme — and widening the document's policy so
   * it may connect to a scheme that serves whole files off disk is a bigger
   * hole than this handler is, for a viewer that has to hold the file in memory
   * anyway. (The scheme once had a whole-file route for Chromium's viewer; it
   * went with the viewer.) The gate is `admitted`, the same one everything that
   * serves a document asks — a second DOOR, not a second rule.
   *
   * BUFFERED, WHOLE, deliberately: pdf.js is handed a buffer and searches every
   * page of it, so the scan is resident regardless and streaming would only add
   * a second copy.
   */
  ipcMain.handle('document:read-bytes', async (_event, target: string) => {
    const resolved = admitted(target);
    if (resolved === null) {
      throw new Error(`${target} was never opened in this app.`);
    }
    return fsp.readFile(resolved);
  });

  /**
   * Save a copy of an open document where the user says — the PDF tab's Save.
   *
   * DIALOG AND COPY IN ONE HANDLER, where the EPUB flow splits them. A book is
   * repacked from a working copy that can still be changing, so its grant and
   * its write are separate steps with a grant list between them; a PDF is one
   * finished file this app never edits, and the dialog's answer can be spent on
   * the spot. The source is still gated by `admitted` — the dialog authorizes
   * the DESTINATION, and only the user's own choice of one, but what may be
   * read out of the workspace remains the allow-list's question.
   */
  /**
   * SAVE A COPY OF AN EXPORT — the door the finished shelf row presses.
   *
   * Gated on the FINAL TRAY rather than the opened-documents allow-list,
   * because an export was never "opened": it is a file this app just wrote
   * into `<project>/final/`, and membership in a project's tray is exactly the
   * claim being exercised. Anything else — a path outside every project, or
   * inside one but not in its tray — is refused; this door copies exports and
   * copies nothing else.
   */
  ipcMain.handle('export:save-copy', async (_event, target: string) => {
    const resolved = path.resolve(target);
    if (exportInTray(resolved) === null) {
      throw new Error('That file is not one of this library’s exports.');
    }
    const extension = path.extname(resolved).replace('.', '').toLowerCase();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Save a copy of this export',
      defaultPath: path.join(app.getPath('downloads'), path.basename(resolved)),
      filters: extension.length > 0
        ? [{ name: extension.toUpperCase(), extensions: [extension] }]
        : [],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

  ipcMain.handle('document:save-copy', async (_event, source: string, suggestedName: string) => {
    const resolved = admitted(source);
    if (resolved === null) {
      throw new Error(`${source} was never opened in this app.`);
    }
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    // The library, same as the book pickers: the folder the user pointed this
    // app at is where its outputs go unless they steer elsewhere.
    const library = readAppSettings().libraryDir;
    await fsp.mkdir(library, { recursive: true });
    const options = {
      title: 'Save a copy of this PDF',
      defaultPath: path.join(library, suggestedName),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    if (path.resolve(result.filePath) === resolved) {
      // Copying a file onto itself truncates it before it can be read. The
      // dialog makes this easy to do by accident — it opens on the library —
      // and the answer is a refusal, not a clever in-place no-op.
      throw new Error('That is the file itself. Pick somewhere else to put the copy.');
    }
    await fsp.copyFile(resolved, result.filePath);
    return result.filePath;
  });

  /**
   * The renderer's answer to `window:closing` — the one reply, spent once.
   *
   * `handle` rather than `on` so the renderer knows the answer arrived: without
   * it, a reply sent into a main process that had already given up waiting would
   * be indistinguishable from one that landed, and the renderer's own "the window
   * is going" state would never clear.
   */
  ipcMain.handle('window:let-go', (_event, go: boolean) => {
    answerLetGo(go === true);
  });

  /**
   * The window, closed from inside it — the ✕ pressed by the page rather than
   * by a person.
   *
   * ── Why the renderer needs a door at all ────────────────────────────────────
   *
   * Because HOSTED, RUNNING OUT OF TABS IS THE END OF THE WINDOW. Standalone,
   * closing the last document leaves the workbench standing in the project it
   * was in, and Home under that is where the app legitimately begins; hosted,
   * the book list is BookForge's and falling through to a second project picker
   * is the workbench turning into a copy of the app around it (user ruling,
   * 2026-08-16). The moment is the renderer's — main knows which files were ever
   * opened, not which documents are open NOW, the same asymmetry `window:closing`
   * exists for — and the act is main's, because a page cannot close the window
   * it is drawn in.
   *
   * IT IS THE ✕'S OWN PATH AND NOT A SHORTCUT PAST IT. `close()` re-enters the
   * window's `close` handler, which runs `letTheWindowGo` and asks the documents
   * through `window:closing` exactly as a pointer on the ✕ would. With nothing
   * open that answer is yes and arrives immediately; if something is still open
   * — anything that ever calls this with tabs left — the question is asked, and
   * a person who says keep it keeps their window.
   *
   * NO WINDOW IS NOT AN ERROR HERE. A page invoking this during teardown, after
   * the window it was drawn in has already gone, is asking for a state that has
   * arrived; `foundryWindow()` is null in exactly that case and the door is a
   * no-op rather than a throw into a renderer that is being destroyed.
   */
  ipcMain.handle('window:close', () => {
    foundryWindow()?.close();
  });

  /**
   * The warning before a tab with something to lose closes.
   *
   * Worded around what is ACTUALLY at risk. Closing a tab deletes nothing on
   * disk — the project keeps every byte of the book and Home still lists it — so
   * what a close can cost is a stack of changes nobody applied, and nothing
   * else. Telling a user their work is
   * about to be destroyed when it is not would teach them to distrust the next
   * warning that matters.
   *
   * ── TWO REASONS, ONE QUESTION ───────────────────────────────────────────────
   *
   * A book pane can hold changes nobody applied, and a book's filed copy can be
   * out of date. They are two different states and this app has already ruled that
   * a closing document is asked about once (`closeShowing`,
   * core/documents.service.ts): a second card on top of the first is the app
   * arguing with an answer it already has.
   *
   * NEITHER IS A LOSS ANY MORE, and the first one used to be. Closing over a
   * stack destroyed it until 2026-08-22; it is now written to a sidecar as it is
   * made and comes back at the same step, so this card asks whether to RECORD the
   * work rather than warning that it is about to go. See `aboutTheEdits` for the
   * whole of that reversal.
   *
   * IT WAS THREE. The third — "no copy of this exists anywhere you chose" — went
   * with the user's own ruling (*"only pop up a confirmation alert if changes have
   * been made"*), and the fourth, the block editor's uncommitted CURATION, went
   * with the block editor itself: there is one editing surface now and its
   * unapplied work is the stack, which is the first arm below.
   */
  ipcMain.handle(
    'document:confirm-close',
    (_event, warning: CloseWarning): Asked<CloseAnswer> => ({
      kind: 'ask',
      /*
       * THE STACK LEADS WHEN THERE IS ONE, ahead of the other, and the reason
       * survived the reversal that changed everything else on this card. It used
       * to lead because it was the only loss: unapplied changes were in memory
       * and closing destroyed them, while the filed copy was merely old. They are
       * on disk now (`savePendingStack`) and closing destroys nothing — but the
       * stack is still the sentence somebody needs first, because it is the one
       * that decides whether the next book this app makes is the book they are
       * looking at. "Your copy is out of date" over the top of that would bury the
       * question under the footnote.
       */
      question: warning.edits !== null && warning.edits > 0
        ? aboutTheEdits(warning, warning.edits)
        : aboutTheCopy(warning),
    }),
  );

  /**
   * THE CARD ABOUT A STACK NOBODY APPLIED — and it no longer says the work will
   * be lost, because that stopped being true.
   *
   * ── The ruling this card used to report, and the ruling that replaced it ────
   *
   * It used to say, truthfully, that closing threw the stack away: the stack was
   * a LIFO in memory and nothing else, "Apply writes and clears; closing without
   * applying scraps it" (docs/RENDERER.md §3). Then a real project lost real work
   * to it — the pane's changes were never applied, the export silently lacked
   * them, and the stack went with a window that closed without this card ever
   * being drawn (user report, 2026-08-21). Owen reversed the ruling the next day:
   * unapplied work is never silently scrapped. It is written to a sidecar as it
   * is made (`savePendingStack`, electron/book.ts) and put back the next time the
   * book is opened at the same step.
   *
   * SO THE FRIGHTENING SENTENCE WOULD NOW BE THE LIE, and it is gone. What is
   * left is a card about a CHOICE rather than about a loss — record these as a
   * step now, or leave them held and come back to them — plus the one button that
   * still destroys, which is the one place in this app allowed to.
   *
   * WHICH IS WHY THE OFFER IS STILL A BUTTON. A dialog whose only route to
   * recording the work is *cancel, find Apply, close again* has made the person
   * do the app's job. Apply is offered first and is what Enter takes; Discard is
   * last and wears the error colour, so the button that destroys has to be aimed
   * at — and now it is the ONLY thing that destroys, which is what makes it
   * meaningful.
   *
   * NO COUNT OF WHAT KIND. "5 changes" is what the card says, not "3 strikes, a
   * relabel and an edit" — the changes themselves are on the paper behind the
   * dialog, in the cancel marks and the changed paragraphs, and that is a better
   * description of them than a tally of verbs would be.
   */
  function aboutTheEdits(warning: CloseWarning, edits: number): AppQuestion {
    const changes = edits === 1 ? '1 change' : `${edits} changes`;
    /*
     * The filed copy, when this tab owes that as well. Kept to a clause and put
     * last: it is the smaller loss, and the buttons are about the stack.
     */
    const alsoTheCopy = warning.modified
      ? [
        'The copy you filed for yourself is also older than this one, and closing does not bring '
        + 'it up to date. Export the book again to replace it.',
      ]
      : [];
    return {
      title: 'Apply these changes before closing?',
      message: `“${warning.title}” has ${changes} that have not been applied.`,
      detail: [
        'Changes made on the book are held while you work so that taking one back is instant, and '
        + 'they are not written down as a step until you apply them. Closing keeps them held: they '
        + 'come back the next time you open this book at the same step.',
        'What they are NOT part of until you apply them is anything made from this book — an '
        + 'export, a translation or a rewrite is built from the recorded steps, so it would be made '
        + 'without them.',
        'Applying now records all of them as one row in Steps, which you can stand on, branch from '
        + 'and delete afterwards. Discarding is the one thing that throws them away for good.',
        ...alsoTheCopy,
      ],
      choices: [
        { key: 'save', label: APPLY },
        { key: 'keep', label: KEEP },
        { key: 'close', label: DISCARD, danger: true },
      ],
      preferred: 'save',
      dismissed: 'keep',
      checkbox: null,
    };
  }

  /**
   * The filed copy is older than the book in front of you — the one thing left
   * for this half of the question to say.
   *
   * ── The sentence that died here, and why it could not stay ──────────────────
   *
   * This function used to fork on `warning.unsaved` and say, for a book with no
   * copy anywhere the user chose, that nothing else on the machine knew about it.
   * `questionBefore` (core/documents.service.ts) no longer asks anything for a bare
   * `unsaved`, so that branch became unreachable the moment the ruling landed —
   * and it was also, by then, untrue: the book is in its project, Home lists it,
   * and the way a copy leaves this app is the export modal (docs/WORKBENCH.md
   * §6). A branch that can never run, phrased as advice about a gesture that no
   * longer exists, is worse than no branch at all, so both went.
   *
   * What is left is a real state with a real remedy: a copy the person themselves
   * put somewhere, which this book has moved on from.
   */
  function aboutTheCopy(warning: CloseWarning): AppQuestion {
    return {
      title: 'Close with edits unsaved?',
      message: `“${warning.title}” has been edited since you saved it.`,
      detail: [
        'Every edit went straight into Foundry\'s working copy of the book as you made it, so '
        + 'nothing here is lost — the project keeps it and Home will still list it.',
        'The copy you filed for yourself is the older version, and closing does not bring it up '
        + 'to date. Export the book again to replace it.',
      ],
      // The safe answer is FOCUSED and the ending one is LAST, which is this
      // app's rule for every card that can destroy something: Enter cannot
      // reach the button that ends the session's way back.
      choices: [
        { key: 'keep', label: KEEP },
        { key: 'close', label: CLOSE, danger: true },
      ],
      preferred: 'keep',
      dismissed: 'keep',
      checkbox: null,
    };
  }

  /**
   * "Read this book again?" — the queue confirm, `BANK-LIFECYCLE.md` §3.
   *
   * MAIN'S QUESTION AND THE APP'S OWN CARD, like `confirmClose` and like every
   * other question this app asks. It was a native box, and the box's own defence
   * was that it is modal to the window — the next thing that happens after a yes
   * is an enqueue, and a question the user can click behind is a question they
   * can answer twice. The card is modal to the window in the only sense that
   * matters here: it is a full-window scrim at the top of the stack, so the Add
   * button under it cannot be reached while it is up.
   *
   * ONE CARD FOR THE WHOLE QUESTION. The replaced reading and every step that goes
   * stale with it are one cost and are asked about once; a second question listing
   * the casualties would be this app arguing with an answer it already has, which
   * is the rule `closeShowing` established for a closing document.
   *
   * THE SENTENCES ARE THE RENDERER'S, and this is the only question here where
   * that is true. They are read off the step ledger, the renderer already mirrors
   * it, and the composition is a pure shared function held down by tests
   * (`reReadAhead`, shared/reread.ts) — so main asking the disk again would be a
   * round trip for a decision that is already made and already checked. What stays
   * main's is what has always been main's: the shape of the question, the buttons,
   * and what a press of one of them means.
   *
   * ANYTHING UNRECOGNISED IS A NO. A yes here spends hours of GPU and replaces a
   * bank; a card somebody dismissed is not somebody agreeing to that — which is
   * why `dismissed` names the leave-it answer rather than the proceed one.
   *
   * THE CARD DOES NOT CLOSE THE OCR DIALOG IT IS ASKED FROM. That is the
   * renderer's rule and it is written down where it is enforced
   * (`ConfirmService.put`), but it is this question that needed it: the ask comes
   * from inside the OCR card, and a "no" that took the OCR card away with it would
   * answer a question nobody asked.
   */
  ipcMain.handle(
    'reading:confirm-re-read',
    (_event, prompt: ReReadPrompt): Asked<ReReadAnswer> => ({
      kind: 'ask',
      question: {
        /*
         * THE HEADLINE IS THE PROMPT'S OWN, AND IT IS SAID ONCE. The native box
         * had a title bar and a message and this question filled both with the
         * same sentence, which cost nothing when one of them was window chrome
         * and would be a card saying "Read this book again?" twice.
         */
        title: prompt.message,
        message: prompt.detail,
        detail: [],
        choices: [
          { key: 'leave', label: RE_READ_CANCEL },
          { key: 'again', label: RE_READ_PROCEED, danger: true },
        ],
        preferred: 'leave',
        dismissed: 'leave',
        checkbox: null,
      },
    }),
  );

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
    async (_event, inputPath: string, kind: ConversionKind, from?: string) => {
      const aim = await aimedAt(inputPath, from);
      return planExport(inputPath, kind, aim.deferral === undefined ? aim.at : aim.deferral.landed, aim.deferral);
    },
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
    async (_event, inputPath: string, targetLanguage: string, from?: string) => {
      const source = admitted(inputPath);
      if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
      // THE ROW THIS IS AIMED AT — the position, a landed step the tree pressed on,
      // or a promise. See `aimedAt` and the export door above, where the widening
      // is argued in full.
      const aim = await aimedAt(source, from);
      const plan = await planTranslation(source, targetLanguage, aim.at, aim.deferral);
      return { ...plan, inputPath: plan.sourcePath };
    },
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
    async (_event, inputPath: string, mode: RewriteMode, from?: string) => {
      const source = admitted(inputPath);
      if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
      const aim = await aimedAt(source, from);
      const plan = await planSimplification(source, mode, aim.at, aim.deferral);
      return { ...plan, inputPath: plan.sourcePath };
    },
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
  ipcMain.handle('workspace:plan-clean', async (_event, inputPath: string, from?: string) => {
    const source = admitted(inputPath);
    if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
    const aim = await aimedAt(source, from);
    const plan = await planCleanup(source, aim.at, aim.deferral);
    return { ...plan, inputPath: plan.sourcePath };
  });

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
   * text ever reaches a hypothesis — needed a new true form rather than a quiet
   * deletion. It is this: free text becomes a category ONLY by being written
   * into the user's own settings file through the door below, where it is
   * slugged into `customCategoryId`'s shape, length-capped and collision-checked
   * (`clampAnalysisCategories`); and this handler admits a name only if that file
   * already holds it. So the path from a text box to a prompt runs through a
   * deliberate act of saving, and the string that arrives here is always one main
   * itself minted.
   */
  ipcMain.handle('workspace:plan-analysis', async (_event, inputPath: string, categories: string[]) => {
    const source = admitted(inputPath);
    if (source === null) throw new Error(`${inputPath} was never opened in this app.`);
    const asked = Array.isArray(categories) ? categories : [];
    const mine = readAppSettings().analysisCategories.map((one) => one.id);
    const known = [...ANALYSIS_CATEGORY_IDS, ...mine];
    const unknown = asked.filter((one) => !known.includes(one));
    if (unknown.length > 0) {
      throw new Error(
        `This build does not know a category called “${unknown[0]}”, so it cannot analyse against it.`,
      );
    }
    /*
     * IN PLAN ORDER, ALWAYS, and normalised here rather than trusted from the
     * window. The list is the step's own QUESTION (`PARAMS_OF.analysis`) and
     * `identityOf` compares it as JSON — so two spellings of one checklist would
     * be two questions, and a re-analysis would branch beside the row it meant to
     * refresh. One order, decided in one place, on the engine's own ordering —
     * with the user's own categories after the built-ins, in the order their
     * settings file holds them, which is the order they added them.
     */
    const ordered = known.filter((one) => asked.includes(one));
    if (ordered.length === 0) {
      throw new Error('Pick at least one category — an analysis with nothing to look for finds nothing.');
    }
    const plan = await planAnalysis(source, ordered);
    return { ...plan, inputPath: plan.sourcePath };
  });

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

  /** Home's primary listing: one row per book, expanding to what is in it. */
  ipcMain.handle('projects:list', () => listProjects());

  /**
   * Delete a project — the whole folder, off the disk, for real.
   *
   * THE ONE PLACE IN THIS APP WHERE SOMETHING IS REALLY DESTROYED. Everywhere
   * else "nothing is ever deleted" holds (electron/projects.ts), because
   * everywhere else it is FOUNDRY deciding that a person is finished with
   * something it made. Here it is the person, about their own folder, having
   * been told in words what is in it. A Delete button that quietly rotated the
   * project into `archived-<stamp>/` would be a lie twice over: the library
   * would go on filling up, and the folder the user pressed a button to be rid
   * of would still be there for them to find and remove by hand.
   *
   * THREE THINGS ARE REFUSED BEFORE THE QUESTION IS EVEN ASKED, all of them BY
   * NAME (ARCHITECTURE §8):
   *
   *   1. a path that is not a project directory — `inspectProject` proves it is
   *      a DIRECT CHILD of `projectsDir()` before it reads a byte, and
   *      `deleteProject` proves it again at the `rm`. That check is the whole
   *      security boundary here and its reasoning is written down where it
   *      lives; this handler must never be the thing that decides a path is
   *      safe;
   *
   *   2. a book from this project open in a tab. The renderer checks its own tab
   *      list first, because it is the side that knows the tab's title and can
   *      say a sentence worth reading — but a renderer's word is not an
   *      authorization (the `admitted` precedent, above), so main asks its OWN
   *      record of what is unpacked. Deleting a working tree out from under a
   *      live book leaves the protocol handler serving chapters that are gone,
   *      and on Windows the delete stops halfway on the first locked file and
   *      leaves a project that is neither there nor erased — worse than either;
   *
   *   3. the user themself, at the dialog, which defaults to Cancel.
   *
   * MAIN'S NATIVE BOX, like `confirmClose` and like every other question this
   * app asks: modal to the window, so the next gesture cannot race it, and not a
   * rectangle drawn over a page that can scroll out from under it.
   *
   * The sentence names the book, names the directory, and says what is inside —
   * above all the READINGS BANK, because that is the only thing in a project
   * that cost GPU-hours and cannot be rebuilt from anything else on disk. A
   * scan re-imports, a working tree re-unpacks, an edition rebuilds; a page the
   * model read is read again or not at all.
   *
   * Returns the sentence for the notice strip, or null when the user said no.
   * A refusal THROWS, so it reaches the same strip through the renderer's
   * ordinary catch and is never mistaken for a cancel.
   */
  /*
   * DESCRIBE, THEN DELETE — two calls where there used to be one.
   *
   * The question moved to the renderer, and the split is what makes that safe.
   * `projects:describe` composes the warning and PROVES the delete is currently
   * allowed; `projects:delete` proves it again and does the work. Nothing about
   * the second call trusts the first: a renderer that skipped straight to the
   * delete meets exactly the same refusals, because the checks live in the
   * function that erases rather than in the one that asks.
   *
   * The sentences stay HERE, whole. Main is the only side that knows the size on
   * disk, the readings bank's page count and whether a copy was filed, and those
   * are what make the warning worth reading — a renderer composing its own would
   * arrive at "Are you sure?" within a month.
   */
  /**
   * The two refusals, in one place because both callers owe both of them.
   *
   * NEITHER IS ADVISORY. `describe` runs them so the app does not put a warning
   * on screen for something it is going to refuse a click later; `delete` runs
   * them because that is where the authorization has to be. A renderer's word
   * about what is open or what is queued is not a fact main may act on when the
   * action is a recursive delete.
   */
  function refuseProjectDelete(project: { dir: string; title: string }): void {
    refuseBusyJob(project);
  }

  /**
   * The narrower refusal: a job writing into this folder, and nothing else.
   *
   * IT IS SPLIT OUT BECAUSE A DOCUMENT DELETE OWES ONLY THIS HALF. Deleting the
   * whole project while any book from it is open is a working tree pulled out
   * from under a reader; deleting ONE generated file while a DIFFERENT document
   * of the same project is open is the ordinary case — read the scan, throw away
   * the EPUB you did not like — and refusing it because something else in the
   * folder happened to be open would make the button useless exactly when it is
   * wanted. The renderer closes the file's own tab before asking (open-documents).
   *
   * THREE CALLERS NOW, AND THEY SHARE THE FACT RATHER THAN THE SENTENCE. What is
   * the same for all of them is finding the job: which run is about to write into
   * this folder, and whether it is going or waiting. What differs is the
   * CONSEQUENCE — a project delete erases the folder the engine is writing into, a
   * step delete destroys a payload it may be in the middle of producing — so the
   * clause after "so" is the caller's, and everything before it is written once
   * here. A second copy of the job search is how the day comes that one of them
   * learns about a new job state and the other does not.
   */
  function refuseBusyJob(
    project: { dir: string; title: string },
    /** The clause after "so", ending in what to do about it. */
    consequence = `“${project.title}” cannot be deleted — the engine is writing into that `
      + 'folder from another process, and erasing it underneath would leave half a project on '
      + 'disk and a run writing into nothing. Cancel it in the shelf first, then delete.',
  ): void {
    /*
     * A JOB WRITING INTO IT IS THE SAME HAZARD AS AN OPEN BOOK, and worse in
     * one way: the engine is a separate process holding a file open in
     * `generated/`, so the recursive remove fails PART WAY on Windows and
     * leaves a project half erased — while the run carries on writing into a
     * directory the catalogue no longer describes.
     *
     * Every state but `held`, `queued` and `running` is finished with the
     * folder: a done, failed or cancelled row names a path nothing is holding.
     *
     * `held` counts even though nothing is writing yet. It is a job CONFIGURED
     * to write here — the output path is already chosen and the readings bank
     * already named — so deleting the folder under it would leave a row in the
     * shelf that fails the moment somebody presses Start, for a reason nothing
     * in the error would connect to a project they erased ten minutes earlier.
     */
    const busy = queue.listJobs().find((job) =>
      (job.state === 'running' || job.state === 'queued' || job.state === 'held')
      && within(project.dir, job.outputPath));
    if (busy !== undefined) {
      throw new Error(
        `A ${busy.kind} job is ${busy.state === 'running' ? 'running' : 'waiting to run'} into `
        + `“${project.title}” right now, so ${consequence}`,
      );
    }
  }

  /**
   * The warning, composed where the facts are.
   *
   * Every sentence the native box used to carry, kept verbatim — the size on
   * disk, the readings bank, the filed copy, and the flat statement that this is
   * a real delete. The only thing that changed is that it comes back as data
   * instead of being drawn by the OS.
   */
  function describeProject(project: ProjectInventory): DeletionPrompt {
    /*
     * THE BANK IS THE COST RULE IN ITS PUREST FORM (`ProjectStep.costly`). It is
     * the stored result of the expensive pass — which is exactly why a rerun is
     * free, and exactly why nothing in this app ever sweeps it. Erasing it is
     * the one loss in a project delete that no amount of time gets back.
     */
    const bank = project.readings > 0
      ? `It holds a readings bank of ${project.readings.toLocaleString()} pages the model has `
        + 'already read. That is hours of GPU, it is the one thing in here that cannot be made '
        + 'again from anything else on this disk, and once it is gone a future conversion of this '
        + 'book pays for every page from scratch.'
      : 'There is no readings bank in it, so nothing in here costs GPU-hours to make again.';
    /*
     * AND THE CURATION, which is the one thing in here that is IRREPLACEABLE
     * rather than merely expensive (`ProjectStep.retention`). A bank can be read
     * again for money and hours. A person going through four hundred pages
     * saying which blocks are running heads and where the chapters start cannot
     * be reproduced by anything, at any price, and it is quoted before the bank
     * for exactly that reason.
     */
    const curation = project.amendments > 0
      ? `It also holds ${project.amendments.toLocaleString()} corrections you made by hand about `
        + 'the blocks on those pages — strikes, categories, wording and chapter starts. Nothing '
        + 'can make those again: they are judgements about the book, not output.'
      : '';
    const filed = project.filed
      ? ' The copy you filed into this project\'s own folder is inside it and goes with it.'
      : '';
    const made = project.documents === 0
      ? 'nothing has been made from it yet'
      : project.documents === 1
        ? 'the one document Foundry has made from it'
        : `the ${project.documents} documents Foundry has made from it`;
    return {
      message: `“${project.title}” will be deleted from this computer.`,
      detail: [
        /*
         * THE IMPORT LEADS, because it is the most expensive thing in the folder
         * and the only one that is IRREPLACEABLE rather than merely costly
         * (`ProjectStep.costly`). A model pass can be run again for money and
         * hours; the file the user handed over came from somewhere only they
         * know, and Foundry treats it as the only copy in the world.
         */
        'The file you imported goes with it. Foundry keeps no other copy of it and cannot '
        + 'fetch it again — wherever you got it from is the only place it still exists.',
        `${project.dir} and everything under it goes: ${made}, every working copy and every `
        + `edit in them, and the undo history. ${sizeOnDisk(project.bytes)} in all.${filed}`,
        ...(curation.length > 0 ? [curation] : []),
        bank,
        'This is a real delete. The folder is removed from the disk — it is not moved aside, '
        + 'Foundry keeps no copy of it anywhere else, and there is nothing that will bring it back.',
      ],
      confirm: 'Delete this project',
    };
  }

  ipcMain.handle('projects:describe', async (_event, dir: string) => {
    const project = await inspectProject(dir);
    refuseProjectDelete(project);
    return describeProject(project);
  });

  ipcMain.handle('projects:delete', async (_event, dir: string) => {
    const project = await inspectProject(dir);
    refuseProjectDelete(project);

    await deleteProject(project.dir);
    // The recents list is keyed by file and a project is a folder of them, so
    // every row pointing inside goes with it. Otherwise the app would keep a
    // last-opened time for — and `listProjects` would keep dating a row by — a
    // book whose bytes it destroyed a moment ago.
    forgetRecentsUnder(project.dir);
    return `Deleted “${project.title}”. ${project.dir} and everything in it is gone from this computer.`;
  });

  /**
   * One document out of a project: what would happen, and then doing it.
   *
   * THE ORIGINAL IS NOT DELETABLE ON ITS OWN, and that is the whole reason this
   * pair describes before it acts. Every other document in a project was made
   * FROM the original; erasing it leaves a folder of outputs with no source,
   * which is not a project any more. So `describe` reports `original: true` and
   * hands back the PROJECT's warning, and `delete` refuses that path outright —
   * the renderer is expected to run the project delete instead, and a renderer
   * that ignored the flag gets a sentence rather than a half-emptied folder.
   *
   * `shared/original.ts` decides which document that is, and both sides import
   * it: the flag main sets and the row the nav draws come from one rule.
   *
   * The listing comes from `listProjects`, which is the one function that says
   * what a project contains — the same answer Home and the side nav are drawn
   * from, so a row the user can see is a row this can find.
   */
  async function findDocument(filePath: string): Promise<{
    project: ProjectSummary;
    document: ProjectDocument;
  }> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      const document = project.documents.find((row) => fold(row.path) === target);
      if (document !== undefined) return { project, document };
    }
    throw new Error(
      `${filePath} is not a document in any of Foundry's projects, so there is nothing here to `
      + 'delete. Files outside the library are the file manager\'s business, not this app\'s.',
    );
  }

  /**
   * The same question asked of the TRAY, which is a different catalogue.
   *
   * ── The bug this closes ─────────────────────────────────────────────────────
   *
   * The library tree draws a ✕ on export rows, and every one of them threw:
   * `findDocument` searches `project.documents` — the CHAIN, what each step
   * produced — while an export row comes from `manifest.final` by way of
   * `filedDocuments`. Two catalogues, and the delete only knew one, so pressing
   * the ✕ on a file this app had just made produced "is not a document in any
   * of Foundry's projects" — a sentence written for a path somebody typed from
   * outside the library, shown for a row the app drew from its own manifest.
   *
   * ── Why a separate door instead of teaching `findDocument` about final/ ─────
   *
   * Because an export is not a document in the sense the delete pair means. It
   * has no steps, no retention, no origin; it can never be the book the project
   * is built on; nothing was made FROM it. Folding it into the document lookup
   * would put a row in front of `isBook`, `documentAssets` and the original's
   * refusal — three questions that have no answer for a file in the tray — and
   * the first one to guess would be a bug nobody could see coming.
   *
   * `final/` is the user's own tray (`projects.ts`, `filedDocuments`): they may
   * have already moved it onto a reader or deleted it themselves, which is why
   * a row whose file has gone is a REMOVAL and not an error.
   */
  async function findExport(filePath: string): Promise<{
    project: ProjectSummary;
    made: ProjectFinal;
    label: string;
  } | null> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      for (const made of project.exports) {
        // Whole paths, never basenames — this project holds `generated/Book.pdf`
        // and `final/Book.pdf` at once, and the layer is the only thing telling
        // them apart. The oldest house rule in this codebase.
        if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
        return { project, made, label: path.basename(made.file) };
      }
    }
    return null;
  }

  /**
   * And the same question asked of the FACSIMILES, which is a third catalogue —
   * or rather a third listing, since nothing catalogues these at all.
   *
   * ── The same bug, one row further down the tree ─────────────────────────────
   *
   * The nav draws a ✕ on facsimile rows exactly as it draws one on exports, and
   * every one of them threw the sentence written for a path somebody typed from
   * outside the library. A facsimile is in NEITHER of the two lookups above it:
   * `project.documents` is the chain and `project.exports` is `manifest.final`,
   * while `ProjectSummary.facsimiles` is composed by scanning `generated/` for
   * the name each read step's id makes (`facsimilesOf`, electron/projects.ts).
   * Three listings, and the delete knew two.
   *
   * ── Why a third door and not a branch in either of the others ───────────────
   *
   * `findExport`'s argument, and it applies harder here. An export at least has a
   * row in the manifest; a facsimile has nothing — no steps, no retention, no
   * origin, nothing made FROM it, and no catalogue entry to strike out. Every
   * question the document path asks (`isBook`, `documentAssets`, the original's
   * refusal) is a question with no answer for a page-for-page reprint, and the
   * first one to guess would be the bug nobody sees coming.
   *
   * AND IT IS THE CHEAPEST THING IN THE PROJECT TO LOSE, which is why its card is
   * one line shorter than an export's: the bank it reprints is kept whatever
   * happens, so the reprint is seconds of offline arithmetic away for as long as
   * the reading exists.
   */
  async function findFacsimile(filePath: string): Promise<{
    project: ProjectSummary;
    made: ProjectFacsimile;
    label: string;
  } | null> {
    const target = fold(filePath);
    for (const project of await listProjects()) {
      for (const made of project.facsimiles) {
        // Whole paths with their layer, never basenames — the same rule spelled
        // out above `findExport`, and a facsimile lives in `generated/` beside a
        // cast and a rotated predecessor of itself.
        if (fold(path.join(project.dir, ...made.file.split('/'))) !== target) continue;
        return { project, made, label: path.basename(made.file) };
      }
    }
    return null;
  }

  ipcMain.handle('documents:describe', async (_event, filePath: string): Promise<DocumentDeletion> => {
    /*
     * THE TRAY IS ASKED FIRST, and the question it gets is its own. Removing an
     * export takes the file and its row and nothing else: no chain to unpick, no
     * working tree, no history, and nothing was ever made from it. Saying so in
     * one sentence is the honest card — the document card's paragraph about the
     * readings bank surviving would be reassurance about a danger that was never
     * on the table.
     */
    const filed = await findExport(filePath);
    if (filed !== null) {
      // `final/` is the user's own tray, so the file may legitimately not be
      // there — moved onto a reader, handed to somebody, deleted by hand. That
      // is a row to clear, not an error to raise, and it changes the sentence.
      const gone = await fsp.access(filePath).then(() => false, () => true);
      return {
        prompt: {
          message: `“${filed.label}” will be removed from “${filed.project.title}”.`,
          detail: [
            gone
              ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
                + 'clears the row that still lists it.'
              : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
            'Nothing else changes: this is one of the finished documents you exported, and the '
            + 'book, its readings and every step it was made from stay exactly as they are. You '
            + 'can export it again at any time.',
          ],
          confirm: gone ? 'Remove this row' : 'Delete this export',
        },
        original: false,
        projectDir: filed.project.dir,
        missing: gone,
      };
    }

    /*
     * THEN THE REPRINTS, and their card is the shortest one in this app because
     * there is genuinely almost nothing to warn anybody about. A facsimile is a
     * rendering of a bank that is kept whatever else happens: no step points at
     * it, nothing was made from it, and the reading it reprints is untouched by
     * its going. Saying so plainly is the honest card — the document card's
     * paragraph about the bank surviving reads as reassurance about a danger that
     * was never on the table, which is how people learn to skip these.
     */
    const reprint = await findFacsimile(filePath);
    if (reprint !== null) {
      // The listing stats before it draws a row, so this is the window between
      // that stat and this click — somebody tidying `generated/` by hand, a
      // window holding a tree from a minute ago. A row to clear, not an error.
      const gone = await fsp.access(filePath).then(() => false, () => true);
      return {
        prompt: {
          message: `“${reprint.label}” will be deleted from “${reprint.project.title}”.`,
          detail: [
            gone
              ? 'That file is no longer on the disk — moved or deleted somewhere else — so this '
                + 'clears the row that still lists it.'
              : 'The file is deleted from the disk. Foundry keeps no copy of it anywhere else.',
            'The readings bank and every step in this project stay exactly as they are. This is '
            + 'the pages of one reading reprinted, nothing is made from it, and you can make it '
            + 'again from that reading at any time — it costs seconds and no GPU.',
          ],
          confirm: gone ? 'Remove this row' : 'Delete this facsimile',
        },
        original: false,
        projectDir: reprint.project.dir,
        missing: gone,
      };
    }

    const { project, document } = await findDocument(filePath);
    const inventory = await inspectProject(project.dir);

    if (isBook(project.documents, document.path, project.dir)) {
      // The original's delete IS the project's, so it owes the project's
      // refusals — including the open-book one this file's own delete does not.
      refuseProjectDelete(inventory);
      const prompt = describeProject(inventory);
      return {
        prompt: {
          ...prompt,
          message: `“${document.label}” is the original this project is built on.`,
          detail: [
            'Deleting it deletes the whole project — every document in this folder was made from '
            + 'it, and what would be left is a set of outputs with nothing they came from.',
            ...prompt.detail,
          ],
        },
        original: true,
        projectDir: project.dir,
        missing: document.missing,
      };
    }

    refuseBusyJob(inventory);
    const gone = document.missing
      ? 'That file is already gone from the disk; what is left is its row in this project\'s '
        + 'catalogue, and this clears it.'
      : `${document.path} is removed from the disk. It is not moved aside and Foundry keeps no `
        + 'copy of it anywhere else.';

    /*
     * WHAT ELSE GOES, NAMED. A delete that quietly takes more than the thing it
     * was pointed at is the exact surprise these cards exist to prevent — and
     * "5 earlier versions" is not a detail, it is most of what is about to be
     * removed by weight. Where nothing extra goes, nothing extra is said: a
     * sentence listing zero of three things reads as boilerplate and teaches
     * people to skip the paragraph that matters.
     */
    const extras = await documentAssets(document.path);
    const also: string[] = [];
    if (extras.archivedVersions > 0) {
      also.push(extras.archivedVersions === 1
        ? 'the one earlier version of it a rerun set aside'
        : `the ${extras.archivedVersions} earlier versions of it that reruns set aside`);
    }

    return {
      prompt: {
        message: `“${document.label}” will be deleted from “${project.title}”.`,
        detail: [
          gone,
          ...(also.length > 0
            ? [`${sentenceList(also)} ${also.length === 1 ? 'goes' : 'go'} with it — everything in `
              + 'this project that belongs to this document and to nothing else.']
            : []),
          'The project and everything else in it stays, including the original and the readings '
          + 'bank — the hours of GPU that let this document be made again by converting the book a '
          + 'second time.',
        ],
        confirm: document.missing ? 'Remove this row' : 'Delete this document',
      },
      original: false,
      projectDir: project.dir,
      missing: document.missing,
    };
  });

  /** `a`, `a and b`, `a, b and c` — the app writes sentences, not bullet lists. */
  function sentenceList(parts: readonly string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  ipcMain.handle('documents:delete', async (_event, filePath: string) => {
    /*
     * The tray again, and asked again rather than trusted from the describe —
     * same rule as the busy-job proof below: this is the call that unlinks
     * something, and the catalogue may have moved under it.
     *
     * `deleteDocument` already does exactly the right thing with a `final/`
     * path: it strikes the row out of `manifest.final` by LAYER (`inLayer`),
     * removes the file, and sweeps nothing else, because an export has no
     * working tree, no archived predecessors and no history to sweep. Only the
     * lookup above it was blind.
     */
    const filed = await findExport(filePath);
    if (filed !== null) {
      /*
       * THE BUSY PROOF COSTS A QUEUE LOOKUP, NOT AN INVENTORY. This line paid
       * `inspectProject` for years of habit — a recursive byte-measure of the
       * whole project plus a line-count of every bank — to hand a function
       * that reads `{dir, title}` against the QUEUE. On a captured project
       * that walk is hundreds of files including a shoot's worth of
       * photographs, and through a cold antivirus it is tens of milliseconds
       * a stat: Owen pressed Delete on one EPUB and watched nothing happen
       * for thirty seconds (2026-08-23). The summary in hand already carries
       * both fields.
       */
      refuseBusyJob(filed.project);
      const removed = await deleteDocument(filePath);
      forgetRecentsUnder(filePath);
      return removed.wasMissing
        ? `Removed “${filed.label}” from “${filed.project.title}” — the file was already gone.`
        : `Deleted “${filed.label}” from “${filed.project.title}”.`;
    }

    /*
     * The reprints, asked again for the same reason the tray is: this is the call
     * that unlinks something and the listing may have moved under it.
     *
     * `deleteDocument` is already right for a `generated/` facsimile, and it is
     * right by construction rather than by luck. THE MANIFEST NEEDS NOTHING DONE
     * TO IT: a facsimile is in no list in `project.json`, so the documents filter
     * matches no chain (nothing names this file as a step's payload), and
     * `working.files` and `final` are asked only about their own layers. THE ROW
     * GOES BECAUSE THE FILE DOES: `facsimilesOf` composes the name from the read
     * step's id and stats it, so the listing is the directory's answer and a
     * deleted file is a listing with one fewer row in it the next time anything
     * asks. And the SWEEP is exactly what it should be: the archived copies of
     * this same name beside it, which for a name carrying a step's own id can
     * only be earlier reprints of that same reading.
     */
    const reprint = await findFacsimile(filePath);
    if (reprint !== null) {
      // The cheap busy proof, for the export branch's measured reason.
      refuseBusyJob(reprint.project);
      const removed = await deleteDocument(filePath);
      forgetRecentsUnder(filePath);
      return removed.wasMissing
        ? `Removed “${reprint.label}” from “${reprint.project.title}” — the file was already gone.`
        : `Deleted “${reprint.label}” from “${reprint.project.title}”.`;
    }

    const { project, document } = await findDocument(filePath);
    // Proven again, not trusted from the describe: a job can be queued between
    // the question and the answer, and this is the call that unlinks something.
    // The proof reads the queue, so it is handed the summary and not an
    // inventory — the export branch above carries the thirty seconds that
    // distinction was measured to cost.
    refuseBusyJob(project);

    if (isBook(project.documents, document.path, project.dir)) {
      throw new Error(
        `“${document.label}” is the original “${project.title}” is built on, so it cannot be `
        + 'deleted by itself — every other document in the folder was made from it. Delete the '
        + 'project instead.',
      );
    }

    const removed = await deleteDocument(document.path);
    forgetRecentsUnder(document.path);
    return removed.wasMissing
      ? `Removed “${removed.label}” from “${removed.title}” — the file was already gone.`
      : `Deleted “${removed.label}” from “${removed.title}”.`;
  });

  /*
   * ── A document's own record ──────────────────────────────────────────────
   *
   * `foundry epub-meta` and `foundry pdf-meta`, spawned exactly as `doctor` and
   * `epub-stamp` are: the engine owns the file format and this app owns the
   * question. Reading and writing are one pair of handlers rather than four,
   * because the dialog does both against the same document and a patch with no
   * fields in it IS a read.
   *
   * WHICH FILE IS MAIN'S DECISION, and the two formats prove it two different
   * ways because they arrive by two different doors. For a PDF the renderer names
   * the path it already has open, which is the WORKING PDF; it is resolved through
   * the same allow-list every other read goes through, so a renderer cannot ask
   * main to rewrite a file nobody opened. For an EPUB the renderer names a
   * FINISHED EXPORT, and an export was never opened at all — it is a file this
   * process wrote into `<project>/final/` and the renderer learned about off a row
   * in the history — so the allow-list has nothing to say about it and membership
   * in the tray is the claim being exercised instead (`exportInTray`, which
   * `export:save-copy` and `book:view` are gated on for the same reason).
   */
  /**
   * THE STEP FOR A METADATA EDIT — written after the document, and never instead
   * of it.
   *
   * ── What this is the second half of ─────────────────────────────────────────
   *
   * The write above is what the user SEES: the package or the Info dictionary
   * changes and the pane in front of them says the new title at once. This is what
   * SURVIVES it. An export is cast fresh from the bank and a working tree's package
   * is not one of its inputs, so before this existed the correction was silently
   * absent from every book the app filed afterwards (docs/WORKBENCH.md §9). The
   * payload here is what materialisation replays.
   *
   * ── The file before the step, which is the rule and not a preference ───────
   *
   * A step is a pointer at a retained payload, so a step recorded before its
   * payload exists is a row somebody can click, render from, and be shown a
   * refusal by. The uuid makes the write collision-free by construction — two Applies a
   * millisecond apart cannot land on one name — so there is no file here to
   * overwrite and nothing to serialise against.
   *
   * ── A LANDING THAT FAILS IS A CONSOLE LINE, NOT A FAILED WRITE ─────────────
   *
   * By the time this runs the document has been edited: the values are in the
   * book, visibly, and reporting failure would tell somebody their correction did
   * not happen while leaving it done. What is actually lost is the RECORD of it,
   * which is worth a named line in the terminal and is not worth turning a
   * successful edit into a refusal.
   *
   * ── Absent for two ordinary states, and neither is an error ────────────────
   *
   * A patch with no changed fields in it is a read wearing a Save button, and a
   * document outside every project — a file the user opened off their own disk —
   * has no ledger for a row to go in. Both answer undefined, and the dialog knows
   * that means there is nothing to adopt.
   */
  const landMetadata = async (
    inside: string,
    kind: MetadataPatch['kind'],
    patch: Record<string, string | undefined>,
  ): Promise<StepLedgerView | undefined> => {
    const fields: Record<string, string> = {};
    for (const [field, value] of Object.entries(patch)) {
      if (typeof value !== 'string' || value.trim().length === 0) continue;
      fields[field] = value;
    }
    const named = Object.keys(fields);
    if (named.length === 0) return undefined;
    const dir = projectDirOf(inside);
    if (dir === null) return undefined;
    try {
      const name = `${randomUUID()}.json`;
      await fsp.mkdir(metadataDir(dir), { recursive: true });
      const body: MetadataPatch = { kind, fields };
      await fsp.writeFile(path.join(metadataDir(dir), name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      // PROJECT-RELATIVE WITH FORWARD SLASHES, as every payload is: the ledger's
      // spelling of a path is not this platform's, and a payload that carried a
      // backslash would be a row no other machine could resolve.
      return await recordMetadata(dir, `metadata/${name}`, { fields: named });
    } catch (err) {
      console.error(
        `[meta] the ${kind} record was written, but the step for it could not be: `
        + `${err instanceof Error ? err.message : String(err)}. The document carries the values; `
        + 'the history does not, so anything made from here will not carry them.',
      );
      return undefined;
    }
  };

  /*
   * The PDF's path goes through `admitted` — the SAME allow-list the pdf.js
   * viewer's bytes go through, and the same function, so this door can never
   * drift from that one. A renderer that was talked into naming some other file
   * is refused here rather than by a path check that has to stay right forever.
   */
  const admittedPdf = (candidate: string): string => {
    const resolved = admitted(candidate);
    if (resolved === null) {
      throw new Error(`"${candidate}" is not a document this app has open, so its metadata is not ours to read.`);
    }
    return resolved;
  };
  ipcMain.handle('meta:read-pdf', (_event, filePath: string) =>
    readPdfMetadata(admittedPdf(filePath)));
  /**
   * The PDF a metadata WRITE may touch, which is not simply "one that is open".
   *
   * ── THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY ──────────────────────
   *
   * `admitted` answers for anything the user has opened, INCLUDING their own
   * file on their own disk — that is what it is for; it is a read gate. Handing
   * that answer to `pdf-meta --out` meant that editing the title of a document
   * in the window between opening it and the background import finishing (or in
   * any case where the import failed and the tab never moved) re-emitted the
   * user's own `E:\…` PDF through pdf-lib and renamed the result over it. A
   * whole-document rewrite of a file this app was only ever asked to LOOK at.
   *
   * So a write resolves to the project's working copy or it does not happen. An
   * unmanaged path is refused with the reason and with what to do about it,
   * rather than being quietly redirected — a metadata dialog that reported
   * success against a file the user was not looking at would be its own bug.
   *
   * ── AND `archive/` IS INSIDE THE LIBRARY AND STILL NOT WRITABLE ────────────
   *
   * `isManaged` answers true for every layer of a project on purpose (its own
   * header says so), and that was a complete gate for exactly as long as no
   * surface ever put an archived path in front of a writer. Standing on the origin
   * row now shows the untouched original (`documentAtPosition`, projects.ts), so
   * the dialog's `tab.path` can be that file — and a title edit made there would
   * re-emit the only copy of somebody's scan this program knows of through
   * pdf-lib, silently, in the one place the app promises it does not. The refusal
   * names the row rather than the folder: a step is named by the action it was.
   */
  const writablePdf = (candidate: string): string => {
    const resolved = admittedPdf(candidate);
    if (isArchived(resolved)) {
      throw new Error(
        'This is the document exactly as you imported it, which Foundry keeps and never writes to. '
        + 'Step forward off the import in the history panel and edit the copy this app works on.',
      );
    }
    if (isManaged(resolved)) return resolved;
    throw new Error(
      `"${resolved}" is your own file, outside Foundry's library, and this app does not write to `
      + 'documents it did not make. Foundry keeps a copy of every document you open — open this '
      + 'one from Home and edit that, and your original stays exactly as it is.',
    );
  };
  ipcMain.handle(
    'meta:write-pdf',
    async (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> => {
      // Resolved once and used for both halves: the write goes to the working
      // copy, and the step is filed against the project that copy is in. Asking
      // `writablePdf` twice would be two answers about one document, and the
      // refusals it makes are the ones that decide whether there is anything to
      // record at all.
      const working = writablePdf(filePath);
      const outcome = await writePdfMetadata(working, patch);
      if (!outcome.ok) return outcome;
      const landed = await landMetadata(working, 'pdf', patch);
      return landed === undefined ? outcome : { ...outcome, landed };
    },
  );

  /**
   * THE EPUB A METADATA READ OR WRITE MAY TOUCH — a finished export, and nothing
   * else in the library.
   *
   * ── Why this is not `admittedPdf` with a different extension ────────────────
   *
   * `admitted` answers for documents that came in through `openDocument` — the
   * menu, a drop, argv, the dialog. An export never came in through any of them:
   * `openExportView` (core/documents.service.ts) makes its tab out of a path read
   * off a history row, and the pane behind it asks `book:view` rather than opening
   * a file. So the allow-list says no to every export there is, and a door that
   * admitted the path for being asked about it would not be a gate at all.
   *
   * The tray is the honest test and it is already this app's answer to exactly
   * this question twice over — `export:save-copy` copies out of it, `book:view`
   * explodes out of it — so this asks the same function and inherits whatever
   * that rule becomes.
   *
   * ── NO `archive/` TEST HERE, WHICH IS NOT AN OVERSIGHT ─────────────────────
   *
   * The PDF write needs one because `documentAtPosition` can put the untouched
   * original in front of the dialog, and `isManaged` is true of it. `final/` and
   * `archive/` are different folders by construction: a path this answers for is
   * two segments deep under `final`, so the archived scan cannot reach here and a
   * refusal about it would be a sentence nobody can make the app say.
   *
   * ── AND THE EXTENSION, BECAUSE A TRAY HOLDS MORE THAN BOOKS ────────────────
   *
   * `final/` also holds plain-text exports, and `epub-meta` handed one would fail
   * somewhere inside a zip reader with a sentence about a container. Refused here,
   * in words about what the file is.
   */
  const exportedBook = (candidate: string): string => {
    const resolved = path.resolve(candidate);
    if (exportInTray(resolved) === null || !resolved.toLowerCase().endsWith('.epub')) {
      throw new Error(
        `"${candidate}" is not one of this library’s exported books, and this app edits the record `
        + 'of a book it made rather than of a file it was shown.',
      );
    }
    return resolved;
  };
  ipcMain.handle('meta:read-epub', (_event, filePath: string) =>
    readEpubMetadata(exportedBook(filePath)));
  ipcMain.handle(
    'meta:write-epub',
    async (_event, filePath: string, patch: Record<string, string | undefined>): Promise<MetadataWriteOutcome> => {
      // Resolved once and used for both halves, on the PDF door's rule above: the
      // container and the step are two facts about ONE document, and asking the
      // gate twice would be two answers about it.
      const book = exportedBook(filePath);
      const outcome = await writeEpubMetadata(book, patch);
      if (!outcome.ok) return outcome;
      /*
       * THE STEP IS THE HALF THAT MATTERS MORE HERE THAN IT DOES FOR A SCAN. A
       * PDF's working copy is what every later rendering is read from, so an edit
       * to it is at least durable in the file. An export is a CAST — the next one
       * comes out of the bank, which never knew the title was corrected — so
       * without this the correction would live only in the one container the
       * person happened to have open, and every book filed after it would quietly
       * go back to being wrong.
       */
      const landed = await landMetadata(book, 'epub', patch);
      return landed === undefined ? outcome : { ...outcome, landed };
    },
  );
  /*
   * ── The mint metadata — who the book says it is, per project ──────────────
   *
   * The block the mint modal edits (shared/mint-meta.ts carries the shape and
   * Owen's ruling). READ answers null rather than a seed: the SEEDING is the
   * dialog's decision — it composes a first guess out of the manifest title,
   * the scan's Info author and the position's language, three facts the
   * renderer already holds — and main inventing one here would be two seeders
   * with two opinions. WRITE replaces the whole block; the directory is proved
   * the way every project door proves it, by reading the manifest of the
   * folder named and nothing else.
   */
  ipcMain.handle('meta:mint-read', async (_event, projectDir: string) =>
    (await readManifest(projectDir)).meta ?? null);
  ipcMain.handle('meta:mint-write', async (_event, projectDir: string, meta: MintMeta) => {
    await recordMintMeta(projectDir, meta);
  });
  /*
   * The whole block onto ONE finished export, in place — the metadata tile's
   * Save over an EPUB somebody is looking at. Gated exactly as the flat
   * writer above (`exportedBook`): only a file this app filed answers, and
   * the language written is the FORM'S here, deliberately — an edit of a
   * finished file is a person correcting that file's record, not a mint
   * whose chain outranks them.
   */
  ipcMain.handle('meta:mint-stamp', (_event, filePath: string, meta: MintMeta) =>
    stampMintMetadata(exportedBook(filePath), meta, undefined));
  /*
   * The HOST's answer for who this book is — the hosted modal's seed (Owen:
   * "it should inherit the parent document's metadata. ill fill out whatever
   * is missing"). Null standalone; a host that THROWS rejects here in the
   * host's own words, so the form can say so (2026-09-07); the DIALOG
   * merges, because the precedence (stored block wins per-field, host fills
   * the gaps, the position feeds the language) reads two other facts only the
   * renderer holds.
   */
  ipcMain.handle('meta:mint-host', (_event, projectDir: string) => hostMintMeta(projectDir));

  // ── The step ledger ──────────────────────────────────────────────────────
  /*
   * ONE FAMILY, AND MAIN PROVES THE DIRECTORY ON EVERY MEMBER OF IT.
   *
   * The renderer names a project directory, exactly as it names a PDF above, and
   * `deleteStep` unlinks files inside whatever it was handed — which is the same
   * authorization problem `deletableProjectDir` exists for and is gated by the
   * same check (electron/projects.ts). The read and the pointer move ask it too,
   * deliberately: a gate that only guards the destructive call is a gate somebody
   * routes around by reading first.
   *
   * DESCRIBE, THEN DELETE, on the document delete's precedent and for its reason.
   * `describe-delete` composes the facts AND proves the delete is currently
   * allowed, so a card is never drawn for something that would be refused a click
   * later; `delete` proves it again, because a renderer that skipped the question
   * meets the same refusal. The origin is refused by name in both — deleting the
   * import is deleting the project, and the project ✕ does that with its own
   * ceremony and its own accounting of what it costs.
   */
  /**
   * A job writing into this project, and a delete that would take its payload.
   *
   * ── Why the delete owes this and the other two calls do not ─────────────────
   *
   * A held, queued or running job is a run that HAS ALREADY CHOSEN where its
   * output goes: the bank is named, the EPUB's path is composed, and the parent
   * step was captured when somebody pressed the button. Deleting a step while one
   * waits is aimed at exactly the file that run is about to write — the reading
   * whose bank it is filling, or the translation whose EPUB it is composing — and
   * the two possible orders are both wrong. Destroy the payload first and the run
   * finishes into a folder whose catalogue no longer describes it, leaving hours
   * of GPU nothing in this app names. Let the run land first and it appends
   * against a parent this delete has just taken off the ledger, which `landStep`
   * survives by falling back to the position, but only by filing the work
   * somewhere nobody chose.
   *
   * SO THE STEP DELETE REFUSES, on the project delete's own terms and with the
   * same vocabulary — the shelf is where a person cancels a job, and the sentence
   * says so. Coarse on purpose: ANY job writing into this project, not just one
   * whose output happens to be a payload in the doomed subtree. The narrower test
   * would have to predict where a run that has not started will write, and being
   * clever about that is how a delete comes to race a job it decided was unrelated.
   *
   * ── THE OTHER TWO ARE NOT UNSAFE, AND REFUSING THEM WOULD BE ITS OWN BUG ────
   *
   * `ledger:go` writes one field of the manifest and touches nothing else. The
   * design already defends the case it looks dangerous in: a job captures its
   * parent at enqueue (`Job.parentStep`) and every path it will read or write at
   * PLAN time (`planRendering`), precisely so that clicking through the history
   * while a run waits cannot retarget it. Moving the pointer is a repaint, it is free, and
   * people do it while they wait — refusing it during a three-hour reading would
   * take the history panel away for the whole time it is most wanted, to prevent
   * nothing.
   *
   * `book:apply` writes `ops/<uuid>.jsonl`, a path no job can be about to
   * write, and appends a step of its own. It is the one action in this app that
   * retains IRREPLACEABLE work — somebody's judgements about four hundred blocks —
   * and refusing to let a person land those because a machine is busy would be
   * this app declining to keep the only thing in a project it cannot make again.
   * The interesting case is an Apply made while a re-read is running, and the
   * ledger already has the right answer for it: the payload is retained, and when
   * the reading lands and replaces its parent, `markStale` dims the step rather
   * than destroying it (the retention rule: user labour is never destroyed by a
   * re-run). That is the designed outcome, not a race.
   */
  /*
   * THE OTHER REFUSAL IS NOT HERE, AND THAT IS DELIBERATE. A book this window has
   * open cannot have its working tree unlinked, and `describeStepDelete` and
   * `deleteStep` both refuse that case themselves (electron/projects.ts,
   * `refuseOpenPayload`) — because deciding it needs the sweep, which needs the
   * manifest, which is that module's. It is the document delete's model rather
   * than the project delete's: the narrow test on the tree this step's own payload
   * serves, plus the renderer closing the tab between the confirm and the call.
   */
  const refuseBusyStepDelete = async (projectDir: string, stepId: string): Promise<void> => {
    // `deletableStep` proves the directory, names the step, AND runs the refusal
    // that never lifts — the origin is not a deletable step at any hour — so this
    // never tells somebody to cancel a job for a delete that would refuse them
    // afterwards anyway.
    const subject = await deletableStep(projectDir, stepId);
    refuseBusyJob(subject, `“${subject.label}” cannot be deleted yet — that run is about to write `
      + 'into this project, and destroying a step\'s files while it does would leave the job '
      + 'finishing into a history this app no longer has. Cancel it in the shelf, or let it land, '
      + 'then delete the step.');
  };

  /*
   * ── THE CAPTURE STAGE, REGISTERED AND NOT YET ANSWERING ───────────────────
   *
   * Merge 1 is the CONTRACT and nothing else: these seven exist so the renderer
   * can be written and typechecked against real declarations while main is
   * still being filled in (docs/CAPTURE.md, work packages). They refuse by name
   * rather than by silence, because a door that resolves undefined is a bug
   * report about the renderer and a door that throws is a true sentence about
   * the app.
   *
   * REGISTERED HERE AND NOT BEHIND A FLAG. A channel that appears later is a
   * channel `docs/IPC-CHANNELS.md` cannot enumerate and the audit cannot see;
   * the seven names are the contract, and the contract is what ships first.
   */

  /*
   * `capture:create` MAKES A PROJECT, which no other door here does. It answers
   * with the directory because that directory is the only handle anything has
   * on a project keyed from a random id rather than from a document — and with
   * the recipe and token beside it, so the light table opens in one round trip
   * rather than creating and then immediately loading.
   */
  ipcMain.handle('capture:create', async (_event, title: string) => {
    const made = await createCaptureProject(title);
    return { projectDir: made.dir, ...(await ensureCapture(made.dir)) };
  });
  /*
   * INTAKE IS THE LONG ONE. Every photograph is copied, hashed, decoded, encoded
   * to a lossless working copy and thumbnailed, one at a time — seconds each,
   * and the acceptance shoot is twenty-seven of them. It is an `invoke` like the
   * others because the contract says so; a person watching a spinner for a
   * minute is a surface problem, and inventing a progress channel here would
   * make it a protocol one.
   */
  ipcMain.handle('capture:intake', (_event, projectDir: string, paths: string[]) =>
    intakePhotos(projectDir, paths));
  ipcMain.handle('capture:recipe-load', (_event, projectDir: string) => openCapture(projectDir));
  /*
   * ── GRAVESTONE: `capture:pages-load` (Wave 41) ────────────────────────────
   *
   * A door stood here that listed the page images a mint had made and handed
   * back a token to serve them, because the mint wrote pictures and no
   * container. It admitted nothing — the token was the whole authorisation —
   * and it read the POSITION to decide which mint, so a re-mint's older row
   * still opened its own book.
   *
   * The mint writes a PDF (`recordMint`) and the minted row resolves to it
   * through `ledger:document-at` like every other document in the app, so
   * pdf.js draws the pages and this door has nothing to answer. Removing it
   * moves the handle count in docs/IPC-CHANNELS.md, which BookForge's keeper
   * test reads — the table is regenerated in the same commit.
   */
  /*
   * REMOVAL, WHICH IS THE ONE DOOR THAT DELETES ANYTHING IRREPLACEABLE. It is
   * allowed to because the bank holds copies of files that still exist where
   * the person dragged them from, and because the surface has already asked
   * them, by name and by count. Refused while this project is being minted.
   */
  ipcMain.handle('capture:remove', (_event, projectDir: string, photoIds: string[]) =>
    removePhotos(projectDir, photoIds));
  /*
   * SAVED WHOLE AND VALIDATED WHOLE. The renderer debounces; this does not, and
   * it refuses a recipe it cannot read rather than writing it — a malformed
   * recipe on disk is not a bug that throws, it is a project that will not open
   * tomorrow, holding photographs nobody can remake.
   */
  ipcMain.handle('capture:recipe-save', (_event, projectDir: string, recipe: CaptureRecipe) =>
    writeRecipe(projectDir, recipe));
  /*
   * THE MINT IS A SESSION AND NOT A CALL, which is why there are four of these.
   * Main decides the list, the renderer sends back one finished page at a time,
   * and the commit is the single point at which a document appears. Nothing is
   * written into the project until then: a mint given up on halfway leaves the
   * catalogue exactly as it found it.
   */
  ipcMain.handle('capture:mint-begin', (_event, projectDir: string) => mintBegin(projectDir));
  ipcMain.handle('capture:mint-page', (_event, mintId: string, index: number, jpeg: ArrayBuffer) =>
    mintPage(mintId, index, jpeg));
  ipcMain.handle('capture:mint-commit', (_event, mintId: string) => mintCommit(mintId));
  ipcMain.handle('capture:mint-abort', (_event, mintId: string) => mintAbort(mintId));
  /*
   * THE PDF EXPLOSION IS A SESSION TOO, AND FOR THE MINT'S REASON REVERSED.
   *
   * A dropped PDF becomes one PNG per page. The renderer rasterizes — pdf.js is
   * over there — and these three doors are main putting the pages on disk so
   * that `capture:intake` above can copy them in exactly as it copies a
   * photograph. One page per call, because a 300-page scan is gigabytes and a
   * call that carried the book would hold all of it in one heap.
   *
   * NOTHING HERE ADMITS ANYTHING, because nothing here is a path the renderer
   * named: main chooses the directory, the renderer supplies bytes and a
   * basename, and the basename is checked rather than trusted (`pdfStagePage`).
   * The release is separate from the last page because the two callers let go at
   * different moments — see the function's own note.
   */
  ipcMain.handle('capture:pdf-stage-begin', () => pdfStageBegin());
  ipcMain.handle('capture:pdf-stage-page', (_event, stageId: string, name: string, png: ArrayBuffer) =>
    pdfStagePage(stageId, name, png));
  ipcMain.handle('capture:pdf-stage-release', (_event, stageId: string) => pdfStageRelease(stageId));
  ipcMain.handle('ledger:read', (_event, projectDir: string) => readStepLedger(projectDir));
  ipcMain.handle('ledger:go', (_event, projectDir: string, stepId: string) =>
    goToStep(projectDir, stepId));
  /*
   * THE SAME MOVE, NAMED BY A DOCUMENT INSTEAD OF BY A ROW.
   *
   * `go` is the user pointing at a step; this is the user pointing at a document
   * and the app working out which step that is — the gesture behind "focusing a
   * tab moves the position back" (docs/WORKBENCH.md §6c). The resolution is
   * `standForDocument` (electron/projects.ts), beside the forward direction it has
   * to agree with, for the reason every other path in a project is composed there:
   * a renderer deciding for itself which step a file belongs to would be a second
   * opinion about the ledger, and the way that opinion goes wrong is that it
   * stands somebody on the import and then translates their scan.
   *
   * NO PATH IS ADMITTED HERE, and the difference from `document-at` is worth
   * saying out loud. That call ANSWERS with a path this process then has to let a
   * viewer open, so it adds it to the allow-list. This one is handed a path the
   * renderer already has open — the allow-list said yes to it when the document
   * was opened — and answers with rows. A handler that admitted whatever it was
   * given would be a door that grants access for being asked a question.
   */
  ipcMain.handle('ledger:stand-for', (_event, projectDir: string, filePath: string) =>
    standForDocument(projectDir, filePath));
  /*
   * MAIN RESOLVES IT, SO MAIN ADMITS IT — the same pairing the import's relocation
   * already makes (`document:relocated`, above), and for the same reason. The
   * renderer is about to point a viewer, the block editor and the metadata dialog
   * at this path, and every one of those doors asks the allow-list; a path the
   * renderer named for itself is a path this process never agreed to serve.
   *
   * NOT REMEMBERED AS A RECENT. Nothing was opened here: the person clicked a row
   * in the history of a book they already have open, and a library list that grew
   * a row per click of the Steps accordion would be bookkeeping about a gesture
   * that is meant to be free.
   */
  ipcMain.handle('ledger:document-at', async (_event, projectDir: string) => {
    const resolved = await documentAtPosition(projectDir);
    if (resolved !== null) admit(resolved);
    /*
     * A NULL IS AN ORDINARY ANSWER AND NOTHING IS FIRED AT IT ANY MORE. There
     * used to be a `towardTheFlowingBook` here: when a position resolved to the
     * scan, or to nothing, this handler asked the queue to cast the project's
     * flowing book so the pane would have an EPUB to unpack. The pane reads the
     * book file now — a read, a save and a translation all open the proof sheet
     * — so a position that names no separate document names none, and the panes
     * correctly keep what they have (docs/RENDERER.md §7).
     */
    return resolved;
  });
  /*
   * THE SAME ANSWER FOR A ROW NOBODY IS STANDING ON — Compare's document resolve.
   *
   * The column beside the live one is locked to a step the person picked, and a
   * step whose picture is a FILE (the import, a rendering) needs that file's path
   * before a viewer can be pointed at it. `document-at` cannot answer it: it reads
   * the pointer, and the pointer is by definition somewhere else while a
   * comparison is on screen.
   *
   * IT ADMITS WHAT IT ANSWERS, exactly as `document-at` does one door up and for
   * the identical reason: the renderer is about to point pdf.js at this path, and
   * a path the renderer named for itself is a path this process never agreed to
   * serve. The allow-list is the only thing standing between a compare column and
   * an arbitrary file, so the pairing — main resolves it, main admits it — is not
   * a convenience here, it is the whole gate.
   *
   * NOT REMEMBERED AS A RECENT, on `document-at`'s own rule: nothing was opened,
   * somebody put a second view on a row of a book they already have open.
   */
  ipcMain.handle('ledger:document-at-step', async (_event, projectDir: string, stepId: string) => {
    const resolved = await documentAtStep(projectDir, stepId);
    if (resolved !== null) admit(resolved);
    return resolved;
  });
  /*
   * THE QUEUE'S HALF OF THE CORRECTION DOOR.
   *
   * A translation appends to its records file for hours and a correction swaps
   * that whole file into place, so the door is shut while a run is producing it.
   * The queue knows and projects.ts must not import it; main, which composes the
   * door, hands the check in (`recordCorrection`, electron/projects.ts).
   *
   * IT USED TO BE HANDED TO TWO DOORS. The other one started from a cast EPUB's
   * path — a word edited in the iframe reader — and both it and the reader are
   * deleted (docs/RENDERER.md §7). There is one door onto a translation's words
   * now, and it is the pane's.
   */
  const recordsBusy = (recordsFile: string): string | null => (
    queue.producing(recordsFile)
      ? 'A translation is writing this book\'s records right now, so the correction was not '
        + 'recorded — the edit is on screen and in this copy of the book. Let the run finish '
        + '(or cancel it) and make the edit again.'
      : null
  );
  /*
   * THE BOOK ITSELF — the rows the renderer draws, off the file the reflow made.
   *
   * ONE CALL AND NO PATH CROSSES IT IN EITHER DIRECTION, which is the difference
   * from `document-at` one door up and is worth saying plainly. That handler
   * ANSWERS with a path a viewer then opens, so it admits it to the allow-list;
   * this one answers with the BOOK — blocks, chapters, measured type — and the
   * renderer never learns where any of it lives. There is nothing for it to open,
   * so there is nothing to admit.
   *
   * IT MAY SPAWN THE ENGINE, and that is the whole of what makes opening a read
   * position work on a library written before this format existed
   * (electron/book.ts says why the ensure and the migration are one path). It is
   * awaited rather than fired and forgotten: the caller is a pane with
   * `Opening the book…` on it and nothing else to show, so
   * a promise that resolved before the file existed would be a blank sheet with
   * no sentence on it.
   *
   * IT ANSWERS A FAILURE RATHER THAN REJECTING ONE, and the sentence it carries
   * is composed to be READ — it lands on the paper (RENDERER-DESIGN.md §5). The
   * paths that make a refusal actionable go to the terminal instead, which is the
   * house rule for every sentence in this app. The one thing that still rejects
   * is a directory that is not one of Home's projects: that is the gate refusing,
   * not the book being unavailable.
   */
  ipcMain.handle('book:load', (_event, projectDir: string) => loadBook(projectDir));
  /*
   * THE BOOK AS OF A NAMED STEP — the read Compare is built on.
   *
   * EVERYTHING `book:load` SAYS APPLIES HERE WORD FOR WORD: no path crosses it in
   * either direction, it may spawn the engine, it answers a failure rather than
   * rejecting one, and the single thing that still rejects is a directory that is
   * not one of Home's projects. The only difference is which row the replay is
   * resolved to, and that difference is a parameter the machinery underneath has
   * carried since translations began materialising at the landing — see
   * `loadBookAt` (electron/book.ts) for why this is one replay asked twice rather
   * than two replays.
   *
   * A STALE STEP ID IS A SENTENCE, not a rejection. The picker is drawn from a
   * ledger this window read a moment ago, and a delete can land in between; the
   * compare column has a sheet to put that sentence on, which is the same contract
   * every other failure of this family has.
   */
  ipcMain.handle('book:load-at', (_event, projectDir: string, stepId: string) =>
    loadBookAt(projectDir, stepId));
  /*
   * AND THE OTHER DIRECTION — the pane's stack, landed as a step.
   *
   * IT REJECTS WHERE `book:load` ANSWERS, which is the difference worth stating
   * at the door rather than only in the module. A load with nothing to show has an
   * empty sheet to put a sentence on; an Apply that fails has the person's changes
   * still in front of them, and the honest thing is a refusal they can act on
   * rather than a stack silently cleared. `applyBookOps` writes the file before
   * the step and takes the file back if the step will not land, so there is no
   * half-applied state for this handler to describe.
   */
  ipcMain.handle('book:amend', (_event, projectDir: string, ops: BookOp[]) =>
    amendBookOps(projectDir, ops));
  // A finished export, exploded and shown read-only — never a rejection a pane
  // cannot draw: every refusal is a sentence in the outcome.
  ipcMain.handle('book:view', (_event, target: string) => viewExportedBook(target));
  ipcMain.handle('book:apply', (_event, projectDir: string, ops: BookOp[]) =>
    applyBookOps(projectDir, ops));
  /*
   * AND THE THIRD DOOR ONTO THIS BOOK — a corrected paragraph on a TRANSLATED
   * position, which is not an op and must never become one.
   *
   * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
   * §5.) `book:apply` records decisions about STRUCTURE — strike, category,
   * merge, split, chapter — and every one of those is as true of a translation as
   * of the book it came from, so they ride the ops chain unchanged. The WORDS are
   * the exception: they belong to the records file, which is the step's payload
   * and the truth the derived book is a pure function of, and a `text` op over one
   * would leave the same paragraph saying two things.
   *
   * IT REJECTS, like `book:apply` and for its reason, and it ANSWERS WITH THE
   * WHOLE BOOK — the correction is not visible until the derived book has been
   * made again, and making the pane ask a second time for a state this call
   * already produced would be two questions about one gesture.
   */
  ipcMain.handle('book:correct', (_event, projectDir: string, id: string, text: string) =>
    correctBookBlock(projectDir, id, text, recordsBusy));
  /*
   * ── THE WORKING STACK, ON DISK — three doors, and none of them is history ────
   *
   * Apply is what writes a STEP. These three write the thing that has not been
   * applied yet, so that no window closing, no crash and no glance at another tab
   * can be the reason somebody's afternoon is gone (user report, 2026-08-21: a
   * chapter renamed, a paragraph retyped, an EPUB exported without either, and
   * then the stack scrapped by a window nobody asked). `savePendingStack` is
   * called on a debounce from the pane, exactly as the light table's recipe is;
   * `readPendingStack` is asked once per open and refuses out loud rather than
   * adopting a stack made somewhere else; `clearPendingStack` has two callers and
   * both of them are a person speaking.
   *
   * THEY REJECT, on `book:apply`'s rule and for its reason: the changes are in
   * front of the person and a write that quietly did not happen is the failure
   * this family exists to end. The read is the one exception in spirit — it
   * answers a refusal rather than throwing one — because "there is something held
   * and it is not about this book" is a fact the pane has to say a sentence
   * about, not an error.
   */
  ipcMain.handle('book:pending-save', (_event, projectDir: string, stack: PendingStack) =>
    savePendingStack(projectDir, stack));
  ipcMain.handle('book:pending-read', (_event, projectDir: string) =>
    readPendingStack(projectDir));
  ipcMain.handle('book:pending-clear', (_event, projectDir: string) =>
    clearPendingStack(projectDir));
  /**
   * THE CARD IN FRONT OF EVERY ACT THAT WOULD RUN PAST WORK NOBODY APPLIED.
   *
   * ── OWEN'S RULING, VERBATIM (2026-08-22) ────────────────────────────────────
   *
   * *"if the user has 'this book' selected with un-applied changes, the export
   * option shouldnt be grayed out. but any action they take, whether it's
   * switching to a different step or narrating or anything at all, should ask if
   * they want to apply changes in a modal. discard/apply changes. if they hit
   * discard, it does whatever action they selected to the step theyre on after
   * dropping changes they made. if they hit apply changes, the action they select
   * is executed after applying all changes. and maybe there should be another
   * apply changes button somewhere obvious. the button on the side of the
   * workbench works but it isnt obvious"*
   *
   * Every clause of that has a home: the two buttons are here, the widened set of
   * acts is `UnappliedAct` and `UnappliedService`, "it does whatever action they
   * selected" is that service running the act after either answer, "shouldnt be
   * grayed out" is the make-act predicates NOT consulting the stack (they never
   * did, and it was checked rather than assumed), and the obvious button is at the
   * head of the book pane.
   *
   * ── Why this is a door and not four lines in the renderer ───────────────────
   *
   * Because the sentences are main's, which is this app's one rule about this one
   * card (`ConfirmService`: *"The one thing the renderer must never do to this
   * dialog is start writing its own copy"*). The renderer hands over the facts it
   * is the only holder of — how many changes are waiting, on which book, under
   * which act — exactly as `document:confirm-close` is handed `edits`, and main
   * composes.
   *
   * ── APPLY IS OFFERED FIRST, and it is the same Apply ────────────────────────
   *
   * The closing card's own argument: a dialog whose only route to keeping the
   * work is *cancel, find Apply, press again* has made the person do the app's
   * job. It is what Enter takes and Discard is last, which is this app's rule for
   * every card that can destroy something.
   *
   * ── AND THIS CARD CAN NOW DESTROY SOMETHING, WHICH IT COULD NOT BEFORE ──────
   *
   * The three-answer version was safe by construction: apply, or go on without
   * them, or cancel — every one of them left the stack on the page, and the
   * docblock that stood here said so and gave that as the reason nothing wore the
   * error colour. Discard changes that. This is the second gesture in the app
   * (the closing card's own Discard is the first) that throws unapplied work
   * away, so it wears the error colour, it is last, and the detail says out loud
   * that it is for good. The one that used to be safe-by-construction is now
   * safe-by-aiming, which is a weaker guarantee honestly stated rather than a
   * stale sentence about a card that no longer exists.
   *
   * ── ONE CARD, FIVE ACTS, TWO SENTENCES THAT VARY ────────────────────────────
   *
   * `runs` says what the act would be made from and `then` says what happens
   * after the answer. Everything else — the title, the count, the warning about
   * Discard, the way out — is identical wherever this is raised, because it is
   * one question and a person should not have to re-read it to find out whether
   * this is the same box they answered a minute ago.
   */
  ipcMain.handle(
    'book:confirm-unapplied',
    (_event, warning: UnappliedWarning): Asked<UnappliedAnswer> => {
      const changes = warning.edits === 1 ? '1 change' : `${warning.edits} changes`;
      const them = warning.edits === 1 ? 'it' : 'them';
      /*
       * WHAT THE ACT WOULD BE MADE FROM — and standing is the odd one out, which
       * is exactly why it needs its own sentence rather than a fifth spelling of
       * the make-act line. A move makes nothing; what it costs is that the stack
       * cannot come with it, because ops are a delta against the step they were
       * made on and carrying them would apply somebody's decisions to a book they
       * never made them about.
       */
      const runs = warning.act === 'stand'
        ? 'Changes on the book belong to the step they were made on, so moving to another step '
          + 'cannot take them along. They would be left behind here.'
        : (warning.act === 'translate'
          ? 'The translation would be made from'
          : warning.act === 'simplify'
            ? 'The rewrite would be made from'
            : warning.act === 'clean'
              ? 'The cleaned text would be made from'
              : warning.act === 'export'
                ? 'The exported book would be'
                : 'The work would be made from')
          + ' the book as it was recorded, which is the book WITHOUT those changes — changes reach '
          + 'anything made from this book only once they are applied as a step.';
      // What happens the moment the card closes, in the words of the thing the
      // person pressed. The card's own title says nothing about the act, so this
      // is the only place it is named.
      const then = warning.act === 'translate'
        ? 'the translation is set up'
        : warning.act === 'simplify'
          ? 'the rewrite is set up'
          : warning.act === 'clean'
            ? 'the cleanup is set up'
            : warning.act === 'export'
              ? 'the export is set up'
              : warning.act === 'stand'
                ? 'the step you clicked is opened'
                : 'the work goes ahead';
      return {
        kind: 'ask',
        question: {
          title: warning.edits === 1
            ? '1 change is not applied yet'
            : `${warning.edits} changes are not applied yet`,
          message: `“${warning.title}” has ${changes} on the page that have not been applied.`,
          detail: [
            runs,
            `Apply changes records all of ${them} as one row in Steps, and then ${then} from the `
            + 'book you are looking at.',
            `Discard changes throws ${them} away for good — nothing puts ${them} back — and then `
            + `${then} from the book as it was recorded.`,
            'Leave it as it is walks away from the whole question: nothing is applied, nothing is '
            + 'discarded, and nothing runs.',
          ],
          /*
           * THE WAY OUT IS A BUTTON AGAIN — Owen's ruling, 2026-08-23: *"lets add
           * a cancel button to that, so the user doesnt have to do anything if
           * they dont want."* The two-answer version kept cancel alive as Escape
           * and the scrim, and the detail said so in words — which is a way out
           * only for somebody who reads the small print of a card they were
           * interrupted by. Between the two others, so the destructive button
           * stays LAST and keeps having to be aimed at; Apply stays first and is
           * still what Enter takes.
           */
          choices: [
            { key: 'apply', label: APPLY_CHANGES },
            { key: 'cancel', label: 'Leave it as it is' },
            { key: 'discard', label: DISCARD_CHANGES, danger: true },
          ],
          preferred: 'apply',
          /*
           * A DISMISSAL IS STILL A CANCEL — Escape and the scrim mean the same
           * thing the middle button says, because somebody stepping away from a
           * question and somebody pressing "leave it" have decided the same
           * nothing.
           */
          dismissed: 'cancel',
          checkbox: null,
        },
      };
    },
  );
  ipcMain.handle('ledger:describe-delete', async (_event, projectDir: string, stepId: string) => {
    /*
     * A ghost first — but only where the ledger does NOT hold the id. A row can
     * still say `running` after the step it minted has landed (`admitPending`
     * carries that window's whole argument), and in it a real step's delete must
     * stay a real step's delete rather than becoming a refusal about a promise.
     */
    const held = await readStepLedger(projectDir);
    const real = held !== null && held.ledger.steps.some((step) => step.id === stepId);
    const promised = real ? null : promisedDeletion(projectDir, stepId);
    if (promised !== null) return promised;
    // Proven BEFORE the card is composed, so a warning is never put on screen for
    // something the delete would refuse a click later.
    await refuseBusyStepDelete(projectDir, stepId);
    return describeStepDelete(projectDir, stepId);
  });
  stepDeleteDoor = async (projectDir: string, stepId: string) => {

    /*
     * A GHOST IS REMOVED FROM THE QUEUE, not deleted from a ledger it is not in.
     * A row still waiting leaves by `remove`; one already running leaves by
     * `cancel`, which is the only door a running row has. Hosted, both forward
     * to the host's queue, whose cascade takes the promised subtree with it; the
     * view that comes back is the ledger as it was, because nothing in it moved
     * — the tree's ghosts are derived from the rows and go with the next push.
     */
    const standing = await readStepLedger(projectDir);
    const promised = standing !== null && standing.ledger.steps.some((step) => step.id === stepId)
      ? null
      : rowMinting(rowsIn(projectDir), stepId);
    if (promised !== null) {
      /*
       * `remove`, WHICH TAKES THE SUBTREE — a host's own removal stops nothing
       * because nothing has begun, and drops every row chained behind it
       * (BookForge's `queue-engine.removeStep`); this app's does the same to its
       * own list. A RUNNING one never reaches this line: `refuseRunningGhost`
       * above turned the press into a sentence, because ending a run and
       * settling what happens to the work waiting on it is the queue's own door
       * and must not be two doors (Owen, 2026-09-08).
       */
      refuseRunningGhost(promised);
      queue.remove(promised.id);
      const view = await readStepLedger(projectDir);
      if (view === null) throw new Error(`${projectDir} has no history to show after the removal.`);
      return view;
    }
    // Proven again, never trusted from the describe: a job can be queued between
    // the question and the answer, and this is the call that unlinks something.
    await refuseBusyStepDelete(projectDir, stepId);
    return deleteStep(projectDir, stepId);
  };
  ipcMain.handle('ledger:delete', (_event, projectDir: string, stepId: string) =>
    deleteLedgerStep(projectDir, stepId));

  // ── The library folder ───────────────────────────────────────────────────
  /*
   * ── HOSTED, THE LIBRARY IS NOT THIS APP'S TO MOVE ─────────────────────────
   *
   * BookForge opens the Foundry window over books that live inside ITS data
   * directory, and its own metadata maps each book to a project folder by path
   * (docs/BOOKFORGE-HANDOFF.md §8). A Foundry settings screen that could point
   * `libraryDir` somewhere else would strand every one of those mappings — the
   * host would go on naming folders under a root nothing writes to any more, and
   * nothing in either app would say what had happened.
   *
   * So the two doors that CHANGE it refuse, and the one that REPORTS it answers
   * as it always did: `readAppSettings` returns the host's directory while a host
   * is mounted (electron/app-settings.ts), so `library:dir` names the folder the
   * books are actually in, which is what every caller of it wanted to know. The
   * refusal is a sentence rather than a silent no-op because a control that
   * appears to work and does nothing is the worse failure — the renderer hides
   * the control when `hosted()` is true, and this is what backs that up.
   */
  const refuseHostedLibraryMove = (): void => {
    if (!hosted()) return;
    throw new Error(
      'This library belongs to the app Foundry is running inside, which keeps your books with '
      + 'the rest of its own data. Move them from there, not from here.',
    );
  };
  /*
   * ── THE USER'S OWN ANALYSIS CATEGORIES ────────────────────────────────────
   *
   * Owen, 2026-08-25: *"maybe the user can add more categories - even
   * one-sentence descriptive ones."* They are the USER'S and not one project's,
   * so they live in `app-settings.json` beside the library folder and reach every
   * book that machine ever opens (`AppSettings.analysisCategories`).
   *
   * TWO DOORS AND NOT ONE, and the write takes the WHOLE LIST rather than a
   * single add or remove. A per-item door would need an id from the renderer to
   * say which item, and ids here are DERIVED from names by main — so "remove the
   * one called X" would be main re-deriving a name the renderer had already
   * derived, and the two derivations would be the thing that had to agree. The
   * whole list is one fact with one owner, and `clampAnalysisCategories` re-mints
   * every id on the way in, so what the file holds is always main's own spelling
   * whatever the window sent.
   *
   * IT IS NOT REFUSED WHEN HOSTED. A library move is refused there because the
   * books belong to the host; a list of claims somebody wants hunted for belongs
   * to the person, and BookForge has no opinion about it.
   */
  ipcMain.handle('analysis:read-categories', () => readAppSettings().analysisCategories);
  ipcMain.handle(
    'analysis:write-categories',
    (_event, categories: CustomAnalysisCategory[]) =>
      writeAppSettings({
        analysisCategories: Array.isArray(categories) ? categories : [],
      }).analysisCategories,
  );

  ipcMain.handle('library:dir', () => readAppSettings().libraryDir);
  ipcMain.handle('library:set', (_event, dir: string) => {
    refuseHostedLibraryMove();
    return writeAppSettings({ libraryDir: dir }).libraryDir;
  });
  ipcMain.handle('library:choose', async (_event, current: string) => {
    refuseHostedLibraryMove();
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should Foundry keep your books?',
      defaultPath: current,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // ── Home's list ──────────────────────────────────────────────────────────
  ipcMain.handle('recents:list', () => listRecents());
  ipcMain.handle('recents:forget', (_event, filePath: string) => forgetRecent(filePath));
  ipcMain.handle('recents:clear', () => clearRecents());

  /**
   * The position of the project a job is about to write into, at the press.
   *
   * ── Why the press and not the spawn ─────────────────────────────────────────
   *
   * A job's product is recorded as having been made FROM a step, and that step is
   * what decides whether a re-run replaces an earlier one (staling everything
   * downstream) or branches beside it. Moving the pointer, meanwhile, is free and
   * unconfirmed — people click through their own history while they wait, which is
   * exactly what the history is for. So a job that read its parent when it landed
   * would be retargeted by a glance: queue a translation from the reading, click
   * back to compare two saves, and three hours later the app files a translation
   * of a save nobody asked it to translate.
   *
   * Resolved HERE, in the handler, so the read of the catalogue and the enqueue
   * happen in one turn and `queue.enqueue` stays synchronous — the shelf row has
   * to appear the instant Add is pressed (see that function).
   *
   * FROM THE JOB'S OWN OUTPUT PATH, which is main's composition rather than the
   * renderer's word: `workspace:plan*` built it, into a project directory this app
   * chose. A request naming somewhere else answers null and lands on the same
   * fallback a project with no history does.
   */
  const parentStepFor = async (target: string): Promise<string | null> => {
    const dir = projectDirOf(target);
    return dir === null ? null : positionStepId(dir);
  };

  /**
   * WHAT THIS RUN IS RECORDED AS BEING MADE FROM — the position, unless the request
   * already says otherwise.
   *
   * ── The one case where the pointer is the wrong answer ─────────────────────
   *
   * `Job.parentStep` is the position at the press, and the argument for that is
   * unchanged and long: a pointer that moves while a row waits must not change what
   * the run is filed under. A DEFERRED request breaks the premise rather than the
   * rule — the person pressed on a card that is not the position and cannot be, because
   * main refuses `ledger:go` to a step that does not exist (`LedgerService.
   * standOnPromise`). Reading the pointer there would file an export of a promised
   * cleanup against the row the cleanup was made FROM: the tree would draw it one
   * card too high, and `ProjectFinal.stepId` would claim the finished book came from
   * a position it does not carry the words of.
   *
   * SO THE DEFERRAL WINS WHERE THERE IS ONE, and it is still the position at the
   * press: `deferred.from` was minted by the plan the moment the button went down,
   * and it names exactly the card the person was standing on.
   */
  const madeFrom = async (
    request: JobRequest | TextPassRequest,
    target: string,
  ): Promise<string | null> => {
    const deferred = request.kind === 'read' ? undefined : request.deferred;
    return deferred?.from ?? await parentStepFor(target);
  };

  /*
   * ── WHAT THE SHELF DRAWS, WHICH IS NOT ALWAYS FOUNDRY'S OWN LIST ──────────
   *
   * `shelfJobs` rather than `listJobs`, and the difference only exists hosted:
   * with a host queue registered, the rows in this window are the HOST's, pushed
   * per project and accumulated into the one global list this mirror has always
   * been (electron/job-queue.ts). Standalone the two functions answer the same
   * array. The PUSH on `queue:changed` below is the same expression, because a
   * window that asked and a window that was pushed at must not hold different
   * facts — `hostOffers`' rule, one family along.
   */
  ipcMain.handle('queue:list', () => queue.shelfJobs());
  ipcMain.handle('queue:enqueue', async (_event, request: JobRequest) => queue.enqueue(
    request,
    // The BANK for a reading, the rendering's output otherwise — the same
    // `outputPath` the queue dedupes on, and the only path in a request that is
    // certainly inside the project the job is about. `madeFrom` rather than
    // `parentStepFor`: a deferred export names its own row, which is not the
    // pointer and cannot be.
    await madeFrom(request, request.kind === 'read' ? request.readingsPath : request.outputPath),
  ));
  /*
   * ── ONE DOOR FOR THREE TEXT PASSES, AND THE CHANNEL KEEPS ITS NAME ─────────
   *
   * A translation, a rewrite and a narration cleanup all arrive here (Owen,
   * 2026-09-05: *"translate, simplify, and cleanup are all three similar steps"*),
   * because everything this door does is the same for all three: re-check the
   * input against the allow-list, resolve the position from the records file's own
   * project, hand it to the one enqueue. A `queue:enqueue-clean` beside this would
   * have been a second channel with an identical body.
   *
   * THE NAME IS NOT CHANGED EITHER, and that is a deliberate refusal rather than
   * an oversight. docs/IPC-CHANNELS.md is BookForge's COLLISION AUDIT — the
   * authority on every name this app owns in a process it shares — and a rename is
   * a new name to audit plus an old one to prove retired, paid for a channel whose
   * behaviour is unchanged. `queue:enqueue-translate` is now the family's door,
   * spelled after its eldest member, and the doc says so.
   */
  ipcMain.handle('queue:enqueue-translate', async (_event, request: TextPassRequest) => {
    // The input again, because a request can arrive with any `inputPath` at all
    // — `workspace:plan-translation` checked the one it was given, not the one
    // that ends up here.
    if (admitted(request.inputPath) === null) {
      throw new Error(`${request.inputPath} was never opened in this app.`);
    }
    // The RECORDS file, which is what every text pass writes: the position is
    // resolved from the project that file belongs to, exactly as it used to be
    // resolved from the project the output EPUB belonged to.
    return queue.enqueueTextPass(request, await madeFrom(request, request.recordsPath));
  });
  /*
   * AN ANALYSIS IS QUEUED THE SAME WAY AND REFUSED HOSTED, which is the one place
   * this door differs from the one above it.
   *
   * `enqueueAnalysis` does not route (electron/job-queue.ts carries the argument
   * in full): the host's queue takes the two request shapes its vendored copy of
   * `shared/api.ts` declares, and this is a third.
   *
   * SO THE TEST IS `hosted()` AND NOT "is a host queue registered", which is the
   * one thing about this refusal worth reading twice. Owen's ruling, 2026-08-21:
   * *"when im in bookforge, the shelf shouldnt appear at all."* A hosted window
   * has no Foundry queue surface whether or not the host registered a queue of
   * its own — so falling back to Foundry's own scheduler would start an hour of
   * GPU with no row anybody in either window can see, cancel or start. The tile
   * is gated off there as well; a refusal met before a press is worth more than
   * the same refusal after, and this is the half that makes the rule true
   * whatever route reached it.
   */
  ipcMain.handle('queue:enqueue-analysis', async (_event, request: AnalyzeRequest) => {
    if (hosted()) {
      throw new Error(
        'Analysis is not available in this window yet — the app Foundry is running inside keeps its '
        + 'own queue, and it has not learned about analysis runs. Open the book in Foundry itself to '
        + 'analyse it.',
      );
    }
    // The input again, because a request can arrive with any `inputPath` at all
    // — `workspace:plan-analysis` checked the one it was given, not the one that
    // ends up here.
    if (admitted(request.inputPath) === null) {
      throw new Error(`${request.inputPath} was never opened in this app.`);
    }
    // The REPORT, which is what an analysis writes: the position is resolved from
    // the project that file belongs to, exactly as a translation's is from its
    // records.
    return queue.enqueueAnalysis(request, await parentStepFor(request.outputPath));
  });
  /*
   * AN EXPORT RUNS AT THE PRESS AND THE ANSWER IS THE SETTLED ROW — the whole of
   * the difference from `queue:enqueue` one door up. The dialog that asked is
   * holding this invoke open for the seconds the run takes, and what it gets
   * back is the row in whatever state it settled: `done` with the filed path,
   * `failed` with the engine's own words, or a still-pending row when something
   * is already writing the same file (`runNow` hands the existing one back, and
   * the caller reads the state to tell the two apart). Never routed to a host
   * queue — an export is seconds of CPU arithmetic somebody is watching for, and
   * the argument lives at `runNow` (electron/job-queue.ts).
   */
  ipcMain.handle('queue:run', async (_event, request: JobRequest) => queue.runNow(
    request,
    await madeFrom(request, request.kind === 'read' ? request.readingsPath : request.outputPath),
  ));
  ipcMain.handle('queue:start', () => queue.start());
  /*
   * ONE ROW, BY NAME — what a dialog's own Start presses. `queue:start` is the
   * shelf's button and releases the whole held batch; this releases the row the
   * caller just made and leaves every other parked row parked. Answers whether
   * it let go, so a dialog that is about to watch the run can tell "running" from
   * "somebody removed it while I was open".
   */
  ipcMain.handle('queue:release', (_event, id: string) => queue.release(id));
  ipcMain.handle('queue:remove', (_event, id: string) => { queue.remove(id); });
  ipcMain.handle('queue:cancel', (_event, id: string) => { queue.cancel(id); });
  ipcMain.handle('queue:clear-finished', () => { queue.clearFinished(); });
  /**
   * THE ROW PICKER'S ONE DOOR — send this row to a different slot.
   *
   * `waitFor` is a slot name or `any` (`ANY_SLOT`, shared/slots.ts). Nothing is
   * answered on the way OUT: the change publishes on `queue:changed` like every
   * other change to a row, and a handler returning the row would be a second
   * copy of it racing the push.
   *
   * A REFUSAL IS NOT NOTHING, THOUGH, and it is deliberately not swallowed here.
   * `setWaitFor` throws a `QueueRoutingRefusal` for a row a GPU has already
   * taken — the race it argues at length — and the throw crosses the preload as
   * a rejected invoke so the picker that sent it can say the sentence. Catching
   * it here would restore exactly the silence that made the race invisible.
   */
  ipcMain.handle('queue:set-wait-for', (_event, id: string, waitFor: string) => {
    queue.setWaitFor(id, waitFor);
  });

  ipcMain.handle('engine:info', () => engineInfo());
  ipcMain.handle('doctor:run', (_event, endpointUrl?: string) => runDoctor(endpointUrl));

  ipcMain.handle('settings:read', () => readSettings());
  /*
   * ── THE ENGINE'S SETTINGS ARE NOT OURS TO WRITE INSIDE A HOST ─────────────
   *
   * `settings.json` is the ENGINE's, machine-global, and hosted the host runs
   * that same engine with that same file (docs/BOOKFORGE-HANDOFF.md). A person
   * changing the mode or the endpoint on this screen inside BookForge would be
   * reconfiguring the host's own conversions from a window that does not own
   * them. The form is hidden there, and this is the door behind it: something
   * reachable by an IPC message must refuse at the door as well, or the hiding
   * is a decoration (`refuseHostedRegistryChange`'s rule, crucible-registry.ts).
   *
   * Found by BookForge's audit, 2026-09-14, unguarded on both sides.
   */
  ipcMain.handle('settings:write', (_event, patch: BackendSettingsPatch) => {
    if (hosted()) {
      throw new Error(
        'The engine\'s settings belong to the application Foundry is running inside, which '
        + 'runs the same engine. Change them there.',
      );
    }
    return writeSettings(patch);
  });

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    shell.showItemInFolder(path.resolve(target));
  });

  /*
   * ── WHAT USED TO BE HERE: `wsl:*` AND `backend:setup-*` ───────────────────
   *
   * Four doors that listed WSL distros, asked one of them what it could build
   * with, and ran a conda/venv build of vLLM inside it while streaming the
   * guest's output over `backend:setup-log`. All four went on 2026-09-13 with
   * the launcher they fed (docs/SLOTS.md §6, package B). This app does not
   * build a vLLM, does not start one, and does not ask about WSL. The local
   * page reader below is what reads pages on this machine now, and a vLLM
   * somebody else runs is reached the way every other server is: by its URL.
   */

  // ── The prebuilt environments ────────────────────────────────────────────
  ipcMain.handle('env:catalog', () => catalogForThisMachine());

  // An install is QUEUED, never awaited across IPC. The download is minutes to
  // an hour, and a renderer reload that dropped the promise would leave a job
  // running that nothing was left to report to — the same reason conversions
  // live in main. The shelf and `env:install-progress` carry the rest.
  ipcMain.handle('env:install', (_event, request: EnvInstallRequest) =>
    queue.enqueueEnvInstall(request).id);
  // Through the QUEUE, so the row ends as `cancelled` rather than as a failure
  // whose error text happens to read "Cancelled."
  ipcMain.handle('env:cancel', () => { queue.cancelEnvInstalls(); });

  ipcMain.handle('env:choose-dest', async (_event, defaultPath: string) => {
    const win = foundryWindow() ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: 'Where should the environment go?',
      defaultPath,
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  /*
   * ── THE LOCAL PAGE READER IS GONE, AND WITH IT EIGHT DOORS ─────────────
   *
   * `page-reader:state`, `:install`, `:install-cancel`, `:start`, `:stop`,
   * `:set-keep-warm`, and the `:progress` / `:status-changed` pushes.
   *
   * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
   * there sohuldnt be a local system. foundry does all ai work through
   * crucible."* Reading a page wants a GPU, so it belongs to an engine. The
   * settings card went first, then the queue's fallback, then the gate that
   * lit the OCR tile with no engine, then the first-run step that sold the
   * download -- this is the machinery all four stood on.
   *
   * `models:inventory` and `models:remove-page-reader` went with them for a
   * smaller reason: they served the "Models on this machine" card, which Owen
   * deleted as unnecessary, and nothing else ever called either one.
   */

  // ── First run ────────────────────────────────────────────────────────────
  /*
   * THE WIZARD'S DOORS. Every one of them is also reachable from the settings
   * screen, which is the whole design: setup is the first-run ARRANGEMENT of
   * questions the app can already answer, not a separate mechanism. Nothing
   * below is exclusive to it.
   *
   * `system:probe` takes a force flag because the one case where the hardware
   * answer goes stale inside a process is somebody installing a GPU driver and
   * pressing Check again — see the cache argument in system-probe.ts.
   */
  ipcMain.handle('setup:state', () => setupState());
  ipcMain.handle('setup:finish', (_event, skipped: string[], prepare?: boolean) => {
    const choices = Array.isArray(skipped) ? skipped : [];
    if (prepare === true && !choices.includes('routes')) return finishPreparedSetup(choices, prepareFoundryForUse);
    return finishSetup(choices);
  });

  ipcMain.handle('system:probe', (_event, force?: boolean) => probeSystem(force === true));

  /*
   * ── TWELVE DOORS STOOD HERE: `ollama:*` AND `llm:*` ─────────────────────────
   *
   * Owen, 2026-09-15: *"we dont have any local models. crucible handles all
   * model orchestration. if theres no connected crucible server then tiles
   * should be disabled."* So there is no model for this app to name, no lineup
   * for it to offer, and nothing for it to pull:
   *
   *   `ollama:facts`, `ollama:choices`, `ollama:install`, `ollama:install-cancel`,
   *   `ollama:pull`, `ollama:pull-cancel`, the `ollama:progress` push, `llm:stored`,
   *   `llm:defaults`, `llm:set-model`, `llm:set-clean-model`, `llm:ollama-url` and
   *   `llm:set-ollama-url`.
   *
   * The MODEL a request names is the engine's capability record's `selected`
   * (crucible docs/PHASE15-HOST.md §3.3), applied at the spawn by the placement
   * (`doorArgs`, electron/job-queue.ts). A person choosing one in Foundry was
   * choosing something that was then ignored, which is the defect rather than
   * the feature. Where the text work runs IS still configurable from this app —
   * `crucible:engine-settings*` writes the ENGINE's own settings through
   * `PUT /v1/settings`, route and upstream per class, and that pass-through is
   * untouched. What went is Foundry keeping a model of its own.
   *
   * Ollama is still PROBED, by exactly one caller that is not a door:
   * `machine-models.ts`, which counts what is on this disk (docs/SLOTS.md §5b).
   */

  /*
   * ── THE SERVER REGISTRY AND THE SLOTS DERIVED FROM IT ─────────────────────
   *
   * docs/SLOTS.md §6 (Package C). Five doors, and the count is deliberately
   * small: the whole registry is written in one message (see
   * `writeCrucibleServers` for why add/remove/rename/reorder/enable cannot be
   * five doors onto an ordered array), and nothing here ever carries a token in
   * either direction. `crucible:settings` is the card's one read, and
   * `slots:list` is the same list on its own for the queue's picker, which has
   * no business knowing what a registry is.
   */
  ipcMain.handle('crucible:settings', () => crucibleSettingsView());
  ipcMain.handle('crucible:save', async (_event, servers: CrucibleServerEdit[]) => {
    /*
     * READ BEFORE THE WRITE, because the only thing that can say which servers
     * this save CONNECTED us to is the pair of lists (see
     * `serversConnectedBySave`). Names and flags only — no token is read here
     * and none is compared.
     */
    const before = crucibleServers().map((entry) => ({ name: entry.name, enabled: entry.enabled }));
    writeCrucibleServers(servers);
    await afterRegistryChanged();
    /*
     * A SERVER THAT WAS JUST SWITCHED ON, OR JUST NAMED, IS A SERVER THIS APP
     * HAS JUST CONNECTED TO (PHASE14 §4a). Not awaited: a save must not sit on
     * a catalog read, let alone on a half-hour wait for somebody else's card,
     * and the row draws the run's own state as it arrives.
     */
    for (const name of serversConnectedBySave(before, crucibleServers())) {
      void coordinateWithServer(name, 'it was added or switched back on');
    }
    /*
     * THE WHOLE VIEW, not just the list, because saving a server CHANGES THE
     * SLOTS — enabling a loopback entry takes the local slot away — and a card
     * that redrew its list from this answer and its slot preview from a second
     * read would draw one repaint of the two disagreeing.
     */
    return crucibleSettingsView();
  });
  ipcMain.handle('crucible:test', (_event, name: string) => probeCrucible(name));
  /**
   * TEST AN ADDRESS AND A TOKEN THAT ARE NOT SAVED YET — the setup wizard's
   * Connect door, which has three boxes and no registry entry behind them.
   *
   * The token crosses this wire ONE WAY ONLY, into main, out of a box somebody
   * is typing in. It is used for one request and dropped; nothing stores it and
   * no answer carries it back (`CrucibleProbe` has no token field). That is the
   * same rule the registry keeps — see crucible-registry.ts's header.
   */
  /*
   * A SERVER'S OWN OPERATOR PAGE, opened by NAME so no credential crosses to
   * the renderer. The window it opens has no preload and cannot reach this
   * app (electron/crucible-ui.ts says why, at length). Named `crucible:open`
   * rather than BookForge's `crucible:open-ui`, so the two apps' channels stay
   * distinct in a vendored build.
   */
  ipcMain.handle('crucible:open', (_event, name: string) => { openCrucibleUi(name); });
  ipcMain.handle('crucible:test-at', (_event, url: string, token: string) =>
    probeCrucibleAt(url, token));
  /**
   * ADD ONE SERVER — the wizard's Add, through the registry's one writer.
   *
   * Answered with the whole settings view for `crucible:save`'s reason: adding a
   * loopback server changes the SLOTS, and a caller that redrew a list without
   * the slots would be showing a picker that is about to be wrong.
   */
  ipcMain.handle('crucible:add', async (_event, name: string, url: string, token: string) => {
    addCrucibleServer(name, url, token);
    await afterRegistryChanged();
    /*
     * A SERVER THAT HAS JUST BEEN ADDED IS A SERVER THIS APP HAS JUST CONNECTED
     * TO (PHASE14 §4a), so it is coordinated with immediately. The NAME the
     * registry stored is used rather than the one that was typed, because
     * `addCrucibleServer` normalises whitespace and a coordination run keyed on
     * an un-normalised name would be a second row under a name no card draws.
     */
    const stored = crucibleServers().find(
      (entry) => entry.name.toLowerCase() === tidySlotName(name).toLowerCase(),
    );
    if (stored !== undefined) void coordinateWithServer(stored.name, 'it was added');
    return crucibleSettingsView();
  });
  ipcMain.handle('crucible:add-local', async (_event, name: string) => {
    const answer = await addLocalCrucible(name);
    if (answer.outcome === 'added') {
      await afterRegistryChanged();
      /*
       * THE SAME MOMENT, one door along — and the name is the ANSWER's, not the
       * argument's: `addLocalCrucible` falls back to the server's own name when
       * the box was left empty, so the argument may be the empty string while a
       * row called "crucible" now exists.
       */
      const added = crucibleServers().find((entry) => entry.url === answer.url);
      if (added !== undefined) {
        void coordinateWithServer(added.name, 'the Crucible on this machine was registered');
      }
    }
    return answer;
  });
  /*
   * ── PHASE15 §5.1's THREE WAYS IN, IN ITS ORDER ────────────────────────────
   *
   * 1. THE PAIRING FILE ON THIS MACHINE. Read once at start (electron/mount.ts)
   *    and again whenever somebody presses "Look again on this machine" — the
   *    same function, because the second press is for the case §3.6 names: the
   *    engine was installed AFTER this app started, so the answer that was
   *    honest at start ("there is nothing here") has stopped being true. It is a
   *    BUTTON and not a watcher on purpose: a filesystem watch on a directory
   *    Crucible's installer creates would have this app reacting to a file
   *    appearing mid-keystroke, and "press it when you have installed one" is a
   *    sentence a person can act on.
   */
  ipcMain.handle('crucible:add-from-pairing-file', () => adoptPairingFile());
  /*
   * 2. A PASTED CONNECT CODE, in three doors that all take THE LINE.
   *
   * The preview answers NAME AND ADDRESS ONLY (`ConnectCodePreview` argues the
   * shape at length): the renderer fills its two boxes from it so a person can
   * rename before adding, and the token never crosses the preload in either
   * direction. Test and Add re-read the same line in main. Three doors rather
   * than one for the reason `crucible:test-at` is not `crucible:add`: testing an
   * address in order to find out whether it is a Crucible must not write
   * anything, and previewing must not dial anybody at all — it runs on every
   * keystroke of a paste.
   */
  ipcMain.handle('crucible:parse-connect-code', (_event, line: string): ConnectCodePreview => {
    const read = readConnectCode(line);
    return read.read
      ? { outcome: 'read', name: read.pairing.name, url: read.pairing.url }
      : { outcome: 'refused', message: read.message };
  });
  ipcMain.handle('crucible:test-connect-code', async (_event, line: string): Promise<CrucibleProbe> => {
    const read = readConnectCode(line);
    // A REFUSAL IS A RESULT HERE, not a rejection, because the door it is drawn
    // in already draws `CrucibleProbe.outcome === 'failed'` — one sentence, one
    // place to look, whether the line was unreadable or the server was.
    if (!read.read) return { outcome: 'failed', message: read.message };
    return probeCrucibleAt(read.pairing.url, read.pairing.token);
  });
  /*
   * Add, through {@link registerPairing} — which is the SAME writer the pairing
   * file's road uses, because a pairing file is this line on disk and Owen's
   * ruling is that the two are *"entered the exact same way"*. The NAME is the
   * caller's: the preview filled a box with the code's own name and somebody may
   * have renamed it before pressing, and a door that re-read the name out of the
   * line would silently throw that away. An EMPTY name falls back to the code's,
   * which is what pressing Add on an untouched preview means.
   *
   * IT REJECTS BY NAME on a line that will not parse, rather than answering a
   * view: this is the door that WRITES, and everything that writes the registry
   * in this file rejects rather than returning a failed shape.
   *
   * AND IT COORDINATES, which it did not before this door and the pairing file's
   * shared one writer: PHASE14 §4a's moment is *a server being added*, and
   * `crucible:add` beside it has always taken that pass. A server added by
   * pasting a code was the one road into the registry that did not, which is a
   * card this app would then have found missing at the first job instead of now.
   */
  ipcMain.handle('crucible:add-connect-code', async (_event, line: string, name: string) => {
    const read = readConnectCode(line);
    if (!read.read) throw new Error(read.message);
    const stored = registerPairing(read.pairing, name);
    await afterRegistryChanged();
    void coordinateWithServer(stored, 'it was added from a connect code');
    return crucibleSettingsView();
  });

  /*
   * ── THE ENGINE'S OWN SETTINGS — four doors onto somebody else's store ─────
   *
   * Wave 62 package I, to crucible `docs/PHASE15-HOST.md` §3.1, §3.2, §3.3 and
   * §5.2. Owen's ruling: the GPU engine is the SINGLE SOURCE OF TRUTH for AI
   * settings — *"If the user enters an anthropic api key, it should pass through
   * to crucible"* — so these four doors READ AND WRITE A REMOTE STORE and touch
   * `app-settings.json` not at all. §5.2: *"every control in these sections is a
   * request to the engine, and its result is the engine's answer re-read. There
   * is no Save button that writes an app file and syncs later."*
   *
   * THEY TAKE A SERVER NAME, not a url and not a token. That is the registry's
   * rule (`crucible:open`'s argument, one family up): the address and the
   * credential are looked up in main, so nothing the renderer holds could reach
   * an engine this app has not been told about.
   *
   * AND THE KEY CROSSES ONE WAY. `crucible:engine-settings-put` carries an
   * unsaved key inward and `crucible:engine-upstream-test` carries one inward to
   * be used once and dropped; no answer on any of the four carries a credential
   * back, because the document has `key_hint` — the last four characters — where
   * the engine has a key. Same rule, same sentence, as `CrucibleServerView`'s
   * `tokenSet` and `CloudProviderView`'s `keySet`.
   *
   * `engine-` RATHER THAN MORE BARE `crucible:` MEMBERS, because the family
   * already means "this app's registry of servers" and these are not about the
   * registry at all: they are about what ONE of those servers has been
   * configured to do. A reader of the channel list can tell the two apart.
   */
  ipcMain.handle('crucible:engine-settings', (_event, serverName: string) =>
    readEngineSettings(namedServerOr(serverName)));
  /**
   * WRITE THROUGH, AND REDRAW FROM THE ANSWER.
   *
   * The PUT answers the whole document after the write (§3.2), so this hands
   * that straight back and the card never guesses what took. A refusal arrives
   * as a REJECTION wearing a sentence that names the field
   * (electron/crucible-settings.ts composes it) — unlike Test there is nothing
   * to draw instead, because the write did not happen and what is on screen is
   * still true.
   *
   * ── AND A ROUTE WRITE MOVES THE TILES, SO THE REGISTRY PASS RUNS ──────────
   *
   * §2: capability *"is RECOMPUTED in-process on every settings write that
   * touches a route"*, and §3.3 says every capability row carries its route. So
   * the answer to "can this machine translate" has just changed on a server this
   * app has cached (`crucible-provider.ts` holds it for fifteen seconds) and the
   * dock's tiles are drawn from that. `afterRegistryChanged` is exactly the pass
   * that forgets, re-measures and re-composes — it is named for the registry
   * because that is what used to be the only thing that moved this answer, and a
   * route write moves it identically.
   *
   * ONLY WHEN A ROUTE WAS TOUCHED. Saving a key alone configures an upstream
   * nothing routes to yet: no capability row changes, and running the pass would
   * spend a probe per server to learn that.
   */
  ipcMain.handle('crucible:engine-settings-put', async (
    _event,
    serverName: string,
    patch: SettingsPatch,
  ): Promise<SettingsDocument> => {
    const document = await writeEngineSettings(namedServerOr(serverName), patch);
    if (patch.routes !== undefined) {
      const settings = readAppSettings();
      writeAppSettings({ setupSkipped: settings.setupSkipped.filter(step => step !== 'routes') });
      await afterRegistryChanged();
      void coordinateWithServer(serverName, 'its model routes were selected');
    }
    return document;
  });
  /**
   * WHAT MODEL IDS THIS CREDENTIAL CAN USE — and it is the only list there is.
   *
   * §2: *"the server does not ship a cloud model list"*, and neither does this
   * app: the Cloud card already argued that a catalog compiled into a build is
   * wrong by the next release and confidently so. The engine asks the upstream's
   * own listing, unbilled, and the card shows THAT.
   *
   * `probe` IS THE UNSAVED CREDENTIAL, or absent for whatever is configured —
   * `crucible:test-at`'s argument one wire along: saving a key in order to find
   * out whether it works would be this app writing into somebody's engine to
   * answer a question. A failure is a RESULT, not a rejection, so the card can
   * print it beside the box.
   */
  ipcMain.handle('crucible:engine-upstream-test', (
    _event,
    serverName: string,
    upstream: UpstreamName,
    probe?: UpstreamProbe,
  ) => testUpstream(namedServerOr(serverName), upstream, probe));
  /**
   * THE CAPABILITY RECORD, BY SERVER NAME — the wizard's routes step, and the
   * one question it asks that the settings document cannot answer.
   *
   * §5.2: *"the wizard's AI step reads capability; for each llm class that is
   * `enabled: false` locally it says the class's reason and offers 'run it
   * through Anthropic / OpenAI / an Ollama server instead'."* The REASON is the
   * server's own sentence about why a class will not run on its card, and
   * nothing in `/v1/settings` carries it.
   *
   * IT IS `readCapability`, THE DISPATCHER'S OWN READER, and not a second one:
   * the shape of a capability record and the mapping of its refusals onto the
   * SDK's error types is exactly the kind of thing that is written twice and
   * then only fixed once (crucible-dispatch.ts says so where it exports it).
   */
  ipcMain.handle('crucible:engine-capability', (_event, serverName: string) =>
    readCapability(namedServerOr(serverName)));

  /**
   * WHICH ENGINE CAN DO THIS ACT — the first one that serves the class, or null.
   *
   * ── Why this is not `engine-capability` in a loop ─────────────────────────
   *
   * That door is a LIVE READ of one server (`readCapability` dials
   * `/v1/capability`), so asking it about every registered engine to find a
   * capable one would open a dialog by making N network calls, on a screen a
   * person is about to press a button on. This is the cached mirror the ACT
   * GATES already decide on — no traffic, already loopback-ranked, and the same
   * answer the tile in the dock is drawn from.
   *
   * ONE SOURCE FOR "WHO CAN DO THIS". A dialog that worked it out separately
   * would be a second opinion about the same question, and the two would
   * disagree the first time a probe lagged.
   */
  ipcMain.handle('crucible:serves', (_event, cls: ModelClass) => anyServerServing(cls));

  /**
   * THE PROGRESS LIST FOR "INSTALL CRUCIBLE HERE", composed for this machine.
   *
   * A READ, and it changes nothing. It is no longer a sequence for a person to
   * perform: PHASE19 §3.1 makes it the rows the install fills in while it runs,
   * and §0 removed the one command that used to sit under the first of them.
   */
  ipcMain.handle('crucible:install-plan', () => crucibleInstallPlan());
  /*
   * THE SEAM, BUILT ONCE (electron/crucible-install-door.ts). It is the SDK's
   * `installStatus()` / `watchInstall()` / `POST /install` now; the pre-SDK
   * stopgap part 1 shipped is gone, and this one expression was the whole of
   * the swap.
   */
  const installDoor = crucibleInstallDoor();
  installDoor.watch((event) => broadcast('crucible:install-event', event));
  /**
   * THE RUN, AND WHAT MUST HAPPEN AFTER IT, in one place.
   *
   * Two doors reach it — the Install button and §2.5's Try again — and they
   * must not differ in their tail: an install that registered the engine but
   * never coordinated leaves a connected server with none of the environments
   * this app asked for, and which of the two buttons was pressed has nothing
   * to do with that.
   *
   * ── COORDINATE WAITS FOR A TERMINAL OUTCOME (PHASE19 §2.8) ────────────────
   *
   * Coordinate-on-connect is what installs job environments and pulls weights,
   * and under PHASE20 those are gigabytes. Run against the NATIVE engine on a
   * machine that is mid-move they land on Windows and make migrate-weights
   * expensive for nothing, so the app waits and then coordinates once, against
   * whichever engine is left standing. `failed` is deliberately not terminal:
   * the tray retries it once (§2.2), and coordinating over a move that is
   * about to start again is the same mistake one attempt later.
   *
   * The gate is asked HERE and not inside the run, because it is a statement
   * about what this app does NEXT, and the run's own business is finished.
   */
  const runInstallAndCoordinate = async (run: () => Promise<void> = runInstallNarrated) => {
    await run();
    await afterRegistryChanged();
    const outcome = (await installDoor.status()).outcome;
    if (outcome !== null && !TERMINAL_OUTCOME_STATES.includes(outcome.state)) return;
    for (const entry of crucibleServers().filter((entry) => entry.enabled)) {
      void coordinateWithServer(entry.name, 'Crucible was installed');
    }
  };
  /**
   * THE DRIVEN INSTALL — and it refuses, today, by name.
   *
   * The button is disabled in the renderer with the same sentence this throws,
   * and the door refuses anyway: something reachable by an IPC message must
   * refuse at the door as well, or the disabling is a decoration (the Servers
   * card's hosted refusal makes the same argument). The refusal it still makes
   * is the HOSTED one — "Install Crucible from BookForge." — which PHASE19 §5
   * keeps by name; `@crucible/bootstrap` has been vendored since 1.0.0 and the
   * run itself is real.
   */
  ipcMain.handle('crucible:install', () => runInstallAndCoordinate());
  /*
   * ── THE INSTALL DOOR'S THREE READS, PHASE19 §2.6 ──────────────────────────
   *
   * `status` and `event` used to be one thing — a string per line, pushed to
   * the window that pressed the button, gone the moment that window looked
   * away. §2.6 splits them because the move outlives the press: the tray runs
   * it, a restart happens in the middle, and the app that comes back has to be
   * able to ASK where it got to rather than only to have been listening.
   *
   * The watch is BROADCAST and not sent to the pressing window: a person who
   * opens Settings while the wizard is installing is looking at the same one
   * machine, and a second window drawing an empty list would be this app
   * pretending the install belongs to a window.
   */
  ipcMain.handle('crucible:install-status', () => installDoor.status());
  ipcMain.handle('crucible:install-retry', () => runInstallAndCoordinate(installDoor.retry));
  /**
   * RESTART NOW — §2.3, and it is the only thing in Foundry that reboots a
   * machine.
   *
   * `shutdown.exe /r /t 5` AS THE INTERACTIVE USER: no elevation, because
   * restarting your own session needs none, and the five seconds are what let
   * somebody see the window acknowledge the press. It runs ONLY when pressed —
   * §2.3 is explicit that "the reboot is never taken by Crucible", and this
   * door is a person's press crossing the preload, never a consequence of
   * reading an outcome.
   *
   * `detached` and `unref` because Electron is about to be killed by the very
   * process it spawned; a child still parented to a dying main is a race with
   * nothing to win.
   */
  ipcMain.handle('crucible:restart-windows', () => {
    if (process.platform !== 'win32') {
      throw new Error('Only Windows asks for a restart to finish setting up its engine.');
    }
    const child = spawn('shutdown.exe', ['/r', '/t', '5'], { detached: true, stdio: 'ignore' });
    child.unref();
  });
  /*
   * ── UNINSTALL: THREE DOORS, AND THE FIRST ONE DECIDES THE OTHER TWO ───────
   *
   * crucible `docs/INSTALL-UNINSTALL.md` §6.1, and Owen's ruling with it: the
   * door is drawn only for a server this app can PROVE is this machine's, and
   * never for a registry entry as such. `crucible:uninstall-availability` is
   * that one proof — the card asks it before it draws a button and both doors
   * below refuse on it as well, because a control that is hidden over a door
   * that is open has been decorated rather than locked.
   *
   * Everything about what is invoked, and why win32 needs `cmd.exe` to run a
   * `.cmd`, is in electron/crucible-uninstall.ts. Nothing about it is composed
   * here; these three are a read and two runs.
   */
  ipcMain.handle('crucible:uninstall-availability', () => crucibleUninstallAvailability());
  /**
   * THE PLAN, UNPERFORMED — §6.4 step 1, and the card re-asks it every time a
   * checkbox moves so the kept-weights headline moves with it.
   *
   * An exit code of 1 is still a plan (§6.2): the JSON's `ok: false` names the
   * one step that failed and the others happened. Only a usage error and a
   * document that is not a document are rejections — see the module.
   */
  ipcMain.handle('crucible:uninstall-dry-run', (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallPlan> => crucibleUninstallDryRun(flags));
  /**
   * THE REAL RUN, and the one thing Foundry does afterwards that the verb cannot.
   *
   * §2's box: *"THE TOKEN ALWAYS GOES, on every uninstall, including the default
   * one."* So a run that stopped the engine has left the registry row pointing at
   * it holding a dead credential, and the row goes — through the registry's one
   * writer, followed by `afterRegistryChanged`, which is what every other write
   * in this file does and what keeps the dock's gates and the slot list honest.
   *
   * ONLY WHEN THE PROOF NAMED A ROW. A `windows-host` proof says a host is
   * installed on this computer and says nothing about which entry, if any, points
   * at the engine it drives; removing a row on that basis would be the app
   * guessing at exactly the thing §6.1 forbids guessing at.
   *
   * COORDINATION STATE IS LEFT TO THE NEXT CONNECT, deliberately. The map in
   * crucible-coordinate.ts is keyed by registry name, the Servers card looks a
   * row's state up BY the row's name, and there is no row any more — so the
   * stale entry draws nothing anywhere. Registering a server under that name
   * again coordinates afresh and overwrites it. Clearing it would mean a new
   * export from that module for an entry nobody can see.
   */
  ipcMain.handle('crucible:uninstall', async (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallRun> => {
    const availability = await crucibleUninstallAvailability();
    const plan = await crucibleUninstallPerform(flags);
    if (availability.server === null || !uninstallStoppedTheEngine(plan)) {
      return { plan, unregistered: null };
    }
    removeCrucibleServer(availability.server);
    await afterRegistryChanged();
    console.log(
      `[crucible] "${availability.server}" was removed from the registry: its engine was `
      + 'uninstalled from this computer and the token went with config.toml.',
    );
    return { plan, unregistered: availability.server };
  });
  ipcMain.handle('crucible:set-wsl-distro', (_event, distro: string) =>
    writeAppSettings({ wslDistro: distro }).wslDistro);
  /**
   * THE LIVE QUEUE'S DIAL — Owen's *"global crucible server option"*.
   *
   * ANY NAME IS ACCEPTED, including one no server currently answers to, and the
   * clamp is the only thing between the argument and the file. That is the same
   * decision BookForge took and for the reason they gave: a dial pointing at a
   * machine somebody has switched off must KEEP its value, or turning a server
   * off would silently re-point the queue at a different one. "Switched off",
   * "renamed" and "never existed" are one state to a settings writer, and the
   * PLACEMENT is where they are told apart and said out loud.
   *
   * The pump is woken because a dial that has just been widened is a dial that
   * may have unparked something, and a board that has gone quiet would otherwise
   * sit on that row until somebody pressed something else.
   */
  /**
   * IS THERE A CRUCIBLE HERE THAT IS NOT RUNNING, AND SHALL WE START IT?
   *
   * Owen, 2026-09-15 (relayed): *"the foundry app should ask if they want to
   * start crucible."* Standalone only — `crucibleRunState` answers `not-ours`
   * hosted, and that becomes `answered: 'later'` below, so the vendored copy
   * inside BookForge draws no card. BookForge has already offered by the time
   * anybody reaches Foundry there.
   *
   * ANSWERED RATHER THAN ASKED IS THE ORDINARY CASE, and it is why this is a
   * question door rather than a state read the renderer branches on: running,
   * absent, unhealthy and hosted all resolve without a card, so nothing flickers
   * on the startups where there is nothing to say.
   *
   * ── THE THREE ANSWERS, AND WHY SILENCE IS ONE OF THEM ───────────────────
   *
   * Owen met the old version of this door on 2026-09-17 with a perfectly healthy
   * engine and was told to repair his installation, because every state that was
   * not `running`, `stopped` or `absent` came through as one word and drew one
   * card. electron/crucible-start.ts carries the full account of what had really
   * happened — a three-second timeout on `/v1/info` — and why the fold is gone.
   * What is left here is the consequence:
   *
   *   * `stopped` and `unreachable` compose the OFFER. Something is installed
   *     and nothing is serving, and the press is the repair.
   *   * `unhealthy` composes NOTHING. It answered its ping, so there is nothing
   *     to start; and the Servers card watches that machine continuously, so a
   *     card here would be a second, worse voice on a question already covered.
   *     It is logged, because somebody reporting "it feels slow" deserves to
   *     have this line in the file.
   *   * `problem` composes the alarm — and now only ever over a fault in the
   *     installation, in that fault's own words rather than in a sentence that
   *     names two possibilities and then an action fitting one of them.
   *
   * THE CARD NAMES THE MANAGED SERVICE, NOT A ONE-OFF RUN, because the thing a
   * person is agreeing to is something that stays up after Foundry closes, which
   * is a different promise from "run this once" and one they should make
   * knowingly.
   */
  ipcMain.handle('crucible:offer-start', async (): Promise<Asked<'start' | 'later'>> => {
    const state = await crucibleRunState();
    if (state.kind === 'problem') {
      const words = crucibleFaultWords(state.fault);
      return {
        kind: 'ask', question: {
          title: words.title, message: state.why, detail: words.detail,
          choices: [{ key: 'later', label: 'Close' }], preferred: 'later',
          dismissed: 'later', checkbox: null,
        },
      };
    }
    if (state.kind === 'unhealthy') {
      console.log(
        `[crucible] the local engine answered its ping and did not finish the rest: ${state.why}. `
        + 'Nothing is offered — there is nothing to start, and nothing here repairs a slow '
        + 'answer. The Servers card has it from now on.',
      );
      return { kind: 'answered', answer: 'later' };
    }
    if (state.kind !== 'stopped' && state.kind !== 'unreachable') {
      return { kind: 'answered', answer: 'later' };
    }
    return {
      kind: 'ask',
      question: {
        title: 'Start Crucible?',
        /*
         * TWO SENTENCES FOR TWO STATES, because they are different facts and a
         * person who reads "is stopped" about a machine whose tray icon they can
         * see has been told something they know to be false. `unreachable` is the
         * one where Crucible believes it is up and nothing is answering.
         */
        message: state.kind === 'stopped'
          ? 'Crucible is installed on this computer and is stopped.'
          : 'Crucible is installed on this computer and is not answering.',
        detail: [
          'Crucible is the GPU engine. Translation, simplification, cleanup, analysis and page '
          + 'reading all run on it, and none of them can run while it is stopped. Opening a book, '
          + 'compiling one and exporting one are unaffected.',
          'Crucible starts its managed service. It stays running after Foundry closes.',
        ],
        choices: [
          { key: 'start', label: 'Start Crucible' },
          { key: 'later', label: 'Not now' },
        ],
        preferred: 'start',
        dismissed: 'later',
        checkbox: null,
      },
    };
  });
  /**
   * THE PRESS. Answered with a SENTENCE and never with a throw: every way this
   * can end — started, launched-but-still-coming-up, nothing here to start — is
   * a fact somebody should read, and a rejected invoke would arrive at the
   * renderer as an unhandled error with the interesting half missing.
   */
  ipcMain.handle('crucible:start', async () => {
    const result = await startCrucible();
    if (result.started) await connectLocalEngine();
    return result;
  });
  /**
   * WHAT THIS ENGINE HOLDS AND COULD HOLD — `GET /v1/catalog`, mapped.
   *
   * A READ AND NOTHING ELSE: it downloads nothing, loads nothing onto a card,
   * and is safe against a machine somebody is using. The card calls it on open
   * and after a pull lands, which is when the answer changes.
   */
  ipcMain.handle('crucible:catalog', (_event, server: string) => engineCatalog(server));
  /**
   * FETCH ONE SUBJECT. Answered with the TASK ID, not with the finished pull.
   *
   * A model is gigabytes over somebody's line, so the progress arrives on
   * `crucible:pull-progress` afterwards rather than this handler holding a
   * promise for an hour — a renderer cannot even be told about one that long.
   * Every frame carries the server, the kind and the id, so a card with two
   * pulls running places them without keeping a map of its own.
   */
  ipcMain.handle('crucible:pull', (_event, server: string, kind: string, id: string) =>
    pullSubject(server, kind, id, (progress) => {
      broadcast('crucible:pull-progress', progress);
    }));
  /**
   * ARE YOU SURE — composed in MAIN, because main is what knows the size.
   *
   * The SDK's condition on the remove door survives Owen's reversal of who may
   * call it: *"An app does not call this on a user's behalf without saying so on
   * screen."* So the press goes through the same card every destructive question
   * in this app uses, and the card is given the FIGURE — a person deciding
   * whether to free 17.3 GB is deciding something different from a person told
   * only that a file will go.
   *
   * `keep` is the dismissal, and it is the safe half: a question nobody answered
   * has not been agreed to.
   */
  ipcMain.handle(
    'crucible:confirm-remove-model',
    (_event, ask: { server: string; id: string; name: string | null; bytes: number | null }):
    Asked<'remove' | 'keep'> => ({
      kind: 'ask',
      question: {
        title: 'Remove these weights?',
        message: `"${ask.name ?? ask.id}" will be deleted from ${ask.server}`
          + `${ask.bytes === null ? '' : `, freeing ${(ask.bytes / 1024 ** 3).toFixed(1)} GB`}.`,
        detail: [
          'The files are removed from that machine. Nothing on this computer changes, and no '
          + 'book that was already made with this model is affected — a finished step keeps its '
          + 'text and its record of what produced it.',
          'Fetching it again later is one press and the same download. What you are spending to '
          + 'get it back is time and bandwidth, not work.',
        ],
        choices: [
          { key: 'keep', label: 'Keep it' },
          { key: 'remove', label: 'Remove' },
        ],
        preferred: 'keep',
        dismissed: 'keep',
        checkbox: null,
      },
    }),
  );
  /**
   * AND THE REMOVAL ITSELF. The server's four refusals arrive as they are —
   * `subject_in_use` naming what holds it is a different thing to do about it
   * than `subject_remove_failed` naming a file that would not go.
   */
  ipcMain.handle('crucible:remove-model', (_event, server: string, kind: string, id: string) =>
    removeModel(server, kind, id));
  ipcMain.handle('crucible:set-queue-gpu-dial', (_event, dial: string) => {
    const stored = writeAppSettings({ queueGpuDial: dial }).queueGpuDial;
    queue.venueRulesChanged();
    return stored;
  });
  ipcMain.handle('crucible:set-new-jobs-wait-for', (_event, choice: NewJobsWaitFor) =>
    writeAppSettings({ newJobsWaitFor: choice }).newJobsWaitFor);
  /*
   * ── COORDINATION: THE BUTTON THAT IS NOT THERE ────────────────────────────
   *
   * crucible `docs/PHASE14-ENVPACKS.md` §4a. There is no "set up this server
   * for Foundry" verb and no consent step: presence of the app is the request,
   * so Foundry coordinates with every enabled server it connects to and a
   * screen only ever READS the state. `electron/crucible-coordinate.ts` is the
   * one owner — these two doors start a run and read the map, and neither
   * composes a sentence, because the words are the renderer's
   * (`src/app/core/crucible-words.ts`; R1).
   */
  ipcMain.handle('crucible:coordination', () => coordinationStates());
  /**
   * Coordinate with one named server NOW, and answer the state it reached.
   *
   * Idempotent and concurrency-safe in `crucible-coordinate.ts`: a second call
   * while one is in flight joins the first. So the start sweep and a card that
   * asks about the same server a moment later are ONE run, not two — which is
   * the `task_busy` this whole design exists to avoid, manufactured by us.
   *
   * IT IS A DOOR AND NOT A BUTTON. Nothing in this app draws a control that
   * calls it; it exists so a screen that has just learnt about a server can ask
   * about that server rather than waiting for a push that has already been sent.
   */
  ipcMain.handle('crucible:coordinate', (_event, name: string) => coordinateServer(name));
  /*
   * ── THE CLOUD PROVIDERS — Package F's app half (docs/SLOTS.md §3) ─────────
   *
   * THREE DOORS, and a family of their own rather than three more members of
   * `crucible:`. That is this app's own advice taken twice over. Once because a
   * provider IS NOT A CRUCIBLE: it has no capability record, nothing resident,
   * no lease and no busy state, and a card reading `crucible:save` to write an
   * OpenAI key would teach that they are one kind of thing. And once because
   * `crucible:` is a family BookForge does not have and `cloud:` is one neither
   * side has — the cheapest possible answer to the collision audit that is still
   * open (docs/IPC-CHANNELS.md).
   *
   * NO KEY CROSSES IN THE ANSWER DIRECTION, ever. The renderer is told
   * `CloudProviderView.keySet` and may send a new key, which is the whole of
   * what a write-only field means — `crucible:`'s token rule, one registry
   * along.
   */
  ipcMain.handle('cloud:settings', () => cloudSettingsView());
  ipcMain.handle('cloud:save', async (_event, providers: CloudProviderEdit[]) => {
    writeCloudProviders(providers);
    /*
     * `gatesChanged` AND NOT `afterRegistryChanged`. Connecting a provider moves
     * the TILES — an enabled one lights translate, simplify, analysis and clean
     * on a machine that could not run them (act-gates.ts) — and moves nothing
     * else. The three steps `afterRegistryChanged` takes are all about a
     * Crucible: forgetting capability answers nobody asked a provider for,
     * re-probing servers that have not changed, and §5b's page-reader deletion,
     * which a cloud provider can never trigger because it does not serve
     * `pages` at all.
     */
    gatesChanged();
    /*
     * THE WHOLE VIEW for `crucible:save`'s reason: enabling a provider CHANGES
     * THE SLOTS, and a card that redrew its list from this answer and its slot
     * preview from a second read would draw one repaint of the two disagreeing.
     */
    return cloudSettingsView();
  });
  /**
   * TEST — the model listing at the provider, and whether the chosen id is in it.
   *
   * IT TAKES THE WHOLE EDIT, unsaved, which is `crucible:test-at`'s argument for
   * a card that has only one Test button: somebody pastes a key and types a
   * model and wants to know whether the pair is right BEFORE it is written to
   * disk, and saving first in order to find out would be this app writing a
   * credential into somebody's settings to answer a question. A key on this wire
   * goes ONE WAY, into main, out of a box somebody is typing in; `apiKey: null`
   * means "the one already stored for this name", and no answer carries either.
   */
  ipcMain.handle('cloud:test', (_event, provider: CloudProviderEdit) => probeCloud(provider));

  /**
   * WHERE WORK MAY GO, for the picker.
   *
   * Its own door rather than a field on `crucible:settings` because the two have
   * different readers and different lifetimes: the settings card reads a picture
   * of a registry it is about to edit, and the queue reads a list of names to
   * draw beside rows. A queue page that had to ask for the registry in order to
   * draw a picker would be a page that needs the token flag and the WSL distro
   * to render a dropdown.
   */
  /*
   * THE LIST AND, WHEN THERE IS ONE, WHY IT IS EMPTY. A bare array told the
   * page "no servers" when the truth could be "there was nobody to ask" — a
   * hosted window whose host has not implemented the registry seam. The two
   * want different sentences, so the answer is typed (`SlotAvailability`,
   * shared/slots.ts) and the picker draws the refusal where the slots would be.
   */
  ipcMain.handle('slots:list', () => slotAvailability());
  /**
   * EVERY ROW OF OURS THAT NAMES THIS SLOT — what the Servers card shows before
   * it offers to move any of them. Owen's rule: told, never moved silently.
   */
  ipcMain.handle('slots:rows-waiting-for', (_event, name: string) =>
    queue.rowsWaitingFor(name));

  // ── What this machine may be asked to do, and what it holds ──────────────
  /*
   * THE TILE GATE, AND IT IS ONE DOOR FOR ALL FIVE ACTS.
   *
   * Owen, 2026-09-15: *"if theres no connected crucible server then tiles should
   * be disabled."* Every fact that decides it lives here — the server registry's
   * capability reads, the cloud providers, the settings file and the page
   * reader's directory — so the answer is composed in main and the renderer draws
   * it. Five acts in one call because they come off ONE snapshot, and a dock
   * asking separately could light Translate beside a Simplify that had just gone
   * dark. The stage gate (shared/stages.ts) is unchanged and still the
   * renderer's: that one is about the book, this one is about the venue.
   */
  ipcMain.handle('acts:gates', () => actGates());

  /*
   * WEIGHTS ON THIS DISK — docs/SLOTS.md §5b's "Models on this machine".
   *
   * The removal is the only door in this app that deletes model files, and it
   * deletes exactly one directory: the one this app downloaded into. Ollama's
   * store is listed beside it and never touched (Owen: *"ollama has its own
   * thing going on and we should leave it be"*), and a local Crucible's line
   * waits on package C. A refusal comes back as a RESULT with a sentence rather
   * than as a rejection, because the row prints what happened either way.
   */
  /*
   * The whole list on every mutation — and hosted, the whole list is the HOST's
   * (`shelfJobs`, electron/job-queue.ts). The queue hands it over already
   * composed rather than this line choosing, so the door above and this push
   * cannot answer differently.
   */
  queue.onQueueChanged((jobs) => broadcast('queue:changed', jobs));
  /*
   * THE LIBRARY CHANGED, said out loud, which it never used to be.
   *
   * The renderer's project list re-read on three occasions — it was constructed,
   * Home appeared, or a queue job landed — and a BACKGROUND IMPORT is none of
   * them. A dropped scan therefore became a project on the disk that the app went
   * on denying the existence of until something unrelated happened to refresh
   * the list, and everything that asks "which project is this document in?" was
   * reading that denial.
   *
   * No payload. The listing is main's to compose and re-composing it costs a
   * directory walk, so this says only THAT something moved; the renderer asks
   * for the list itself, the same way the queue's mirror asks for jobs on boot.
   */
  onProjectsChanged(() => broadcast('projects:changed', null));
  // Published beside the job row, not instead of it: the shelf reads the queue,
  // the settings card reads this, and neither of them owns the run.
  onEnvInstallProgress((progress) => broadcast('env:install-progress', progress));
  // The same shape one door along: main talks while the invoke is still open,
  // because an intake of a whole shoot is a minute long and a promise that
  // resolves at the end cannot say anything until there is nothing to say.
  onIntakeProgress((progress) => broadcast('capture:intake-progress', progress));

  /*
   * ── DOCS/SLOTS.MD §5b, ONCE AT STARTUP ────────────────────────────────────
   *
   * For the machine where the Crucible was installed while Foundry was closed.
   * `afterRegistryChanged` covers somebody registering the local server while
   * the app is open; neither is the whole of it alone, because a person who runs
   * `crucible install llm` in a terminal and reopens Foundry has changed nothing
   * this app was watching, and their disk is still holding four gigabytes of a
   * page reader the machine no longer needs.
   *
   * IT CANNOT FIRE HOSTED, AND NOT BY A GUARD. Inside BookForge the slot list is
   * the HOST's (SLOTS.md §3) and `AppSettings.crucibleServers` is empty, so
   * `localCrucibleServes` answers `unknown` — which is not a permission to
   * delete. That is the three-valued answer doing the work it was shaped for,
   * rather than a `hosted()` check that would have to be kept in step with a
   * rule written somewhere else.
   *
   * DELIBERATELY NOT AWAITED: it probes every registered server, and blocking
   * the mount on a sleeping Mac would put a three-second stall in front of the
   * first window for a tidy-up nobody is waiting on. A failure is logged and
   * changes nothing — the files stay, and the next registry save asks again.
   */
  /*
   * ── EVERY COORDINATION STATE CHANGE, TO EVERY WINDOW ──────────────────────
   *
   * And that is not laziness about addressing: coordination starts at APP
   * START, before any window has asked for anything, and it is the same fact
   * for the Servers card and for the wizard's Crucible step. A push aimed at
   * "the sender" would have no sender for the run that matters most.
   *
   * THE SECOND HALF IS THE ONE THAT MATTERS TO THE REST OF THE APP. A run that
   * ends `preparing` with `progress.state === 'done'` means the server SERVES
   * MORE THAN IT DID — a text engine it had not installed, a model it had not
   * pulled — and every capability answer this app has cached about it was
   * measured before that. So the registry's own pass runs: forget, re-measure,
   * apply §5b's page-reader rule, light the tiles. Wired HERE rather than
   * inside the coordinate module for the reason its header gives — which
   * windows exist and what an install does to a tile are facts about the app,
   * and that module's whole subject is one conversation with one server.
   *
   * ONLY ON `done`. A `failed` module leaves behind exactly the steps that
   * completed (R6), which is a real change, and re-measuring on it would be
   * right — but a module that failed at step 1 of 4 is also the common case for
   * a server that is mid-something, and a capability sweep per failure would
   * put a probe of every registered machine behind every stumble. The next
   * connect asks again, which is the same answer arriving a moment later.
   */
  onCoordination((state) => {
    broadcast('crucible:coordination-changed', state);
    if (state.phase !== 'preparing' || state.progress.state !== 'done') return;
    void afterRegistryChanged().catch((err: unknown) => {
      console.error(
        `[crucible] "${state.server}" finished preparing, but the capability sweep that `
        + `follows it did not: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  /*
   * ── AND THE FIRST SWEEP, ONCE AT STARTUP ──────────────────────────────────
   *
   * crucible `docs/PHASE14-ENVPACKS.md` §4a and Owen, 2026-09-14: *"lets make
   * it as simple as possible."* Every ENABLED server, in the REGISTRY'S OWN
   * ORDER, with no button and no question — the enable switch in Settings is the
   * one opt-out, because it is the control that already means "not that one".
   * It used to put the loopback entries at the front; Owen's ruling that *"a
   * local crucible server shouldnt be treated any differently than a remote
   * crucible server"* retired that, and `coordinateEveryServer` argues why the
   * operator's drag rank is the only order this app is entitled to.
   *
   * IT RUNS HOSTED TOO. The registry is the host's over there and read-only,
   * and each app still posts its OWN module: the union of the two modules on
   * one server is the contract. What is suppressed hosted is the DRAWING (the
   * Servers card is BookForge's), not the asking.
   *
   * REGISTERED AFTER THE LISTENER ABOVE, deliberately: the sweep's first
   * `checking` is published synchronously inside `coordinateServer`, so a
   * listener added afterwards would miss the first frame of the run it was
   * added for.
   *
   * DELIBERATELY NOT AWAITED, on the same reasoning as the §5b pass below: a
   * run can end in a half-hour wait on somebody else's card, and nothing on
   * screen is waiting for it. A failure is a STATE, drawn in the row; the
   * console line here is for the case where the sweep itself could not start.
   */
  void coordinateEveryServer()
    .then((states) => {
      /*
       * ONE LINE PER SERVER, once the sweep has settled. The states are already
       * pushed to every window as they move; this is for the console a person
       * reads when a window is not what they are looking at — a launch that
       * found an engine and asked it for nothing should say so, and one that
       * could not reach it should say which. No token, no address: the name
       * and the phase are the whole of the news.
       */
      for (const state of states) {
        const detail = state.phase === 'unreachable' || state.phase === 'refused'
          ? `: ${state.message}`
          : '';
        console.log(`[crucible] "${state.server}" at start-up: ${state.phase}${detail}`);
      }
    })
    .catch((err: unknown) => {
      console.error(
        '[crucible] the start-up coordination sweep did not finish: '
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    });

  // Same at startup: the facts are refreshed, and there is no longer a local
  // reader for a local engine to have superseded.
  void refreshCrucibleFacts()
    .then(() => {
      gatesChanged();
    })
    .catch((err: unknown) => {
      console.error(
        '[slots] the weights-ownership pass could not finish: '
        + `${err instanceof Error ? err.message : String(err)}. Nothing was removed.`,
      );
    });
}
