/**
 * WHICH MACHINES CAN SPEAK WHICH VOICE — asked of the machines, not of this disk.
 *
 * ── The defect this file is ────────────────────────────────────────────────
 *
 * `higgs-models.ts`'s `higgsVoiceUnavailableReason` is titled *"why this voice
 * cannot render on THIS MACHINE"*, and that was the right question exactly as
 * long as this machine was the one that rendered. It is not any more. A render
 * goes to a Crucible engine — the 3090 Ti inside WSL, the M1 Ultra across the
 * tailnet — and on Owen's PC the Windows process is an ORCHESTRATOR that speaks
 * no word of any book. So the picker was answering about a machine with no
 * stake in the answer, and it was wrong in BOTH directions:
 *
 *   - a voice staged on the engine but absent from this box's `userData` was
 *     greyed out as "not on this machine" though it would have rendered;
 *   - a voice on this box's disk that the engine lacks was offered, and refused
 *     mid-render — which is the "offered then refused" pair that function's own
 *     header says it exists to prevent.
 *
 * The zero-shot clones are where it bit hardest, because their reference clips
 * are the artifact being stat'd, but nothing about the defect is specific to
 * them.
 *
 * ── Why the server's answer is the only one worth having ───────────────────
 *
 * `GET /v1/voices` already carries `loadable` and, when it is false, `reason`
 * — the SDK's own contract is that *"a row that is not loadable and does not
 * say why is a protocol error, because the operator cannot tell whether to pull
 * weights, install an env, free the card, or go to the other host."* That is
 * strictly more than a local `stat` can know, it is in the words of the machine
 * that will refuse, and it is the same read `voice-band.ts` already makes for
 * chunk packing. One authority, asked once.
 *
 * ── The rule that makes an absent server safe ──────────────────────────────
 *
 * Owen's ruling, 2026-09-15: a voice only one server serves LOCKS the venue to
 * that server. That turns "did the Mac answer?" into a ROUTING decision, which
 * is why this module refuses to let silence look like an answer.
 *
 * A server that is asleep, unreachable or switched off contributes NO voices —
 * and if that counted as "it does not have this voice", a voice both machines
 * serve would present as 3090-only the moment the Mac slept, and the lock would
 * pin a book to the PC without anyone choosing that. So:
 *
 *   **Only servers that ANSWERED are in a voice's server set.** A server that
 *   did not answer is carried as its own state, named, and every consumer that
 *   derives a lock has to reckon with {@link VoiceInventory.complete} being
 *   false rather than reading a partial inventory as a whole one.
 *
 * A DISABLED server is not queried at all. The operator switched it off; a
 * network round trip to prove what they already said would be slower and no
 * more true. It is still REPORTED, because a machine the operator owns should
 * not vanish from the list they use to reason about their own hardware.
 */

import type { CrucibleClient, VoiceInfo } from '@crucible/client';
import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import { readRouting } from './routing';
import { CrucibleRenderRefused, describeCrucibleRefusal } from './render';

/** One voice as ONE server reports it. The server's words, not a translation. */
export interface InventoryVoice {
  readonly id: string;
  readonly display: string;
  /** Can this server render it right now, per the server. */
  readonly loadable: boolean;
  /** The server's own sentence when `loadable` is false; `null` when it is true. */
  readonly reason: string | null;
  /**
   * The server expects the JOB to carry the reference clip — Crucible's
   * `clips = "from-request"`. See {@link placeCarriedVoices}: this is the one
   * row for which the local disk is the right authority after all.
   */
  readonly needsReference: boolean;
}

/**
 * What one server contributed.
 *
 * Three states and not two, because "no voices" has three different causes and
 * collapsing them is how a sleeping Mac reroutes a book (see the header).
 */
export type ServerVoices =
  | { readonly server: string; readonly state: 'answered'; readonly voices: readonly InventoryVoice[] }
  | { readonly server: string; readonly state: 'unreachable'; readonly reason: string }
  | { readonly server: string; readonly state: 'disabled' };

/** Every registered server's answer, taken together. */
export interface VoiceInventory {
  readonly servers: readonly ServerVoices[];
  /**
   * TRUE ONLY WHEN EVERY REGISTERED SERVER ANSWERED.
   *
   * The flag a lock has to respect. False means some machine's voices are
   * unknown, so a voice that looks unique here may not be — and a UI that draws
   * a lock from an incomplete inventory must say so rather than presenting a
   * guess as a constraint.
   */
  readonly complete: boolean;
}

/**
 * Ask every registered server what it can speak.
 *
 * In parallel, because these are independent machines and asking them in turn
 * makes the picker as slow as the slowest one. One `GET /v1/voices` each — the
 * same call `voice-band.ts` makes per render — and no retries: a server that
 * did not answer this question is reported as not having answered it, which is
 * the fact the caller needs, rather than being asked again until it agrees.
 *
 * BOTH INPUTS ARE PARAMETERS WITH THE REAL DOORS AS THEIR DEFAULTS, which is
 * the discipline `Routing` already states about itself: *"This class never asks
 * the registry itself, so a keeper drives it with a scripted server set and the
 * module-level doors below bind it to the real one."* The rule this module
 * exists to hold — that silence from a server is never read as an answer —
 * cannot be tested at all if reaching it requires a real tailnet.
 */
export async function readVoiceInventory(
  ranked: readonly { readonly name: string; readonly enabled: boolean }[] = readRouting().ranked,
  clientFor: (server: string) => Pick<CrucibleClient, 'voices'> | Promise<Pick<CrucibleClient, 'voices'>> =
    (server) => crucibleClientFor(server, CRUCIBLE_CLIENT_NAME),
): Promise<VoiceInventory> {
  const servers = await Promise.all(ranked.map(async (row): Promise<ServerVoices> => {
    if (!row.enabled) return { server: row.name, state: 'disabled' };
    let rows: readonly VoiceInfo[];
    try {
      rows = await (await clientFor(row.name)).voices();
    } catch (err) {
      /*
       * A SERVER'S REFUSAL BECOMES A STATE; OUR OWN BUG DOES NOT.
       *
       * `describeCrucibleRefusal` turns each of the SDK's error types into a
       * sentence naming the server — the same sentence the render would have
       * given — and returns anything else UNCHANGED, on its own stated grounds:
       * *"an unexpected exception is not a refusal and dressing it as one loses
       * where it came from."*
       *
       * So the two are kept apart here. A `CrucibleRenderRefused` is a fact
       * about that machine and belongs in its row. Anything else is a defect in
       * this client, and recording it as "M1 Ultra — unreachable" would put our
       * bug in front of the operator wearing the Mac's name, which is the
       * name-the-wrong-cause shape this module exists to avoid. It is rethrown:
       * the picker fails loudly rather than quietly listing fewer machines.
       */
      const described = describeCrucibleRefusal(err, row.name);
      if (!(described instanceof CrucibleRenderRefused)) throw err;
      return { server: row.name, state: 'unreachable', reason: described.message };
    }
    return {
      server: row.name,
      state: 'answered',
      voices: rows.map((v) => ({
        id: v.id,
        display: v.display,
        loadable: v.loadable,
        reason: v.reason,
        needsReference: v.needsReference,
      })),
    };
  }));
  return { servers, complete: servers.every((s) => s.state === 'answered') };
}

/** One voice, and what every server that answered said about it. */
export interface VoicePlacement {
  readonly id: string;
  readonly display: string;
  /**
   * The servers that ANSWERED and can render it, sorted by the routing order.
   * This is the lock set: one entry means one machine, and Owen's rule pins the
   * venue to it.
   */
  readonly servedBy: readonly string[];
  /**
   * Servers that answered, KNOW this voice, and cannot render it yet — with the
   * server's own reason.
   *
   * Separate from `servedBy` because the two send a person to different places.
   * "The 3090 has never heard of this voice" is a catalog difference; "the 3090
   * has it but the weights are not pulled" is a download, and the operator can
   * fix the second in a minute. Collapsing them would name the wrong cause,
   * which is the failure shape that cost this project a day on 2026-09-15.
   */
  readonly blocked: readonly { readonly server: string; readonly reason: string }[];
}

/**
 * Every voice any answering server named, with its server set.
 *
 * Voices are keyed by `id` — Crucible's voice id is stable across backends, so
 * the same id on two servers IS the same voice, which is the premise Owen's
 * grouping rests on (*"the same by model name"*).
 *
 * A voice NO server named does not appear. That is the point: the list is what
 * the machines can speak, and a local catalog entry no engine has is not an
 * option, it is a staging job someone has not finished.
 */
export function placeVoices(inventory: VoiceInventory): VoicePlacement[] {
  const order = inventory.servers.map((s) => s.server);
  const byId = new Map<string, {
    display: string;
    servedBy: string[];
    blocked: { server: string; reason: string }[];
  }>();

  for (const entry of inventory.servers) {
    if (entry.state !== 'answered') continue;
    for (const voice of entry.voices) {
      let row = byId.get(voice.id);
      if (!row) {
        row = { display: voice.display, servedBy: [], blocked: [] };
        byId.set(voice.id, row);
      }
      if (voice.loadable) {
        row.servedBy.push(entry.server);
        continue;
      }
      /*
       * NOT LOADABLE AND NO REASON IS A PROTOCOL ERROR, and it is refused here
       * rather than shown as an empty tooltip. The SDK states the contract
       * ("a row that is not loadable and does not say why...") and this is the
       * one place that reads the pair, so it is the place to hold the server to
       * it — a silent blocked voice is a person told "no" with no next step.
       */
      if (voice.reason === null) {
        throw new Error(
          `crucible "${entry.server}" says voice "${voice.id}" is not loadable and gives no reason. `
          + 'API v1 requires the reason on every unloadable row, because without it the operator '
          + 'cannot tell whether to pull weights, install an env, free the card, or use the other host.',
        );
      }
      row.blocked.push({ server: entry.server, reason: voice.reason });
    }
  }

  const rank = (name: string): number => order.indexOf(name);
  return [...byId.entries()]
    .map(([id, row]) => ({
      id,
      display: row.display,
      servedBy: [...row.servedBy].sort((a, b) => rank(a) - rank(b)),
      blocked: [...row.blocked].sort((a, b) => rank(a.server) - rank(b.server)),
    }))
    .sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * THE ONE CASE WHERE THIS MACHINE'S DISK REALLY IS THE AUTHORITY.
 *
 * Owen, 2026-09-15: *"zero shot works effectively identically to fine tuned
 * models. it sends it through the base and appends the reference clip that's
 * already present on the crucible server."* The first half is exactly right and
 * the second half is the design Crucible is BUILT for but which nobody has
 * finished — and the gap is the whole of why these four are special.
 *
 * Crucible's zeroshot manifests take `clips` either as a published list of
 * `{file, transcript, seconds}` — the server holds the bytes, which is Owen's
 * description — or as the literal `"from-request"`, meaning the JOB carries
 * them. `crucible/voices/zeroshot.toml` is `"from-request"`, and says why in as
 * many words: BookForge's four wavs *"are not published anywhere: they live in
 * `<userData>/runtime/higgs-models/refs/`"*, and Crucible *"pulls a published
 * artifact at a pinned revision and has no other way to get bytes onto a
 * server"*. So there is ONE server-side voice id, `zeroshot`, standing in for
 * all four, and `crucibleVoiceLoadFor` does `fs.readFileSync` on this box's disk
 * and uploads the bytes base64.
 *
 * Which means the local clip check that looks like the rest of the defect this
 * module fixes is NOT part of it. For a checkpoint voice the weights are on the
 * server and asking this disk is meaningless. For these four, this app is the
 * only thing that has the bytes, so "is the clip on this machine" is precisely
 * the right question and the only one that can be asked.
 *
 * The two answers are therefore composed rather than merged: the servers say
 * which of them will accept a carried clip, this machine says whether it has
 * one, and a voice needs both. If Owen ever publishes the reference set (the
 * manifest gives the recipe — join the clips with 0.35 s of silence, join the
 * transcripts in the same order, declare one measured `seconds`), each becomes a
 * real server-side voice, `placeVoices` picks it up with no change, and this
 * function stops having anything to place.
 */
export interface CarriedVoice {
  readonly id: string;
  readonly display: string;
  /** Is the clip on THIS machine's disk — the one fact no server can answer. */
  readonly clipPresent: boolean;
  /** Why it is not, when it is absent. Required then, for the same reason the server's is. */
  readonly reason: string | null;
}

/** Crucible's single server-side id that carries all four (`voice-load.ts`). */
export const CARRIED_CLIP_VOICE_ID = 'zeroshot';

export function placeCarriedVoices(
  inventory: VoiceInventory,
  carried: readonly CarriedVoice[],
): VoicePlacement[] {
  /*
   * A server can take a carried clip when it serves the stand-in id AND says it
   * wants the reference. `needsReference` false on that row would mean the
   * server holds its own clips — Owen's design, arrived — and then these four
   * are no longer carried voices at all; placing them here anyway would upload
   * bytes the server would refuse as `reference_not_allowed`.
   */
  const takers = inventory.servers.flatMap((entry) => {
    if (entry.state !== 'answered') return [];
    const row = entry.voices.find((v) => v.id === CARRIED_CLIP_VOICE_ID);
    return row !== undefined && row.loadable && row.needsReference ? [entry.server] : [];
  });

  return carried.map((voice) => {
    if (voice.clipPresent) {
      return { id: voice.id, display: voice.display, servedBy: takers, blocked: [] };
    }
    if (voice.reason === null) {
      throw new Error(
        `Higgs voice "${voice.id}" has no reference clip on this machine and no reason was given. `
        + 'The clip is what this app contributes to a zero-shot render, so its absence is the '
        + 'whole refusal and the operator is owed the path that was looked for.',
      );
    }
    /*
     * Blocked EVERYWHERE, and named against every server that would otherwise
     * have taken it — because the missing thing is not any server's fault and a
     * row blaming one machine would send the operator to the wrong place. With
     * no clip there is no set, so it can never read as a lock.
     */
    return {
      id: voice.id,
      display: voice.display,
      servedBy: [],
      blocked: takers.map((server) => ({ server, reason: voice.reason as string })),
    };
  });
}

/**
 * The picker's sections: one per distinct SET of servers, Owen's rule exactly.
 *
 * *"for servers that have the same registered voices, the same by model name, it
 * lists it in a section that includes shared voices ... the section is the set
 * of machines that can render it."*
 *
 * Sections are ordered widest-first — the voices every machine has, then
 * narrower sets, then single machines — so the options that cost the operator
 * no routing freedom come first and the ones that pin a venue come last, where
 * the label warns them.
 */
export interface VoiceSection {
  /** The set of servers, in routing order. Empty = served by nothing that answered. */
  readonly servers: readonly string[];
  /** What to call it: "Every server", "3090 Ti", "3090 Ti + M1 Ultra". */
  readonly label: string;
  /** True when choosing any voice here pins the venue (Owen's lock). */
  readonly locks: boolean;
  readonly voices: readonly VoicePlacement[];
}

export function sectionVoices(
  inventory: VoiceInventory,
  placements: readonly VoicePlacement[],
): VoiceSection[] {
  const answering = inventory.servers.filter((s) => s.state === 'answered').map((s) => s.server);
  const order = inventory.servers.map((s) => s.server);
  const sections = new Map<string, { servers: string[]; voices: VoicePlacement[] }>();

  for (const placement of placements) {
    /*
     * JSON AND NOT A JOIN CHARACTER, because server names contain spaces.
     * Owen names them after their GPU — "3090 Ti", "M1 Ultra" — so any
     * separator a name may also contain collides two different sets into one
     * section: ['3090', 'Ti'] and ['3090 Ti'] join to the same string. The
     * array is already in routing order, so its encoding is canonical.
     */
    const key = JSON.stringify(placement.servedBy);
    let section = sections.get(key);
    if (!section) {
      section = { servers: [...placement.servedBy], voices: [] };
      sections.set(key, section);
    }
    section.voices.push(placement);
  }

  return [...sections.values()]
    .map((section) => ({
      servers: section.servers,
      label: sectionLabel(section.servers, answering),
      /*
       * THE LOCK IS ABOUT CHOICE, NOT ABOUT COUNT. One server in the set pins
       * the venue — but only when there is another server it could otherwise
       * have gone to. On a one-server setup every voice is "served by one
       * machine" and nothing is being constrained, so calling that a lock would
       * put a warning on a system that has no alternative to warn about.
       */
      locks: section.servers.length === 1 && answering.length > 1,
      voices: section.voices,
    }))
    .sort((a, b) => {
      if (a.servers.length !== b.servers.length) return b.servers.length - a.servers.length;
      return order.indexOf(a.servers[0] ?? '') - order.indexOf(b.servers[0] ?? '');
    });
}

/**
 * What a section is called.
 *
 * "Every server" only when the set really is every server that ANSWERED, and
 * the caller is expected to have said elsewhere that not everyone did — see
 * {@link VoiceInventory.complete}. Naming a partial inventory "every server"
 * would be this module's own failure mode, so it is spelled out here: the
 * comparison is against the answering set, never against the registered one.
 */
function sectionLabel(servers: readonly string[], answering: readonly string[]): string {
  if (servers.length === 0) return 'No server can render these';
  if (servers.length === answering.length && answering.length > 1) return 'Every server';
  return servers.join(' + ');
}
