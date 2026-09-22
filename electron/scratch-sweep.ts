/**
 * WHAT MAY BE DELETED OUT OF THE SCRATCH ROOT, AND WHAT MAY NOT.
 *
 * ── Why this is its own module ──────────────────────────────────────────────
 *
 * The rule lived inline in `main.ts`'s `sweepDirContents` and was correct; what
 * it could not be was DRIVEN. Every one of the three facts it balances was
 * learned by losing something —
 *
 *   • a gap-normalised sentence set swept out from under a running assembly
 *     (2026-08-19: e2a answered "Sentences directory not found" for a path we
 *     had written 90 seconds earlier);
 *   • `<library>/tmp/ebook-83fa…` deleted while the OTHER machine was rendering
 *     into it (2026-09-05, back when the scratch root was inside the shared
 *     library: the session sidecar and `session-state.json` died,
 *     the FLACs did not, and the render published audio with no text over a
 *     complete cache);
 *   • the unconditional wipe that destroyed a resume checkpoint, so "resume"
 *     restarted the book at sentence 0.
 *
 * — and a rule with that history is one a keeper should be able to state back.
 * So the DECISION is a pure function here (`planScratchSweep`) and the doing is
 * beside it; `main.ts` keeps only the part that knows what the queue wants.
 *
 * ── The scratch root ────────────────────────────────────────────────────────
 *
 * `~/Documents/BookForge/scratch` (`narrator-paths.ts`
 * `defaultNarratorScratchRoot`), or whatever "Narrator scratch folder" names.
 * It was `<library>/tmp` until 2026-09-21 — INSIDE the shared NAS library, which
 * is what the 2026-09-05 incident above is made of — and is MACHINE-LOCAL now.
 *
 * THE FOREIGN-OWNER ARM STAYS, and deliberately. With the default root no other
 * machine can reach this directory at all, so `keptForeign` is unreachable on an
 * ordinary install; the Settings override can still put the scratch on a shared
 * volume, and that is the configuration the arm was written for. A rule that
 * only holds for the default is a rule that breaks the first time somebody
 * changes the default, so the ownership probe and the sidecar it reads are
 * untouched — and the sidecar is load-bearing for THIS machine anyway: it is the
 * only thing that says which project an orphaned session belongs to, which is
 * what the rescue reads.
 *
 * Two kinds of thing live at its top level and both are named for what they are:
 *
 *   `ebook-<uuid>/`   a render session — narrator's own scratch, and after an
 *                     interrupted run the ONLY copy of the sentences rendered
 *                     so far. Rescued into the project's durable TTS cache
 *                     before it is removed, never removed instead.
 *   `implied-<uuid>/` the EPUB a narration was made from when nobody asked for
 *                     an export (`narrator-paths.ts` IMPLIED_EXPORT_PREFIX).
 *                     Nothing reads it after prep copies the book into the
 *                     session, so it goes as soon as no step names it.
 *
 * Anything else at that top level is swept too. That is deliberate and it is
 * how the root stays empty: a new scratch kind that must SURVIVE has to say so
 * by being named in a live step, exactly as these two do — or, for a kind no
 * step can ever name, by being listed in {@link SCRATCH_SURVIVORS}.
 *
 * ── Nothing here touches the library proper ─────────────────────────────────
 *
 * Every path this module removes is a direct child of the scratch root it was
 * given. The only thing it writes outside that root is the rescue's promotion
 * into `{library}/projects/<slug>/stages/03-tts/sessions/…`, which is a copy in.
 */
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  IMPLIED_EXPORT_PREFIX, RENDER_SESSION_PREFIX, impliedExportDirOf, renderSessionDirOf,
} from './narrator-paths';
import { TERMINAL_STEP_STATUSES } from '../shared/queue/engine-types';

/**
 * SCRATCH KINDS NO STEP CAN EVER NAME.
 *
 * The rule above — "a kind that must survive says so by being named in a live
 * step" — assumes every scratch kind belongs to ONE run. `narration-cuts` does
 * not: it is a content-addressed cache shared by every narration and every
 * narration text pass (`narrationCutsDir`, parallel-tts-bridge.ts), so there is
 * no step whose config or output points at the DIRECTORY, only at files inside
 * it. Under the "anything else goes" rule it was therefore `rm -rf`'d at every
 * start, silently re-buying the model calls it exists to have already paid for
 * — and `prepared.epubPath` points into it, so a restart between prep and
 * render lost the prepared book too (bug hunt 2026-09-20, Q5).
 *
 * Owen's ruling 5 (2026-09-20): it stays under the scratch root and is named
 * here. A list, not a prefix test, because "survives every sweep for ever" is a
 * privilege that should have to be typed out one name at a time.
 */
export const SCRATCH_SURVIVORS: readonly string[] = ['narration-cuts'];

/**
 * The list of names {@link runScratchSweep} is ABOUT to delete, written at the
 * TOP of the scratch root before a single `rm` starts, so a delete that only
 * half-finishes is still legible on the next launch.
 *
 * MEASURED 2026-09-20 (P2): an `fs.rm` over SMB got as far as removing
 * `bookforge-session.json` and stopped with 507 FLACs still on disk. The
 * ownership sidecar is the ONLY thing that says which project a session
 * belongs to, so the tree became an anonymous pile of audio: every launch
 * afterwards found it, could not rescue it, and warned *"has rendered
 * sentences but no owning project"* — which reads exactly like a lost
 * checkpoint, from a sweep that had reported the whole list Cleaned.
 *
 * OUTSIDE THE TREES IT NAMES, and that is the point: a marker written INSIDE a
 * session is just another file the recursive `rm` may take first, so it can go
 * missing in exactly the case it exists for. One file at the root, holding the
 * names, survives any tearing below it. It is never a sweepable name itself —
 * {@link planScratchSweepOf} filters it out — and it is rewritten (or removed)
 * at the end of every sweep, so it only ever describes deletes that did not
 * finish.
 */
export const DELETING_LEDGER = '.bookforge-deleting.json';

/** What a sweep decided about one top-level scratch item. */
export interface ScratchSweepPlan {
  /**
   * `ebook-*` sessions to hand the rescue before removing them. A subset of
   * {@link remove}: everything here is also removed, after the rescue has had
   * its chance at it.
   */
  readonly rescue: readonly string[];
  /** Top-level names to delete, rescue-first ones included. */
  readonly remove: readonly string[];
  /**
   * Names a previous sweep had already condemned ({@link DELETING_LEDGER}
   * still lists them) and whose delete did not finish. A subset of {@link remove} and
   * never of {@link rescue}: the decision was taken last time, and handing a
   * half-deleted tree back to the rescue is how a torn session gets mistaken
   * for a checkpoint.
   */
  readonly halfDeleted: readonly string[];
  /** Kept because a live queue step names it, with the name that matched. */
  readonly keptForQueue: readonly { readonly name: string; readonly wanted: string }[];
  /** Kept because another machine owns the session. */
  readonly keptForeign: readonly { readonly name: string; readonly host: string }[];
  /** Kept because it is in {@link SCRATCH_SURVIVORS} — a cache, not a run's scratch. */
  readonly keptSurvivors: readonly string[];
}

export interface ScratchSweepInput {
  /** Top-level names in the scratch root, as read at the start of the sweep. */
  readonly names: readonly string[];
  /**
   * What the queue still wants, as NAMES: every non-terminal step's id, plus
   * the basename of every implied-export folder a live step's config points at.
   * `main.ts` composes it (`liveStepIds`) because only it can ask the engine.
   *
   * Asked of the queue rather than inferred from mtimes, because "recent" is
   * not the same fact as "wanted".
   */
  readonly wantedByQueue: ReadonlySet<string>;
  /** `ebook-*` name → the hostname that owns it, for sessions this machine did not start. */
  readonly foreignHosts: ReadonlyMap<string, string>;
  /**
   * Names listed in {@link DELETING_LEDGER} — condemned by an earlier sweep
   * whose `rm` did not finish. Empty when the caller did not look.
   */
  readonly halfDeleted?: ReadonlySet<string>;
}

/**
 * THE RULE, as one pure function.
 *
 * Order matters and it is this: another machine's session is untouchable first
 * (deleting it breaks a render happening right now), then what the queue still
 * names is kept (deleting it breaks a resume about to happen), and everything
 * left is a leftover — rescued if it is a session, removed either way.
 */
export function planScratchSweep(input: ScratchSweepInput): ScratchSweepPlan {
  const keptForeign: { name: string; host: string }[] = [];
  const keptForQueue: { name: string; wanted: string }[] = [];
  const keptSurvivors: string[] = [];
  const rescue: string[] = [];
  const halfDeleted: string[] = [];
  const remove: string[] = [];
  const condemned = input.halfDeleted ?? new Set<string>();

  for (const name of input.names) {
    const host = input.foreignHosts.get(name);
    if (host !== undefined) {
      keptForeign.push({ name, host });
      continue;
    }
    // `includes`, not equality: a scratch item is named FOR a step
    // (`gap-<stepId>`) as often as it is named after one, and an implied-export
    // folder arrives here as its own basename.
    const wanted = [...input.wantedByQueue].find((id) => name.includes(id));
    if (wanted !== undefined) {
      keptForQueue.push({ name, wanted });
      continue;
    }
    if (SCRATCH_SURVIVORS.includes(name)) {
      keptSurvivors.push(name);
      continue;
    }
    if (condemned.has(name)) {
      // Already decided, and decided against handing it to the rescue: see
      // DELETING_LEDGER. Finish the delete, say nothing about a checkpoint.
      halfDeleted.push(name);
      remove.push(name);
      continue;
    }
    if (name.startsWith(RENDER_SESSION_PREFIX)) rescue.push(name);
    remove.push(name);
  }

  return { rescue, remove, halfDeleted, keptForQueue, keptForeign, keptSurvivors };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the queue still wants, read off the steps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The parts of a `QueueStep` this rule reads. Structural rather than the
 * engine's own type, so a keeper can state a job in five lines and so this
 * module keeps no import of the engine itself — `main.ts` still owns the ASKING
 * (only it can reach `snapshot()`); what moved here is the RULE, because a rule
 * nobody can drive is a rule that goes wrong quietly (this one did — Q5).
 */
export interface ScratchNamingStep {
  readonly id: string;
  readonly status: string;
  /** Another step's id, or `'source'`. */
  readonly parentStepId?: string;
  readonly config?: Record<string, unknown>;
  readonly sourceRef?: { readonly path?: string } | null;
  readonly output?: {
    readonly path?: string;
    readonly sessionDir?: string;
    readonly processDir?: string;
    readonly outputPath?: string;
  } | null;
}

/** Every path an output ref can point at. Read in one place so none is forgotten. */
function outputPathsOf(step: ScratchNamingStep): string[] {
  const out = step.output;
  if (out === null || out === undefined) return [];
  return [out.path, out.sessionDir, out.processDir, out.outputPath]
    .filter((p): p is string => typeof p === 'string' && p !== '');
}

/** The top-level scratch folder NAME a path lies in — session or implied export. */
function scratchNameOf(p: string): string | null {
  const dir = renderSessionDirOf(p) ?? impliedExportDirOf(p);
  return dir === null ? null : path.basename(dir);
}

/**
 * WHAT THE QUEUE STILL WANTS OUT OF THE SCRATCH ROOT, as top-level names.
 *
 * Every non-terminal step's id, plus every scratch folder a live step names —
 * and that last word is the whole finding. Until 2026-09-20 this read a step's
 * CONFIG only, which models "what a step was asked to use". The prepare→render
 * seam moved the fact into an OUTPUT: `prepare` mints
 * `<scratch>/ebook-<uuid>/` with `crypto.randomUUID()` and the only record of
 * where it went is `prepare.output.sessionDir`. So after a restart with
 * `prepare` DONE and `tts-conversion` HELD — the state two books were actually
 * in — the sweep saw an unclaimed session, rescued it (no audio yet), removed
 * it, and Start then refused by name with nothing able to re-run the finished
 * prepare. Only Remove + re-queue recovered it.
 *
 * Hence the two passes below: a non-terminal step's own output, and the output
 * of the DONE PARENT of a non-terminal step. A done parent is not itself
 * "live", but its output is the live child's input, and deleting your input is
 * the same loss whichever row is holding it.
 */
export function scratchNamesWantedBy(steps: readonly ScratchNamingStep[]): Set<string> {
  const ids = new Set<string>();
  const byId = new Map<string, ScratchNamingStep>();
  for (const step of steps) byId.set(step.id, step);

  const addName = (p: unknown): void => {
    if (typeof p !== 'string') return;
    const name = scratchNameOf(p);
    if (name !== null) ids.add(name);
  };

  for (const step of steps) {
    // The shared set, not a copy of its members: it exists "for a membership
    // test that cannot go stale", and an inline list here is the one site that
    // would not follow a fourth terminal status.
    if (TERMINAL_STEP_STATUSES.has(step.status as never)) continue;
    ids.add(step.id);
    const cfg = (step.config ?? {}) as { epubPath?: unknown; unfiledPath?: unknown };
    for (const p of [cfg.epubPath, cfg.unfiledPath, step.sourceRef?.path]) addName(p);
    for (const p of outputPathsOf(step)) addName(p);

    const parent = step.parentStepId === undefined ? undefined : byId.get(step.parentStepId);
    if (parent !== undefined) for (const p of outputPathsOf(parent)) addName(p);
  }
  return ids;
}

/** Is this top-level scratch name a landing folder for an implied export? */
export function isImpliedExportName(name: string): boolean {
  return name.startsWith(IMPLIED_EXPORT_PREFIX);
}

/**
 * Read the scratch root, ask who owns each session, and plan the sweep.
 *
 * Split from {@link runScratchSweep} so a caller can log the plan, and so the
 * ownership probe — the one part that touches another machine's files — is not
 * buried inside a delete.
 */
export async function planScratchSweepOf(
  dir: string,
  wantedByQueue: ReadonlySet<string>,
  foreignHostOf: (sessionDir: string) => Promise<string | null>,
): Promise<ScratchSweepPlan | null> {
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .map((entry) => entry.name)
      // Our own bookkeeping, never a scratch item — see DELETING_LEDGER.
      .filter((name) => name !== DELETING_LEDGER);
  } catch {
    return null; // The dir does not exist yet, or the volume is offline.
  }

  const halfDeleted = await readDeletingLedger(dir);

  /*
   * A RENDER ON THE OTHER MACHINE IS NOT A LEFTOVER.
   *
   * Not wrapped in a try, and that is the point: if ownership cannot be
   * established at all, the sweep must not run. Deleting everything because we
   * could not tell whose it was is the failure this probe exists to prevent.
   */
  const foreignHosts = new Map<string, string>();
  for (const name of names) {
    if (!name.startsWith(RENDER_SESSION_PREFIX)) continue;
    // A tree THIS machine already condemned is not asked about: the sidecar
    // that would answer may be exactly what the torn `rm` took, and an
    // unreadable sidecar must never be read as somebody else's.
    if (halfDeleted.has(name)) continue;
    const host = await foreignHostOf(path.join(dir, name));
    if (host !== null) foreignHosts.set(name, host);
  }

  return planScratchSweep({ names, wantedByQueue, foreignHosts, halfDeleted });
}

/**
 * The names a previous sweep condemned and did not finish removing.
 *
 * An unreadable or malformed ledger answers EMPTY, and that is the safe
 * direction: it only costs a condemned tree one more pass through the ordinary
 * rescue-then-delete path. Reading it wrongly in the other direction would skip
 * the rescue on a session nobody had condemned.
 */
async function readDeletingLedger(dir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, DELETING_LEDGER), 'utf-8')) as unknown;
    const names = (raw as { deleting?: unknown })?.deleting;
    if (!Array.isArray(names)) return new Set();
    return new Set(names.filter((n): n is string => typeof n === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Say what is about to go, before it goes — or, at the end, what would not go.
 * An empty list removes the file, so the ledger's mere existence means an
 * unfinished delete.
 */
async function writeDeletingLedger(dir: string, deleting: readonly string[]): Promise<void> {
  const file = path.join(dir, DELETING_LEDGER);
  try {
    if (deleting.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.writeFile(file, JSON.stringify({ deleting, at: new Date().toISOString() }), 'utf-8');
  } catch (err) {
    // Best effort by design: a root we cannot write to is a root we are about
    // to fail to delete out of anyway, and the failures are logged by name.
    console.warn(`[MAIN] Could not update ${DELETING_LEDGER} in ${dir}:`, (err as Error).message);
  }
}

/**
 * Carry out a plan: rescue first, delete second.
 *
 * `rescueAll` is handed the whole directory rather than one session at a time
 * because that is the shape `rescueOrphanedScratchSessions` has — it walks the
 * root itself, skips foreign sessions with the same probe used above, and
 * refuses to promote anything less complete than what the project already has.
 * A rescue that throws does not stop the sweep: the names were snapshotted
 * before it ran, and a leftover kept forever because a promotion failed is the
 * tmp dir growing without bound.
 *
 * ── A DELETE THAT FAILED IS NOT A DELETE THAT HAPPENED ──────────────────────
 *
 * Every `rm` is SETTLED and counted on its own. The old code swallowed each
 * one (`.catch(() => undefined)`) and then logged *"Cleaned N item(s)"* over
 * the whole list, so a sweep that removed nothing said it had removed
 * everything — and over SMB, where a partial `rm` is a real outcome, the log
 * was the only witness and it was lying (P2, 2026-09-20). Failures are now
 * named, separately from the successes, and never counted as cleaned.
 *
 * ── AND THE CONDEMNED LIST IS WRITTEN FIRST ─────────────────────────────────
 *
 * {@link DELETING_LEDGER} names every item about to be removed BEFORE the
 * first `rm` starts, and is rewritten at the end with only the ones that did
 * not go. So a delete that tears halfway through leaves a root that still SAYS
 * what was happening to it. Without it the ownership sidecar is just another
 * file the recursive `rm` may take first, and the next launch finds rendered
 * audio with no owner — indistinguishable from a rescue-worthy checkpoint, and
 * warned about as one on every start for ever.
 */
export async function runScratchSweep(
  dir: string,
  plan: ScratchSweepPlan,
  rescueAll: (scratchDir: string) => Promise<unknown>,
  log: (line: string) => void = (line) => console.log(`[MAIN] ${line}`),
): Promise<void> {
  for (const kept of plan.keptForeign) {
    log(`Scratch session ${kept.name} is owned by ${kept.host} — not sweeping it.`);
  }
  if (plan.keptForQueue.length > 0) {
    log(`Keeping ${plan.keptForQueue.length} scratch item(s) belonging to unfinished queue steps: `
      + plan.keptForQueue.map((kept) => `${kept.name} (for ${kept.wanted})`).join(', '));
  }
  if (plan.keptSurvivors.length > 0) {
    log(`Keeping the shared scratch cache(s) no step names: ${plan.keptSurvivors.join(', ')}`);
  }

  const removed: string[] = [];
  const failed: { name: string; why: string }[] = [];
  const remove = async (name: string): Promise<void> => {
    try {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      failed.push({ name, why: (err as Error).message });
    }
  };

  /*
   * THE HALF-DELETED GO BEFORE THE RESCUE RUNS, not with the rest.
   *
   * `rescueAll` walks the whole root itself, so a tree condemned last time
   * would otherwise be offered to the rescue again — and its sidecar may be
   * what the torn `rm` took, which is precisely the "rendered sentences but no
   * owning project" warning this finding is made of. Finishing the delete
   * first removes it from the rescue's view entirely.
   */
  await Promise.allSettled(plan.halfDeleted.map(remove));

  if (plan.rescue.length > 0) {
    try {
      await rescueAll(dir);
    } catch (err) {
      console.error('[MAIN] Scratch rescue failed before sweep (continuing):', err);
    }
  }

  const rest = plan.remove.filter((name) => !plan.halfDeleted.includes(name));
  await writeDeletingLedger(dir, rest);
  await Promise.allSettled(rest.map(remove));
  // What is left of the condemned list is exactly what is still on disk. An
  // empty list removes the file, so the ledger existing at the next start
  // means, and only means, a delete that did not finish.
  await writeDeletingLedger(dir, failed.map((f) => f.name));

  if (removed.length > 0) {
    // BY NAME, because "cleaned 9 items" is not something anybody can check
    // against a book that came back short.
    log(`Cleaned ${removed.length} item(s) from the scratch root ${dir}: ${removed.join(', ')}`);
  }
  if (failed.length > 0) {
    // NOT counted above, and loud: this is the line that would have said what
    // happened to ebook-8e3344a0 on 2026-09-20 instead of claiming success.
    console.error(`[MAIN] ${failed.length} scratch item(s) could NOT be removed from ${dir} and `
      + 'are still there — a partial delete leaves a torn tree, and '
      + `${DELETING_LEDGER} is what still names it: `
      + failed.map((f) => `${f.name} (${f.why})`).join(', '));
  }
}
