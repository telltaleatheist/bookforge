/**
 * act-gates — may this act run ON THIS MACHINE, and the sentence either way.
 *
 * ── OWEN'S RULE, WHICH IS TWO RULES ─────────────────────────────────────────
 *
 * *"if their system just isnt powerful enough for translation (smaller than 9b)
 * then translation and simplify is disabled. the tiles arent lit up until the
 * models are present."* And: *"if a job is going to take an obscenely long time,
 * like translation on cpu, it should just be disabled."* (docs/SLOTS.md §1.)
 *
 * The first is about the CATALOG — a class has a floor, and a machine that
 * cannot hold anything at or above it is not offered the act. The second is
 * about the MACHINE — a processor-only box can hold a 9B in system RAM and will
 * then generate at a word or two a second, which for a three-hundred-page
 * translation is not slow, it is not going to finish. Memory says yes and the
 * clock says no, so the clock gets its own branch.
 *
 * ── THIS GATE IS ABOUT THE MACHINE. THE OTHER ONE IS ABOUT THE BOOK ─────────
 *
 * `shared/stages.ts` already answers "can this act be aimed at where I am
 * standing" — is there a book at this position, is this the import row. That
 * question is unchanged and still asked in the renderer, where the standing
 * position lives. This file answers a question the renderer cannot: what is
 * installed, what fits, what is serving. Both have to say yes, and they say
 * DIFFERENT things when they say no, which is exactly why they are two gates and
 * not one — a tooltip reading "there is no book here" on a machine with no model
 * would send somebody to open a book that will not help them.
 *
 * ── WHY IT IS MAIN'S, AND WHY IT IS ONE FUNCTION ────────────────────────────
 *
 * Every fact in it lives in main: the hardware probe, ollama's `/api/tags`, the
 * settings file, the page reader's directory, and the server registry's
 * capability reads. A renderer assembling the answer would be five IPC calls and a join
 * written once per surface, and the two surfaces would drift the first time one
 * of them forgot a clause. So `actGates()` is the whole answer, every act at
 * once, and the tiles read it.
 *
 * ── FIVE PLACES IT DELIBERATELY DOES NOT REFUSE ─────────────────────────────
 *
 * 1. **A HOSTED WINDOW.** The work goes to the HOST's queue and runs on the
 *    host's compute — BookForge requires Crucible and has no ollama fallback at
 *    all (Owen, docs/SLOTS.md §1). Gating BookForge's tiles on whether THIS
 *    machine has pulled an ollama tag would dark a rail whose jobs never touch
 *    this machine's models. So hosted is lit, and the sentence says whose
 *    compute it is.
 * 2. **A CRUCIBLE ON THIS MACHINE THAT SERVES THE CLASS.** The weights are on
 *    that server, so this machine's own memory is not what binds and neither
 *    the floor nor the CPU rule applies (`localCrucibleServes`). A REMOTE
 *    Crucible is not consulted here at all: a reachability check on every gate
 *    read would put a network timeout behind a tooltip, and an unreachable
 *    server already refuses by name at the seam that sends the request. The
 *    machine-wide `llmServer: 'vllm'` setting that used to be this clause was
 *    retired with the registry (docs/SLOTS.md §7, package C) — an
 *    OpenAI-compatible server is a SLOT now, not a setting.
 * 3. **CLEAN TEXT ON A PROCESSOR.** The CPU rule covers translate, simplify and
 *    analysis, and stops there. A cleanup is only ever offered in a hosted
 *    window (Owen, 2026-09-05), where clause 1 has already lit it; applying the
 *    CPU rule anyway would dark the one act whose compute is certainly somebody
 *    else's. And Owen named translation — a book-length run that has to finish —
 *    not a punctuation pass over blocks that is resumable per block.
 * 4. **READING THROUGH A REMOTE ENDPOINT.** See `readGate`.
 * 5. **A MACHINE WITH A CLOUD PROVIDER CONNECTED.** Owen's weaker-system case
 *    (docs/SLOTS.md §1): *"give them the option of connecting an api key for
 *    openai or claude instead of using the 27b or the 9b… for weaker systems."*
 *    An enabled provider lights translate, simplify, analysis and clean AFTER
 *    the machine has said no, keeping the machine's own sentence and adding the
 *    provider's — see `textGate`, which argues why it is last and not first. It
 *    lights READING for nobody: page reading is a VLM pass and stays local or on
 *    a Crucible.
 */
import { readAppSettings } from './app-settings';
import { enabledCloudProviders } from './cloud-providers';
import {
  localCrucibleServes,
  localCrucibleTakeover,
  refreshCrucibleFacts,
} from './crucible-provider';
import { hosted } from './host';
import { eligibleFor, fitsOn, heldBy, heldSet, type LineupRow } from './llm-catalog';
import { probeOllama } from './ollama';
import {
  isLocalPageReader,
  PAGE_READER_MODEL,
  pageReaderInstalled,
  pageReaderSuperseded,
} from './page-reader';
import { readSettings } from './settings';
import { probeSystem } from './system-probe';
import type { ActGate, ActGates, ModelClass, OllamaFacts, SystemProfile } from '../shared/types';

/** Where somebody goes to fix it. Spelled once so all five sentences agree. */
const SETTINGS_PATH = 'Settings › Language model';

/** Everything the five gates read, measured once per answer rather than per act. */
interface Machine {
  profile: SystemProfile;
  ollama: OllamaFacts;
  held: Set<string>;
  /**
   * THE FIRST ENABLED CLOUD PROVIDER'S NAME, or null when none is connected.
   *
   * The NAME and not the entry, because that is all four gates want and because
   * an entry carries an API key: a shape holding a credential passed into five
   * sentence-composing functions is a credential one `${}` away from a tooltip.
   *
   * THE FIRST AND NOT A CHOICE. This lights a tile; it does not place a job. Two
   * providers connected means the tile is lit either way and the PICKER on the
   * row is where the one that runs is chosen, so naming the first is a sentence
   * that is true rather than a decision made in the wrong place.
   */
  cloud: string | null;
}

/** One gigabyte figure, said the way the rest of the app says it. */
function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** What this machine's memory is CALLED, so the refusal names the right pool. */
function pool(profile: SystemProfile): string {
  switch (profile.memoryBasis) {
    case 'vram': return 'video memory';
    case 'unified': return 'unified memory a model can reach';
    default: return 'system RAM';
  }
}

/**
 * A text act's gate — translate, simplify, analysis, clean — with the cloud
 * fallback on the end of it.
 *
 * ── THE CLOUD PROVIDER IS A LAST RESORT AND NOT A FIRST ANSWER ─────────────
 *
 * Owen asked for it in exactly those terms (docs/SLOTS.md §1): *"give them the
 * option of connecting an api key for openai or claude instead of using the 27b
 * or the 9b… **for weaker systems**."* So it is consulted only where the machine
 * itself has said no. A provider that lit these tiles unconditionally would
 * quietly move the default answer for a person with a 24 GB card off their own
 * GPU and onto a bill — and the tile is not where that choice is made anyway:
 * the PICKER is (docs/SLOTS.md §3, *"a deliberate per-job choice, never
 * something `any` falls through to"*). What the tile does here is stop being
 * gray, so the dialog can be opened at all and the row inside it aimed at the
 * provider.
 *
 * THE LOCAL SENTENCE IS KEPT AND THE CLOUD ONE IS ADDED TO IT, rather than
 * replacing it. "There is no GPU a model can use" is still the fact about this
 * machine, and a person who reads only "via OpenAI (cloud)" would not know why
 * their own card is not being offered.
 *
 * READING IS NEVER LIT BY ONE — see `readGate`, which does not consult this at
 * all: page reading is a VLM pass and stays local or on a Crucible
 * (docs/SLOTS.md §3).
 */
function textGate(cls: ModelClass, machine: Machine): ActGate {
  const local = localTextGate(cls, machine);
  if (local.lit) return local;
  const provider = machine.cloud;
  if (provider === null) return local;
  return {
    lit: true,
    why: `${local.why} A cloud provider is connected, so this can run via ${provider} (cloud) — `
      + 'choose it on the job\'s own row in the queue. It spends usage credits, and the text is '
      + 'sent to that provider.',
  };
}

/**
 * The same gate asked only of THIS MACHINE — everything above the cloud.
 *
 * THE ORDER OF THE BRANCHES IS THE ORDER OF THE ANSWERS. A Crucible serving the
 * class answers first because it makes every question under it irrelevant; a
 * non-ollama server second for the same reason; then the clock, then the
 * catalog, then the store. Each refusal names the NEXT thing that would change
 * it, which is what makes a gray tile actionable rather than final.
 */
function localTextGate(cls: ModelClass, machine: Machine): ActGate {
  /*
   * A LOCAL CRUCIBLE SERVING THE CLASS LIGHTS IT OUTRIGHT. `unknown` — no local
   * entry, nothing probed yet, or a local server that did not answer — falls
   * through to the ollama path rather than lighting anything, because a tile lit
   * by a server this app has not heard from would be a tile lit by a guess. The
   * answer comes out of `refreshCrucibleFacts`, awaited once in `actGates`.
   */
  if (localCrucibleServes(cls) === 'yes') {
    const server = localCrucibleTakeover()?.server;
    return {
      lit: true,
      why: server === undefined
        ? 'A Crucible on this machine is serving this class.'
        : `"${server}", the Crucible on this machine, is serving this class.`,
    };
  }

  /*
   * THERE IS NO OTHER LOCAL LANGUAGE SERVER. The local slot is Ollama, full
   * stop (docs/SLOTS.md §3); anything else that could serve this class is a
   * registered Crucible, which is a SLOT rather than a setting and is answered
   * by `localCrucibleServes` above. The setting that once named a vLLM here
   * was retired with the registry, so a machine "pointed at a server" is no
   * longer a state this gate can be in.
   */
  const eligible = eligibleFor(cls);
  /*
   * THE SMALLEST THING THAT MAY SERVE THIS CLASS, and the sentences below have
   * to say WHY it is the smallest. When the class has a declared floor — the 9B
   * for translate and simplify — "X or larger" is the rule being quoted. When it
   * has none, the same phrasing would invent a rule: the 0.8B is merely the
   * first row in the table, and saying "you need the 0.8B or larger" about a
   * class that would take anything is a refusal citing a constraint that is not
   * there. So the two cases get two sentences.
   */
  const floor = eligible[0];
  const floored = eligible.some((row) => row.minimumFor.includes(cls));
  const need = floor === undefined
    ? 'a language model'
    : floored ? `${floor.label} or larger` : `at least ${floor.label}`;

  /*
   * ── THE CLOCK, BEFORE THE CATALOG ─────────────────────────────────────────
   *
   * `memoryBasis === 'ram'` is `system-probe.ts`'s name for "there is no GPU a
   * model can use" — not a small GPU, none. Sixteen gigabytes of system RAM will
   * hold the 9B and then produce a word or two a second. `lineupFor` still lists
   * the whole table with honest fits/doesn't-fit against that RAM, because the
   * wizard's job is to describe the machine; the TILE's job is to not start an
   * eight-day job, so it refuses here and says which of the two facts is the
   * reason.
   *
   * CLEAN IS NOT IN THIS BRANCH. See the header's note 3.
   */
  if (machine.profile.memoryBasis === 'ram' && cls !== 'clean') {
    return {
      lit: false,
      why: `This machine has no GPU a model can use, and ${need} on the processor alone would take `
        + `days over a book. Connect a Crucible server, or point ${SETTINGS_PATH} at one that is `
        + 'not local.',
    };
  }

  if (!machine.ollama.running) {
    return { lit: false, why: machine.ollama.detail };
  }

  const fitting = eligible.filter((row) => fitsOn(row, machine.profile));
  if (fitting.length === 0) {
    return {
      lit: false,
      why: `This needs ${need}, which wants `
        + `${floor === undefined ? 'more' : `${floor.local.needsGB.value} GB`} — this machine has `
        + `${gb(machine.profile.modelMemoryMB)} of ${pool(machine.profile)}.`,
    };
  }

  const present = fitting.filter((row) => heldBy(row, machine.held));
  if (present.length === 0) {
    return {
      lit: false,
      why: `${namesOf(fitting)} would run here, and none of them is installed — pull one from `
        + `${SETTINGS_PATH}.`,
    };
  }

  // The largest present one, because that is the one the acts will open with and
  // the one whose name answers "why is this taking an hour".
  const best = present[present.length - 1]!;
  return { lit: true, why: `${best.label} is installed and fits this machine.` };
}

/** "Qwen 3.5 · 4B", "Qwen 3.5 · 4B or Qwen 3.5 · 9B", "A, B or C" — for a sentence. */
function namesOf(rows: readonly LineupRow[]): string {
  const labels = rows.map((row) => row.label);
  if (labels.length <= 1) return labels[0] ?? 'A language model';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * Reading the pages — the one act whose model this app serves itself.
 *
 * ── THREE ENDPOINTS, AND ONLY ONE OF THEM IS OURS TO CHECK ──────────────────
 *
 * `auto` mode is the engine choosing its own tier for itself and never goes
 * through an endpoint at all (`endpointFor`, job-queue.ts) — there is nothing
 * here to be missing, so the tile is lit. A REMOTE endpoint is somebody else's
 * server: this app does not start it, cannot inventory it, and "configured" is
 * the most it can honestly know, so the tile is lit and a server that is asleep
 * refuses at the request with its own sentence. The LOCAL page reader is the
 * only one this app installs, and it is the only one that can be missing in a
 * way this function can see.
 *
 * ASKED CHEAPLY, on purpose — `pageReaderInstalled` rather than
 * `pageReaderState`, which prices the download over the network when something
 * is absent. That read belongs to a settings card somebody is looking at, not to
 * a tooltip.
 */
function readGate(): ActGate {
  /*
   * A CRUCIBLE THAT IS SERVING PAGES IS NOT YET A CRUCIBLE THAT IS READING THEM.
   *
   * `pageReaderSuperseded` is the question with both halves in it: the server
   * says it serves the class AND this app sends reads there (`CRUCIBLE_READS`,
   * crucible-dispatch.ts, still false). Asking `localCrucibleServes` directly
   * here would light the tile on the strength of a capability record while the
   * job still went to a local llama-server that may not be installed — a lit tile
   * over a read that fails, which is the exact failure a gate exists to prevent.
   */
  const superseded = pageReaderSuperseded();
  if (superseded !== null) {
    return {
      lit: true,
      why: `"${superseded}", the Crucible on this machine, is reading pages — so Foundry's own `
        + 'copy of the reader is not needed here.',
    };
  }

  const settings = readSettings();
  const endpoint = settings.backend.mode === 'endpoint'
    ? settings.backend.endpointUrl?.trim() ?? ''
    : '';

  if (endpoint.length === 0) {
    return { lit: true, why: 'Reading runs through the engine\'s own tier for this machine.' };
  }
  if (!isLocalPageReader(endpoint)) {
    return { lit: true, why: `Pages are read through ${endpoint}.` };
  }
  if (pageReaderInstalled()) {
    return { lit: true, why: `The local page reader is installed and serves ${PAGE_READER_MODEL}.` };
  }
  return {
    lit: false,
    why: 'The local page reader is not installed yet, so there is nothing here to read the pages '
      + 'with — install it from Settings › Page reader, or point the reading endpoint elsewhere.',
  };
}

/**
 * Every tile's answer, in one read.
 *
 * NOTHING UNDER IT REJECTS, and that matters more here than the answer does: a
 * dock whose gates failed to load would draw five disabled tiles with no
 * explanation, which is the worst possible failure for a feature whose whole
 * point is saying why. `probeSystem` reports every unreadable number as a null
 * with a sentence, `probeOllama` answers an absent server with `running: false`
 * and its own detail, and both settings readers answer a missing or malformed
 * file with defaults. So there is no `catch` here to write — adding one would be
 * a handler for a case none of those four can produce, and it would swallow a
 * genuine program error on the way past.
 */
export async function actGates(): Promise<ActGates> {
  /*
   * ── HOSTED IS LIT, WHOLESALE ──────────────────────────────────────────────
   *
   * See the header's note 1. It is answered before anything is probed because
   * probing would be measuring a machine that is not going to run the work.
   */
  if (hosted()) {
    const why = 'This window is hosted, so the work runs on the host\'s own compute.';
    return {
      translate: { lit: true, why },
      simplify: { lit: true, why },
      analysis: { lit: true, why },
      clean: { lit: true, why },
      read: { lit: true, why },
    };
  }

  const settings = readAppSettings();
  /*
   * THE CRUCIBLE FACTS ARE REFRESHED HERE AND READ SYNCHRONOUSLY BELOW.
   * `localCrucibleServes` cannot be awaited inside a gate — the gates are five
   * synchronous answers composed from one measurement — so the measurement is
   * taken once, up front, beside the two probes that were always here. The
   * provider's cache keeps this to one round of requests every fifteen seconds
   * however often the dock reloads, and its own timeout keeps a sleeping server
   * from putting a stall behind a tooltip.
   */
  const [profile, ollama] = await Promise.all([
    probeSystem(),
    probeOllama(settings.ollamaUrl),
    refreshCrucibleFacts(),
  ]);

  const machine: Machine = {
    profile,
    ollama,
    held: heldSet(ollama.models),
    /*
     * READ SYNCHRONOUSLY AND OUT OF THE SETTINGS FILE, with nothing probed. A
     * provider has no state this app can ask about cheaply — no capability
     * record, no residency, nothing that is "busy" — and the one thing that
     * could be wrong (the key, the model id) is `Test`'s question on the
     * settings card, asked once by a person, not on every gate read behind a
     * tooltip. `enabled` is the whole of what this gate needs to know.
     */
    cloud: enabledCloudProviders()[0]?.name ?? null,
  };

  return {
    translate: textGate('translate', machine),
    simplify: textGate('simplify', machine),
    analysis: textGate('analysis', machine),
    clean: textGate('clean', machine),
    read: readGate(),
  };
}
