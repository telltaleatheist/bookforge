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
 *     into it (2026-09-05: the session sidecar and `session-state.json` died,
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
 * `<library>/tmp` (`narrator-paths.ts`). Two kinds of thing live at its top
 * level and both are named for what they are:
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
 * by being named in a live step, exactly as these two do.
 *
 * ── Nothing here touches the library proper ─────────────────────────────────
 *
 * Every path this module removes is a direct child of the scratch root it was
 * given. The only thing it writes outside that root is the rescue's promotion
 * into `{library}/projects/<slug>/stages/03-tts/sessions/…`, which is a copy in.
 */
import * as path from 'path';
import { promises as fs } from 'fs';
import { IMPLIED_EXPORT_PREFIX, RENDER_SESSION_PREFIX } from './narrator-paths';

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
  /** Kept because a live queue step names it, with the name that matched. */
  readonly keptForQueue: readonly { readonly name: string; readonly wanted: string }[];
  /** Kept because another machine owns the session. */
  readonly keptForeign: readonly { readonly name: string; readonly host: string }[];
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
  const rescue: string[] = [];
  const remove: string[] = [];

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
    if (name.startsWith(RENDER_SESSION_PREFIX)) rescue.push(name);
    remove.push(name);
  }

  return { rescue, remove, keptForQueue, keptForeign };
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
    names = (await fs.readdir(dir, { withFileTypes: true })).map((entry) => entry.name);
  } catch {
    return null; // The dir does not exist yet, or the volume is offline.
  }

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
    const host = await foreignHostOf(path.join(dir, name));
    if (host !== null) foreignHosts.set(name, host);
  }

  return planScratchSweep({ names, wantedByQueue, foreignHosts });
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

  if (plan.rescue.length > 0) {
    try {
      await rescueAll(dir);
    } catch (err) {
      console.error('[MAIN] Scratch rescue failed before sweep (continuing):', err);
    }
  }

  await Promise.all(plan.remove.map((name) =>
    fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined)));

  if (plan.remove.length > 0) {
    // BY NAME, because "cleaned 9 items" is not something anybody can check
    // against a book that came back short.
    log(`Cleaned ${plan.remove.length} item(s) from the scratch root ${dir}: `
      + plan.remove.join(', '));
  }
}
