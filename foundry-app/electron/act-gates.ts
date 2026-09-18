/**
 * act-gates — is anything serving this act, and the sentence either way.
 *
 * ── OWEN'S RULE, AND IT IS ONE RULE NOW ─────────────────────────────────────
 *
 * 2026-09-15: *"we dont have any local models. crucible handles all model
 * orchestration. if theres no connected crucible server then tiles should be
 * disabled. crucible is a service that foundry installs locally and connects
 * to."*
 *
 * So one question is left: is something SERVING this act. An enabled engine
 * whose capability row for the class says so, a connected cloud provider, or —
 * for `pages` alone — the reader on this disk. Nothing about this machine's
 * memory, its processor or its Ollama store is consulted any more, because none
 * of them is where the work runs.
 *
 * ── WHAT THIS FILE USED TO DO, AND WHY IT IS DELETED RATHER THAN DISABLED ───
 *
 * It measured the machine: the catalogue's floor per class, the fit against the
 * card, whether Ollama already held a model at or above that floor, and a branch
 * that refused outright on a processor-only box. Wave 67 had already stopped the
 * last of those LIGHTING anything — with no local GPU slot there was nowhere for
 * a queued text act to run here, so a tile lit by an installed model failed the
 * moment it was pressed. What goes now is the reasoning behind the dark
 * sentence, because a refusal that explains this machine's card is a refusal
 * about the wrong computer.
 *
 * ── THIS GATE IS ABOUT THE VENUE. THE OTHER ONE IS ABOUT THE BOOK ───────────
 *
 * `shared/stages.ts` already answers "can this act be aimed at where I am
 * standing" — is there a book at this position, is this the import row. That
 * question is unchanged and still asked in the renderer, where the standing
 * position lives. This file answers a question the renderer cannot: what is
 * serving. Both have to say yes, and they say DIFFERENT things when they say no,
 * which is exactly why they are two gates and not one — a tooltip reading "there
 * is no book here" on a machine with no engine would send somebody to open a
 * book that will not help them.
 *
 * ── WHY IT IS MAIN'S, AND WHY IT IS ONE FUNCTION ────────────────────────────
 *
 * Every fact in it lives in main: the settings file, the page reader's
 * directory, and the server registry's capability reads. A renderer assembling
 * the answer would be several IPC calls and a join written once per surface, and
 * the surfaces would drift the first time one of them forgot a clause. So
 * `actGates()` is the whole answer, every act at once, and the tiles read it.
 *
 * ── FOUR PLACES IT DELIBERATELY DOES NOT REFUSE ─────────────────────────────
 *
 * 1. **A HOSTED WINDOW.** The work goes to the HOST's queue and runs on the
 *    host's compute — BookForge requires Crucible and never had an Ollama
 *    fallback at all (Owen, docs/SLOTS.md §1). Gating BookForge's tiles on this
 *    machine would dark a rail whose jobs never touch it. So hosted is lit, and
 *    the sentence says whose compute it is.
 * 2. **ANY ENABLED REGISTERED SERVER WHOSE CAPABILITY ROW FOR THE CLASS SAYS
 *    `enabled`.** Local or in another room; a resident model on its card or an
 *    UPSTREAM route it forwards on the operator's account (crucible
 *    docs/PHASE15-HOST.md §3.3). `anyServerServing` (crucible-provider.ts) is
 *    the reader, and it is now the ONLY thing that lights a text tile.
 *
 *    **It was LOCAL-ONLY until Wave 62**, and the sentence that kept a remote
 *    server out said: *"a reachability check on every gate read would put a
 *    network timeout behind a tooltip."* That argument is retired, not
 *    overruled — it was about a gate that PROBED, and this one does not. The
 *    provider's snapshot already has every enabled server's answer, every probe
 *    in it carried a three-second clock, and a machine that did not answer is
 *    `unknown` rather than a stall. Consulting a remote server costs zero
 *    requests.
 * 3. **READING, WHICH STILL HAS A LOCAL PATH AND IS THE ONLY ACT THAT DOES.**
 *    See `readGate`. Clause 2 covers the `pages` class exactly as it covers the
 *    four text ones now that `CRUCIBLE_READS` is true (crucible-dispatch.ts):
 *    Owen, 2026-09-14, *"if it uses the GPU (as dots does), it should probably be
 *    crucible-side."* But Foundry installs a reader of its own, and that reader
 *    is the only route to an EPUB on a machine that cannot install WSL — so when
 *    no server serves `pages`, this file still asks the disk.
 * 4. **A MACHINE WITH A CLOUD PROVIDER CONNECTED.** Owen's weaker-system case
 *    (docs/SLOTS.md §1): *"give them the option of connecting an api key for
 *    openai or claude instead of using the 27b or the 9b… for weaker systems."*
 *    An enabled provider lights translate, simplify, analysis and clean AFTER
 *    the engines have said no — see `textGate`, which argues why it is last and
 *    not first. It lights READING for nobody: page reading is a VLM pass and
 *    stays local or on a Crucible.
 */
import { enabledCloudProviders } from './cloud-providers';
import {
  anyServerServing,
  firstServerReason,
  refreshCrucibleFacts,
} from './crucible-provider';
import { hosted } from './host';
import type { ActGate, ActGates, ModelClass } from '../shared/types';

const OTHER_ROUTES = 'Add a GPU engine in Settings › Crucible Servers, and Settings › AI '
  + 'will send this class to that engine, or on to an Anthropic, OpenAI or Ollama account';

/**
 * ── THE ENGINE'S ANSWER, AND IT IS THE FIRST ONE ASKED FOR EVERY CLASS ─────
 *
 * Header note 2. Any enabled registered server whose capability row for this
 * class says `enabled` lights the tile — and lights it OUTRIGHT, because the
 * weights (or the account) are over there and nothing about this machine's
 * memory, its processor or its ollama store binds the answer.
 *
 * NULL FALLS THROUGH, and null is both "every server said no" and "nothing has
 * answered yet". A tile lit by a server this app has not heard from would be a
 * tile lit by a guess; the answer comes out of `refreshCrucibleFacts`, awaited
 * once in `actGates`, and a machine that did not answer inside its three-second
 * clock is simply not in it.
 *
 * ── THE SENTENCE NAMES THE MACHINE, AND THE UPSTREAM WHEN THERE IS ONE ─────
 *
 * PHASE15 §3.3: a row's `route` is `local` or `upstream`, and `selected` is the
 * model id either way. A person who has routed simplify to Anthropic and reads
 * *"'mac-studio' is serving this class"* would have no way to know the work is
 * about to be billed, so the upstream is in the sentence — the one place they
 * will be looking. The MODEL ID is there too because it is the operator's own
 * choice and this is the only surface that shows it.
 */
function servedGate(cls: ModelClass): ActGate | null {
  const served = anyServerServing(cls);
  if (served === null) return null;
  if (served.route === 'upstream') {
    const upstream = served.selected.split('/')[0] ?? served.selected;
    return {
      lit: true,
      why: `"${served.server}" runs this class via ${upstream} (${served.selected}). `
        + 'The text is sent to that service on the engine\'s account.',
    };
  }
  return { lit: true, why: `"${served.server}" is serving this class with ${served.selected}.` };
}

/**
 * THE DARK SENTENCE, WITH THE FIRST ENABLED SERVER'S OWN WORDS ON THE END.
 *
 * ── The case this exists for, verbatim ─────────────────────────────────────
 *
 * A host-mode Crucible on a machine with no WSL answers `tts asr align rvc
 * denoise` with one sentence — *"this job type needs the WSL2 engine
 * (vLLM/SGLang); install it from the console"* (PHASE15 §3.3) — and a server
 * whose card is too small for the 27B answers with the shortfall it measured.
 * Neither is a sentence this app could compose, and both say exactly what to do.
 * A tile that dropped them and said only "this machine has no GPU a model can
 * use" would be answering about the wrong computer.
 *
 * ONLY ON A DARK TILE, and only when a server actually said something. A lit
 * tile has nothing to explain, and a server with no `reason` on the row has no
 * opinion to add — an empty quote attributed to a machine is worse than silence.
 */
function withServerReason(cls: ModelClass, dark: ActGate): ActGate {
  const said = firstServerReason(cls);
  if (said === null) return dark;
  return { lit: false, why: `${dark.why} "${said.server}" says: ${said.reason}` };
}

/**
 * A text act's gate — translate, simplify, analysis, clean.
 *
 * TWO THINGS CAN LIGHT IT, AND BOTH ARE SOMEWHERE ELSE: an enabled engine whose
 * capability row for the class says so, and a connected cloud provider. There is
 * no third answer, because Foundry runs no model itself (Owen, 2026-09-15:
 * *"we dont have any local models. crucible handles all model orchestration"*).
 *
 * ── THE CLOUD PROVIDER IS A LAST RESORT AND NOT A FIRST ANSWER ─────────────
 *
 * Owen asked for it in exactly those terms (docs/SLOTS.md §1): *"give them the
 * option of connecting an api key for openai or claude instead of using the 27b
 * or the 9b… **for weaker systems**."* So it is consulted only after the engines
 * have said no. A provider that lit these tiles unconditionally would quietly
 * move the default answer for somebody with an engine of their own onto a bill —
 * and the tile is not where that choice is made anyway: the PICKER is
 * (docs/SLOTS.md §3, *"a deliberate per-job choice, never something `any` falls
 * through to"*). What the tile does here is stop being gray, so the dialog can
 * be opened at all and the row inside it aimed at the provider.
 *
 * THE ENGINE SENTENCE IS KEPT AND THE CLOUD ONE IS ADDED TO IT, rather than
 * replacing it. "No connected GPU engine serves this act" is still the fact, and
 * a person who reads only "via OpenAI (cloud)" would not know why the engine
 * they thought they had connected is not being offered.
 *
 * READING IS NEVER LIT BY ONE — see `readGate`, which does not consult this at
 * all: page reading is a VLM pass and stays local or on a Crucible
 * (docs/SLOTS.md §3).
 */
function textGate(cls: ModelClass, cloud: string | null): ActGate {
  const served = servedGate(cls);
  if (served !== null) return served;
  /*
   * ── THE DARK SENTENCE, WHICH IS NOW ONE SENTENCE ──────────────────────────
   *
   * It used to be four, and each named the next thing about THIS MACHINE that
   * would change the answer: no GPU at all, Ollama not running, nothing in the
   * catalogue small enough, nothing pulled. Every one of them described a
   * computer that no longer runs the work. What is true instead is short, and it
   * ends where a person can act: `OTHER_ROUTES` names the Servers card and the
   * engine's own routing card, which is where a model gets chosen now.
   */
  const dark = withServerReason(cls, {
    lit: false,
    why: `No connected GPU engine serves this act. ${OTHER_ROUTES}.`,
  });
  if (cloud === null) return dark;
  return {
    lit: true,
    why: `${dark.why} A cloud provider is connected, so this can run via ${cloud} (cloud) — `
      + 'choose it on the job\'s own row in the queue. It spends usage credits, and the text is '
      + 'sent to that provider.',
  };
}

/**
 * Reading the pages — and it is no longer the odd one out.
 *
 * ── IT USED TO BE "THE ONE ACT WHOSE MODEL THIS APP SERVES ITSELF" ────────
 *
 * That was the opening line of this comment, and it was the whole difference
 * between this gate and {@link textGate}. Where a text act with no engine goes
 * dark, a reading fell through to `backend.endpointUrl` and Foundry's own
 * llama.cpp copy of dots.ocr, so the tile lit on a machine with no Crucible at
 * all and said *"Reading runs through the engine's own tier for this machine."*
 *
 * Owen deleted the premise on 2026-09-17: *"foundry shouldnt assume there even
 * is a local system. there sohuldnt be a local system. foundry does all ai work
 * through crucible."* So this is `textGate` without the cloud arm — `pages` may
 * never route upstream (PHASE15 §1), so there is no provider to offer either.
 *
 * THE THREE CLAUSES THAT WENT WITH IT. `pageReaderSuperseded` said a Crucible
 * on this machine owned the weights so Foundry's own copy was not needed —
 * true, and now true of every machine, which makes it nothing to say.
 * `isLocalPageReader` sorted a configured endpoint into "ours" and "somebody
 * else's". `pageReaderInstalled` asked whether the local copy was on the disk.
 * All three answered questions about a reader this app no longer has.
 */
function readGate(): ActGate {
  const served = servedGate('pages');
  if (served !== null) return served;
  /*
   * THE SERVER'S OWN SENTENCE IS STILL ON THE END, and it matters more here
   * than anywhere else: a host-mode Crucible on a Windows machine with no WSL2
   * cannot read pages at all and says so in its own words, and a Mac Crucible
   * answers that dots-ocr declares no mlx-darwin build. Neither is a sentence
   * this app could have composed, and both name the reason the tile is dark.
   */
  return withServerReason('pages', {
    lit: false,
    why: `No connected GPU engine reads pages. ${OTHER_ROUTES}.`,
  });
}

/**
 * Every tile's answer, in one read.
 *
 * NOTHING UNDER IT REJECTS, and that matters more here than the answer does: a
 * dock whose gates failed to load would draw five disabled tiles with no
 * explanation, which is the worst possible failure for a feature whose whole
 * point is saying why. `refreshCrucibleFacts` answers a sleeping server with a
 * timeout rather than a throw, and both settings readers answer a missing or
 * malformed file with defaults. So there is no `catch` here to write — adding
 * one would be a handler for a case neither of those can produce, and it would
 * swallow a genuine program error on the way past.
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

  /*
   * THE CRUCIBLE FACTS ARE REFRESHED HERE AND READ SYNCHRONOUSLY BELOW.
   * `anyServerServing` cannot be awaited inside a gate — the gates are five
   * synchronous answers composed from one measurement — so the measurement is
   * taken once, up front. It is the ONLY await left: the hardware probe and the
   * Ollama probe that used to stand beside it were measuring a machine that does
   * not run the work. The provider's cache keeps this to one round of requests
   * every fifteen seconds however often the dock reloads, and its own timeout
   * keeps a sleeping server from putting a stall behind a tooltip.
   */
  await refreshCrucibleFacts();

  /*
   * READ SYNCHRONOUSLY AND OUT OF THE SETTINGS FILE, with nothing probed. A
   * provider has no state this app can ask about cheaply — no capability record,
   * no residency, nothing that is "busy" — and the one thing that could be wrong
   * (the key, the model id) is `Test`'s question on the settings card, asked once
   * by a person, not on every gate read behind a tooltip. `enabled` is the whole
   * of what this gate needs to know.
   *
   * THE NAME AND NOT THE ENTRY, because that is all four gates want and because
   * an entry carries an API key: a shape holding a credential passed into four
   * sentence-composing functions is a credential one `${}` away from a tooltip.
   *
   * THE FIRST AND NOT A CHOICE. This lights a tile; it does not place a job. Two
   * providers connected means the tile is lit either way and the PICKER on the
   * row is where the one that runs is chosen, so naming the first is a sentence
   * that is true rather than a decision made in the wrong place.
   */
  const cloud = enabledCloudProviders()[0]?.name ?? null;

  return {
    translate: textGate('translate', cloud),
    simplify: textGate('simplify', cloud),
    analysis: textGate('analysis', cloud),
    clean: textGate('clean', cloud),
    read: readGate(),
  };
}
