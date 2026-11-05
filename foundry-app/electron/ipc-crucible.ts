/**
 * ipc-crucible — the server registry, connecting, and an engine's settings and models.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { openCrucibleUi } from './crucible-ui';
import { crucibleSettingsView, probeCrucible, probeCrucibleAt } from '@owen/foundry-core/node/crucible-registry';
import { readCapability } from '@owen/foundry-core/node/crucible-dispatch';
import { readEngineSettings, testUpstream } from '@owen/foundry-core/node/crucible-settings';
import { jobModelOffer, rememberJobModel } from '@owen/foundry-core/node/crucible-models';
import type { JobModelKind } from '@owen/foundry-core/shared/job-models';
import type { SettingsDocument, SettingsPatch, UpstreamName, UpstreamProbe } from '@owen/foundry-core/shared/engine-settings';
import { crucibleInstallPlan } from '@owen/foundry-core/node/crucible-install';
import { anyServerServing } from '@owen/foundry-core/node/crucible-provider';
import { type ConnectCodePreview, type CrucibleProbe, type CrucibleServerEdit } from '@owen/foundry-core/shared/slots';
import { namedServerOr, adoptPairingFile, saveCrucibleServers, addCrucibleServerDoor, addLocalCrucibleDoor, parseConnectCode, testConnectCode, addConnectCode, putEngineSettings } from '@owen/foundry-core/node/doors-crucible';
import type { ModelClass } from '@owen/foundry-core/shared/types';

export function registerCrucibleDoors(): void {
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
   * Ollama is not probed any more either: `node/ollama.ts`, whose one reader
   * (the disk inventory) had already gone, retired 2026-11-04 with every way
   * Foundry had of probing a model server of its own.
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
  ipcMain.handle('crucible:save', (_event, servers: CrucibleServerEdit[]) => saveCrucibleServers(servers));
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
  ipcMain.handle('crucible:add', (_event, name: string, url: string, token: string) =>
    addCrucibleServerDoor(name, url, token));
  ipcMain.handle('crucible:add-local', (_event, name: string) => addLocalCrucibleDoor(name));
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
  ipcMain.handle('crucible:parse-connect-code', (_event, line: string): ConnectCodePreview => parseConnectCode(line));
  ipcMain.handle('crucible:test-connect-code', (_event, line: string): Promise<CrucibleProbe> =>
    testConnectCode(line));
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
  ipcMain.handle('crucible:add-connect-code', (_event, line: string, name: string) => addConnectCode(line, name));

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
  ipcMain.handle('crucible:engine-settings-put', (
    _event,
    serverName: string,
    patch: SettingsPatch,
  ): Promise<SettingsDocument> => putEngineSettings(serverName, patch));
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
   * WHAT A JOB'S MODEL DROPDOWN OFFERS, AND WHICH ROW IT OPENS ON (Owen,
   * 2026-10-25: *"put the option the user can pick in a dropdown on the modal
   * that configures the job"*). A LIVE READ of one server — its `models()` and
   * its upstream accounts' lists — because the dropdown is a person about to
   * choose, and the cached capability mirror `crucible:serves` reads holds
   * neither list. `server` is the dialog's pinned engine, or null for the
   * top-ranked one (`jobModelOffer`, electron/crucible-models.ts, says why).
   * A server that cannot be asked REJECTS with its own sentence.
   */
  ipcMain.handle('crucible:job-models', (_event, kind: JobModelKind, server: string | null) =>
    jobModelOffer(kind, server));
  /** The dialog's choice, remembered after its enqueue succeeded — `''` (Automatic) too. */
  ipcMain.handle('crucible:remember-job-model', (_event, kind: JobModelKind, value: string, server?: string) => {
    rememberJobModel(kind, value, typeof server === 'string' ? server : undefined);
  });

  /**
   * THE PROGRESS LIST FOR "INSTALL CRUCIBLE HERE", composed for this machine.
   *
   * A READ, and it changes nothing. It is no longer a sequence for a person to
   * perform: PHASE19 §3.1 makes it the rows the install fills in while it runs,
   * and §0 removed the one command that used to sit under the first of them.
   */
  ipcMain.handle('crucible:install-plan', () => crucibleInstallPlan());
}
