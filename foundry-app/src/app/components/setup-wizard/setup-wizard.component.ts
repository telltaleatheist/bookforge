/**
 * setup-wizard — the screen a person meets the first time foundry is opened.
 *
 * ── WHAT IT IS FOR, IN ONE SENTENCE ─────────────────────────────────────────
 *
 * Foundry needs TWO things that do not arrive with the application — a folder to
 * keep books in, and a GPU engine — and until this screen existed, a new
 * installation discovered both by failing at them.
 *
 * IT WAS FOUR, and the other two left the same way: the prebuilt Pythons became
 * something startup provisions for itself, and the page reader was deleted
 * outright on 2026-09-17 (*"there sohuldnt be a local system. foundry does all
 * ai work through crucible"*). So this screen no longer downloads anything at
 * all, which is a change in kind rather than in size — see the welcome step,
 * which used to promise a price beside every button.
 *
 * OF THE TWO, ONE IS OPTIONAL AND ONE IS NOT. The library folder has a default
 * and a person can walk past it. The engine cannot be walked past and the screen
 * should stop implying otherwise: since Wave 66 every GPU slot in the queue is a
 * registered engine, so somebody who skips it has no slot and cannot translate,
 * simplify, clean, analyse or read a page.
 *
 * ── IT USED TO ASK FOR OLLAMA AND A MODEL, AND THAT STEP IS DELETED ─────────
 *
 * Between the library and the engine there was a step that probed for Ollama,
 * offered to fetch its official installer, listed the Qwen lineup with one row
 * badged for this machine's card, and pulled the chosen tag with a bar. Owen,
 * 2026-09-15: *"we dont have any local models. crucible handles all model
 * orchestration. if theres no connected crucible server then tiles should be
 * disabled."* Foundry runs no model, so there is nothing for this screen to
 * measure the machine against and nothing for it to download.
 *
 * ── THE ENGINE STEP IS THE ONE THAT MATTERS NOW ─────────────────────────────
 *
 * It offers three doors — connect to one elsewhere, use one already on this
 * machine, install one here — and it stopped being optional in Wave 66: every
 * GPU slot in the queue is a registered engine, so somebody who skips it cannot
 * translate, simplify, clean, analyse or read pages at all. The doors themselves
 * are a child component (`app-crucible-doors`) shared with the Settings card so
 * the two screens cannot offer different choices.
 *
 * ── IT IS A FLOW, NOT A QUESTION, AND THAT DECIDES THREE THINGS ─────────────
 *
 * `UiService.dialogs` is the one-modal list, and this is deliberately not on
 * it (see `setupOpen` there). A modal is a question with an answer; this is
 * several steps, one of which STARTS WORK THAT OUTLIVES THE STEP — installing
 * an engine, and on Windows upgrading it to WSL afterwards, both of which keep
 * going if this card is dismissed. (It used to be the page-reader download that
 * made this true. That is gone; the install is not.) So:
 *
 *   * it does not go through `only()`, which would let any dialog opened over
 *     it clear the boolean and take a half-finished setup off the screen;
 *   * it is MOUNTED UNCONDITIONALLY by the shell and holds its own `@if`,
 *     because an `@if` around this component is a DESTROY, and destroying it
 *     mid-install would drop the progress subscription that is the only thing
 *     telling somebody their engine is still being built;
 *   * closing it is never a failure. `setup:finish` is called on the way out
 *     however it is left, and what was skipped is written down.
 *
 * ── NOTHING DOWNLOADS BECAUSE YOU ARRIVED SOMEWHERE ─────────────────────────
 *
 * Every step that costs bytes has a button, and the button is the permission.
 * Arriving at the environments step reads the catalog (a directory check),
 * arriving at the engine step reads the registry — neither of those spends
 * anything of the user's. The moment something is going to be fetched, the size
 * is on screen next to the button that fetches it.
 *
 * ── NEVER WHEN HOSTED ───────────────────────────────────────────────────────
 *
 * Inside BookForge the library folder is the host's (docs/BOOKFORGE-HANDOFF.md
 * §8), the environments are provisioned by the host's own component manager,
 * and `library:set` refuses outright. A first-run wizard there would be five
 * steps of asking for things somebody else already decided.
 */
import { capabilityRowFor } from '@owen/foundry-core/shared/types';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';

import type { CrucibleCoordinationMap } from '@owen/foundry-core/shared/coordinate-wire';
import type { CrucibleProbe, CrucibleServerView } from '@owen/foundry-core/shared/slots';
import {
  LLM_CLASSES,
  defaultEngineServer,
  splitUpstreamModel,
  type CapabilityRecord,
  type CapabilityRow,
} from '@owen/foundry-core/shared/engine-settings';
import { CrucibleDoorsComponent } from '../crucible-doors/crucible-doors.component';
import { CrucibleInstallOutcomeComponent } from '../crucible-doors/install-outcome.component';
import {
  FOUNDRY_ACTS,
  HOSTED_ONLY_ACTS,
  actWords,
  cardWords,
  coordinationWords,
  shortfallWords,
} from '../../core/crucible-words';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

type StepId =
  | 'welcome' | 'library' | 'crucible' | 'done';

interface StepDef {
  id: StepId;
  /** The dot's tooltip and the card's heading. */
  title: string;
  /** One sentence under the heading saying what this step is about. */
  blurb: string;
}

/**
 * The order, and the only place it is written down.
 *
 * Library first because it is free and it is the one answer everything else
 * lands beside, then the engine, then what runs where, and that is the whole of
 * it.
 *
 * ── THE PYTHON STEP IS GONE, AND SO IS THE HARDWARE LINE ──────────────────
 *
 * Owen, 2026-09-15, reading this wizard on a machine with a Crucible already
 * running on it: *"not sure what all this stuff is for… but it should all be
 * automatic. the user doesnt need to see this stuff about crucible to set it
 * up."* Two screens went on that ruling:
 *
 *   * **Python environments.** `electron/env-provision.ts` has provisioned
 *     these at startup since it was written — *"the app provisions ITSELF. A
 *     user who installs foundry and opens a PDF should not first have to read a
 *     settings screen and press a button labelled with a word ('rasteriser')
 *     they have no reason to know"* — so the step was asking permission for a
 *     download that had already been decided, in that exact word. The one pack
 *     startup does NOT queue (the analysis worker, 528 MB) keeps its row in
 *     Settings › Python environments, which is where somebody who wants it will
 *     look. Nothing is deleted here and no download changed.
 *   * **The machine's own card, on the welcome page.** `system:probe` runs
 *     `nvidia-smi` on this computer, and since Wave 67 this computer's card is
 *     not where anything runs: *"one gpu slot in the queue per connected
 *     crucible server."* The card a person needs to see is the one the ENGINE
 *     reports, and it is on the engine step now, in that server's own words.
 *     `probeSystem` keeps its two honest callers — `crucible-install.ts`, which
 *     describes the machine that would HOST a server, and the held local page
 *     reader.
 */
const STEPS: readonly StepDef[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    /*
     * IT SAID *"Each one can be skipped"*, which is true of the mechanism and
     * misleading about the result: skipping the engine leaves a queue with no
     * GPU slot, and the engine step two screens later says so at length. A
     * welcome page that contradicts a step is worse than one that says less.
     */
    blurb: 'A library folder, and a GPU engine that does the actual work. Both can be changed later in Settings.',
  },
  {
    id: 'library',
    title: 'Your library',
    blurb: 'Where finished books live. A folder you can open, back up and sync — not somewhere hidden.',
  },
  {
    /*
     * AFTER THE LIBRARY AND BEFORE THE ENVIRONMENTS. It used to sit after an
     * Ollama step, on the argument that the Ollama step *"is what most people will
     * use and a Crucible offered first would read as a requirement"* — and since
     * Wave 66 it IS one, and since 2026-09-15 there is no Ollama step to sit
     * after. Before the environments, because it is a decision rather than a
     * download: somebody who connects to an engine here has changed what the rest
     * of setup means, and finding that out after paying for two Pythons would be
     * finding it out too late.
     */
    id: 'crucible',
    /*
     * IT SAID *"Crucible (optional)"* AND *"Most people should skip this"*, and
     * Owen's Wave 66 ruling retired both: *"everything goes through a crucible
     * server now, including local… there should be no local gpu listed in the
     * queue."* Every GPU slot in the queue is a registered engine, so a person
     * who skips this step has no slot and cannot translate, simplify, clean,
     * analyse or read pages at all. Telling them to walk past it would be this
     * screen sending somebody to a dead queue.
     */
    title: 'A GPU engine',
    blurb: 'Where translation, simplification, cleanup, analysis and page reading run — on this machine or another one. Without one they cannot run.',
  },
  /*
   * ── THE PAGE READER STEP IS GONE (2026-09-17) ──────────────────────────
   *
   * It offered to download dots.ocr onto this machine, and it was already
   * conditional: hidden when a connected engine served `pages`. Wave 68 kept
   * it deliberately as "the only road to an EPUB on a machine that cannot
   * install WSL".
   *
   * Owen closed that road on 2026-09-17: *"foundry shouldnt assume there even
   * is a local system. there sohuldnt be a local system. foundry does all ai
   * work through crucible."* A machine with no engine now reads no pages and
   * is TOLD so -- electron/act-gates.ts darks the tile with the engine's own
   * sentence -- rather than being sold a six-gigabyte fallback during setup.
   *
   * The step above it is where that machine's answer is: connect an engine.
   */
  {
    id: 'done',
    title: 'Finish setup',
    blurb: 'Everything here stays changeable in Settings.',
  },
];

@Component({
  selector: 'app-setup-wizard',
  imports: [CrucibleDoorsComponent, CrucibleInstallOutcomeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup-wizard.component.html',
  styleUrl: './setup-wizard.component.scss',
})
export class SetupWizardComponent {
  private readonly ui = inject(UiService);

  protected readonly current = signal<StepId>('welcome');
  /** The four llm classes, in the order the routes step draws them. */
  protected readonly classes = LLM_CLASSES;
  protected readonly libraryDir = signal('');
  /** The registry, so the Crucible step can say what is already there. */
  protected readonly crucibleServers = signal<CrucibleServerView[]>([]);
  /** Asked before the line that says none was found: it may not be true. */
  protected readonly crucibleHere = signal(false);
  /**
   * WHAT THE CONNECTED ENGINE IS AND WHAT IT CAN DO — `loadEngineFacts`.
   *
   * `null` on both means "there is nothing to show about an engine", which
   * covers an empty registry AND a registered server that would not answer, and
   * the step draws the doors for both. They are never half-set.
   */
  protected readonly engineProbe = signal<Extract<CrucibleProbe, { outcome: 'ok' }> | null>(null);

  protected readonly engineCap = signal<CapabilityRecord | null>(null);
  protected readonly engineAsking = signal(false);
  /**
   * Whether the three doors are open on the CONNECTED face.
   *
   * It starts closed and there is no reason to persist it: a person who came
   * here to add a second machine adds it, and the next time this screen opens
   * the second machine is why they are not looking for the button.
   */
  protected readonly moreDoors = signal(false);
  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  /**
   * THE FIVE ACTS THIS APP HAS, each with the engine's own verdict, in
   * {@link FOUNDRY_ACTS} order — and a class the server did not mention at all
   * is DROPPED rather than drawn as a refusal.
   *
   * An absent row means the server is older than that class, not that the card
   * is too small, and "Analyse claims — will not run here" over a server that
   * has simply never heard of analysis would send somebody to buy a graphics
   * card for a problem an upgrade fixes.
   */
  protected readonly engineActs = computed(() => {
    const record = this.engineCap();
    if (record === null) return [];
    // The wizard only ever runs standalone, so the hosted-only acts are not
    // reported as this app's (`HOSTED_ONLY_ACTS`).
    return FOUNDRY_ACTS
      .filter((name) => !HOSTED_ONLY_ACTS.has(name))
      .flatMap((name) => {
        const row = capabilityRowFor(record.classes, name);
        return row === undefined ? [] : [{ ...row, capability: name }];
      })
      .map((row) => ({
        act: actWords(row.capability),
        enabled: row.enabled,
        /*
         * WHAT IS RUNNING IT, and the two routes read differently on purpose.
         * A local class names the MODEL, because that is the thing on the card
         * and the thing whose speed somebody is about to notice. An upstream
         * class names the ACCOUNT rather than the model id, because
         * `anthropic/claude-sonnet-5` in a list of five rows is an id, and "via
         * your Anthropic account" is the fact that explains why that row is
         * lit when the card could not do it.
         */
        by: row.route === 'upstream'
          ? `via your ${splitUpstreamModel(row.selected)?.upstream ?? 'connected'} account`
          : row.selected,
        reason: row.reason,
        shortfall: shortfallWords(row.shortfallBytes),
        /* `pages` cannot route upstream (PHASE15 §1), so it is never offered a key. */
        routable: (LLM_CLASSES as readonly string[]).includes(row.capability),
      }));
  });

  /**
   * Whether any TEXT act is refused, which is the one case Owen named as
   * deserving an offer: *"if the crucible server isnt powerful enough to run
   * translate, because it's running on an 8 gb gpu and cant run the 27b, it can
   * prompt them for claude or chatgpt api key for that."*
   *
   * It POINTS at the next step rather than growing a key field of its own. The
   * routes step is PHASE15 §5.2's panel and already holds the whole of this —
   * the upstream child, the write-through, the test button — and a second key
   * box two screens earlier would be a second owner of the one fact this app is
   * forbidden to store twice.
   */
  protected readonly engineNeedsAccount = computed(
    () => this.engineActs().some((act) => !act.enabled && act.routable));

  /**
   * And what Foundry has already said to each of them, by stored name.
   *
   * The same map the Servers card draws, from the same push, so the wizard and
   * Settings cannot tell one person two stories about one machine. Loaded AND
   * listened to: coordination starts at app start, before this wizard exists,
   * so a step that only listened would draw nothing about a server that was
   * already `stocked` when it opened.
   */
  protected readonly coordination = signal<CrucibleCoordinationMap>({});


  /** Step ids moved past without doing the thing. A Set would not survive JSON. */
  protected readonly skipped = signal<string[]>([]);


  protected readonly up = computed(() => this.ui.setupOpen());
  /**
   * THE STEPS THIS RUN ACTUALLY HAS — the rail, the numbering and every walk.
   *
   * One step is conditional: `routes` needs a registered engine to draw a window
   * onto (crucible docs/PHASE15-HOST.md §5.2), so with an empty registry it is
   * not in the list at all. That is deliberately not the same as SKIPPING it —
   * a skipped step is one somebody was offered and moved past, and the Ready
   * screen names those out loud.
   *
   * IT CAN GROW MID-WIZARD, and that is right: registering a server on the
   * Crucible step is exactly what makes the question "where does translation
   * run" answerable, and the dot appearing is the wizard saying so. The registry
   * is read once when this screen opens, so a machine that already had a server
   * shows the dot from the first frame rather than discovering it three steps
   * in.
   */
  protected readonly visible = computed<readonly StepDef[]>(() => {
    const hasEngine = this.crucibleServers().length > 0;
    return STEPS.filter((step) => {
      return true;
    });
  });
  protected readonly index = computed(() => Math.max(0, this.indexOf(this.current())));
  protected readonly def = computed(() => this.visible()[this.index()] ?? STEPS[0]!);

  /**
   * Welcome and Ready are not skippable because there is nothing on them to
   * skip — a Skip button beside a paragraph is a button that means nothing, and
   * a step id in the skipped list that names a page of prose would make the
   * settings screen say something false.
   */
  protected readonly skippable = computed(() => {
    const here = this.current();
    return here !== 'welcome' && here !== 'done';
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (!api) return;
    // Startup discovery may finish after the wizard's first registry read.
    // Re-read the same source when main announces the registration.
    destroyRef.onDestroy(api.acts.onChanged(() => { void this.loadCrucible(); }));

    /*
     * COORDINATION IS NOT SOMETHING THIS SCREEN STARTS, so it is only heard.
     * The sweep runs at app start on every enabled server (crucible
     * docs/PHASE14-ENVPACKS.md §4a), and somebody standing on this step while a
     * model downloads onto the Mac should watch it move rather than find out by
     * pressing Next twice.
     */
    api.crucible.onCoordination((state) => {
      this.coordination.update((all) => ({ ...all, [state.server]: state }));
    });

    /*
     * ── OPENED ONCE, BY MAIN'S ANSWER, AND NEVER BY THE ABSENCE OF A FILE ────
     *
     * `setup:state` reads an explicit marker rather than testing whether
     * app-settings.json exists: that file is written the first time anybody
     * changes the library folder or adds an analysis category, so on the
     * machine where somebody poked at Settings before setup ever ran, "no
     * file" is already false and this screen would never appear.
     */
    /*
     * ASKED DIRECTLY, NOT READ OFF THE `hosted` SIGNAL. That signal is filled
     * in by a promise `core/foundry.ts` starts at module load, so in this
     * constructor it is still false on a hosted window — and losing that race
     * would open a five-step wizard inside BookForge asking for a library
     * folder somebody else owns. Both answers are awaited together, so the
     * decision is made when both are actually known.
     */
    void Promise.all([api.hosted(), api.setup.state()]).then(([inHost, state]) => {
      if (inHost || state.completed) return;
      /*
       * A STORED ID THIS BUILD NO LONGER HAS IS DROPPED, not carried.
       *
       * The Ready screen falls back to printing the raw id for a step it cannot
       * name, which is right for a typo and wrong for a step that was DELETED:
       * somebody who skipped "Python environments" before 2026-09-15 would be
       * told, in a later run, that they skipped "envs" — a word this app no
       * longer uses about a screen it no longer has. It is the same rule the
       * routes step is hidden by: a wizard must not say somebody skipped a step
       * that was never offered.
       */
      const known = new Set<string>(STEPS.map((step) => step.id));
      this.skipped.set(state.skipped.filter((id) => known.has(id)));
      /*
       * THE REGISTRY IS READ BEFORE THE FIRST FRAME, not when the Crucible step
       * is reached, because the rail is drawn from it: `visible()` hides the
       * routes step while there is no engine, and a machine that ALREADY has a
       * server registered would otherwise show a rail that grew a dot three
       * steps in for no reason a person could see.
       */
      void this.loadCrucible();
      this.ui.openSetup();
    });

    /*
     * ── THE STEP LIST CAN SHRINK NOW, SO STANDING ON ONE HAS TO BE CHECKED ──
     *
     * Until 2026-09-15 `visible()` could only GROW: the routes step appeared
     * when a server was registered and nothing ever took a step away. The page
     * reader step is hidden when a connected engine serves `pages`, and that
     * answer arrives from a network probe — so a step somebody is standing on
     * can stop existing under them.
     *
     * What that looked like without this: `indexOf` answers -1, `index()`
     * clamps it to 0, the heading and the rail say "Welcome" while `current()`
     * still says `reading` and the body draws the page reader. A card whose
     * title and contents disagree.
     *
     * FORWARD, not back. A step disappears here because it was ANSWERED — the
     * engine reads pages, so there is nothing to download — and sending
     * somebody backwards would re-ask them a question that has just been
     * settled.
     *
     * THE POSITION COMES FROM `STEPS`, NOT FROM `index()`. `index()` is
     * `max(0, indexOf(current))` and `indexOf` answers -1 for a step that is no
     * longer drawn, so reading the landing out of it puts everybody on Welcome
     * — which is the bug this effect exists to prevent, wearing a different
     * face. The full order is the one place a vanished step still has a
     * position, so the landing is the first VISIBLE step at or after it.
     */
    effect(() => {
      const steps = this.visible();
      const here = this.current();
      if (steps.some((step) => step.id === here)) return;
      const was = STEPS.findIndex((step) => step.id === here);
      const order = new Map(STEPS.map((step, at) => [step.id, at]));
      const landing = steps.find((step) => (order.get(step.id) ?? 0) >= was)
        ?? steps[steps.length - 1];
      if (landing !== undefined) this.current.set(landing.id);
    });

    // Each step loads only what it can read for free. Nothing here fetches.
    effect(() => {
      if (!this.up()) return;
      const here = this.current();
      if (here === 'library') void this.loadLibrary();
      if (here === 'crucible') void this.loadCrucible();
    });

  }

  // ── Reading what is free to read ───────────────────────────────────────────


  private async loadLibrary(): Promise<void> {
    if (!api) return;
    this.libraryDir.set(await api.library.dir());
  }

  /**
   * The registry, for the Crucible step's "already registered" line.
   *
   * Re-read after any of the three doors writes one, because the line is the
   * only feedback the step gives that an Add landed — the door itself closes and
   * says nothing more, on the standing rule that main's answer is the truth and
   * a component holding its own copy of a list is the copy that goes stale.
   */
  /*
   * ── `upgradeWsl` IS GONE, AND SO IS EVERYTHING IT DROVE ──────────────────
   *
   * It submitted an `engine/wsl` task to a native Windows engine's controller
   * and narrated the result into `wslSaid`. crucible PHASE19 §0 deletes the
   * offer entirely — the tray decides at every start whether this machine is
   * moving to the Linux engine and does it (§2.3), so an app that could also
   * ask would be the second owner of that decision. `app-crucible-install-
   * outcome` on the engine card is what replaced it: a readout of §2.2's
   * outcome, with §2.5's Try again on a refusal and nothing at all on a
   * machine that is done.
   *
   * The main-process half went with it in the same commit —
   * `foundry:crucible-wsl-upgrade`, its progress push, and
   * `electron/crucible-engine-upgrade.ts`.
   */

  protected async loadCrucible(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.crucibleServers.set(view.servers);
    this.crucibleHere.set((await api.crucible.localPresence()).state === 'present');
    this.coordination.set(await api.crucible.coordination());
    await this.loadEngineFacts();
  }

  /**
   * THE TWO FACTS THE ENGINE STEP SHOWS WHEN THERE IS AN ENGINE — the card, and
   * what it can do with it.
   *
   * Owen, 2026-09-15, opening this wizard on a machine already running one:
   * *"since crucible is already set up on our machine, it should just connect to
   * the server and then show what gpu is registered with the existing crucible
   * server… things the user might need to know about crucible setup: the GPU
   * it's connected to and how powerful it is, the functions that will be
   * available and the functions that wont be available because it isnt powerful
   * enough, what might need an API key to run."*
   *
   * ── BOTH READS ARE THE ONES THAT ALREADY EXIST ───────────────────────────
   *
   * `crucible:test` is `info()` — the server's name, its version, its backend
   * and THE CARD IN ITS OWN WORDS — and `crucible:engine-capability` is
   * `readCapability`, the dispatcher's own reader, which is what the routes step
   * one screen along already draws from. Neither places a job, neither loads a
   * model, and no third door was added for this: a second way to ask an engine
   * what it is would be a second answer to drift from the first.
   *
   * ── A FAILURE IS NOT A BLANK ─────────────────────────────────────────────
   *
   * Both are set together and cleared together, for the reason `loadRoutes`
   * gives about its own pair: a card kept beside a capability record that failed
   * to read would let this step print "this engine can do everything" from an
   * EMPTY list of refusals, which is the sentence "nothing was measured" said as
   * though it were good news. When they clear, the step falls back to the doors,
   * which is the honest face for an engine that will not answer.
   */
  private async loadEngineFacts(): Promise<void> {
    if (!api) return;
    const server = defaultEngineServer(this.crucibleServers());
    if (server === null) {
      this.engineProbe.set(null);
      this.engineCap.set(null);
      return;
    }
    this.engineAsking.set(true);
    try {
      const [probe, capability] = await Promise.all([
        api.crucible.test(server.name),
        api.crucible.engineCapability(server.name),
      ]);
      this.engineProbe.set(probe.outcome === 'ok' ? probe : null);
      this.engineCap.set(probe.outcome === 'ok' ? capability : null);
    } catch {
      /*
       * SWALLOWED, and the step draws the doors instead. Every reason this can
       * throw — the engine is asleep, the token was rotated, the machine is off
       * the network — is already said out loud one screen along in Settings ›
       * Servers, which has a Test button and prints the SDK's own sentence. A
       * wizard that stopped on an exception here would be a wizard somebody
       * cannot get past because a laptop in another room is shut.
       */
      this.engineProbe.set(null);
      this.engineCap.set(null);
    } finally {
      this.engineAsking.set(false);
    }
  }

  // ── Where the text work runs (PHASE15-HOST.md §5.2) ───────────────────────

  /*
   * ── THE ROUTES STEP AND ITS FIVE MEMBERS ARE GONE (2026-09-17) ─────────
   *
   * `loadRoutes`, `applyRoutes`, `routeLine`, `classLabel` and the four
   * signals they drove. The step asked a first-run user to decide where each
   * text class runs -- and opened by offering to "choose its own models",
   * which it had no control for.
   *
   * Settings > AI answers the same question and answers it better: one row
   * per job, the chosen model stated rather than offered, and accounts at the
   * foot. Two screens teaching different vocabularies for one document is the
   * thing that made this one worth deleting rather than fixing, and the one a
   * person meets on their first five minutes is the wrong place to teach the
   * worse vocabulary.
   *
   * WHAT IT WAS FOR IS STILL REACHABLE and now sits on the engine step: a
   * card that cannot run a class says so there, in the engine's own words,
   * and points at Settings.
   */


  /** The registered servers, named, for the one line the step prints about them. */
  protected crucibleNames(): string {
    return this.crucibleServers().map((server) => server.name).join(', ');
  }

  /**
   * One engine's coordination sentence, or null when nothing has asked it yet.
   *
   * EVERY WORD OF IT IS `core/crucible-words.ts`'s — the same function the
   * Servers card calls, because main sends facts and the copy has one owner
   * (crucible ARCHITECTURE.md R1).
   */
  protected coordinationOf(name: string): string | null {
    const state = this.coordination()[name];
    return state === undefined ? null : coordinationWords(state);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  protected indexOf(id: StepId): number {
    return this.visible().findIndex((step) => step.id === id);
  }

  protected next(): void {
    const at = this.index();
    const nextStep = this.visible()[at + 1];
    if (nextStep) this.current.set(nextStep.id);
  }

  protected back(): void {
    const previous = this.visible()[this.index() - 1];
    if (previous) this.current.set(previous.id);
  }

  protected skip(): void {
    const here = this.current();
    this.skipped.update((all) => (all.includes(here) ? all : [...all, here]));
    this.next();
  }

  protected skippedTitles(): string {
    const names = this.skipped()
      .map((id) => STEPS.find((step) => step.id === id)?.title ?? id);
    return names.join(', ');
  }

  /**
   * Leaving by the ✕ is a completed setup, not an abandoned one.
   *
   * Every step past this one is recorded as skipped, because that is what
   * happened — and the settings screen naming them is the whole reason the list
   * is kept. Coming back is one button there.
   */
  protected readonly finishing = signal(false);
  protected readonly finishError = signal('');

  protected async dismiss(): Promise<void> {
    if (this.finishing()) return;
    const from = this.index();
    const rest = this.visible().slice(from)
      .filter((step) => step.id !== 'welcome' && step.id !== 'done')
      .map((step) => step.id);
    const all = [...new Set([...this.skipped(), ...rest])];
    this.skipped.set(all);
    await this.close(all);
  }

  protected async finish(): Promise<void> {
    if (this.finishing()) return;
    this.finishing.set(true);
    this.finishError.set('');
    try { await this.close(this.skipped(), true); }
    catch (error) { this.finishError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.finishing.set(false); }
  }

  private async close(skipped: string[], prepare = false): Promise<void> {
    /*
     * IT USED TO MARK `routes` SKIPPED when that step's document had never been
     * read — a step somebody walked past without answering. There is no routes
     * step (2026-09-17), so there is nothing to record about it, and adding a
     * skipped-step id for a step that does not exist would put a line in
     * Settings saying somebody skipped something they were never offered.
     */
    await api?.setup.finish(skipped, prepare);
    this.ui.closeSetup();
  }

  // ── Library ───────────────────────────────────────────────────────────────

  protected async pickLibrary(): Promise<void> {
    if (!api) return;
    const chosen = await api.library.choose(this.libraryDir());
    if (chosen === null) return;
    // Main's value wins: it clamps, and a renderer holding an optimistic copy
    // would show a folder nothing writes to.
    this.libraryDir.set(await api.library.set(chosen));
  }

  /*
   * ── THE PAGE READER METHODS WENT WITH THE STEP (2026-09-17) ────────────
   *
   * `loadReader`, `getReader`, `cancelReader` and `readerSize` drove a
   * download of dots.ocr onto this machine. Owen: *"there sohuldnt be a local
   * system. foundry does all ai work through crucible."* Reading a page wants
   * a GPU, so it is the engine's, and there is nothing here to fetch.
   */
}
