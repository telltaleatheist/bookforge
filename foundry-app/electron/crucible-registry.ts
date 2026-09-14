/**
 * THE SERVER REGISTRY, AND THE SLOT LIST DERIVED FROM IT.
 *
 * docs/SLOTS.md §3 and §6 (Package C). This module owns three things and
 * deliberately no more:
 *
 *   1. the registered Crucible servers, read out of and written into the app's
 *      own settings file, in priority order;
 *   2. `computeSlots()` — the list a picker draws and the `any` walk walks;
 *   3. the two acts that TALK to a server for a settings row: Test connection,
 *      and reading the local server's own config so an entry can be made from
 *      it without anybody copying a token by hand.
 *
 * WHAT IS NOT HERE IS THE DISPATCH. Deciding which slot a job goes to, reading
 * a capability record, making a model resident and composing the spawn is
 * `crucible-dispatch.ts` — a different question with a different shape of
 * answer. This module reads and writes; that one acts, and every act of its is
 * on a row somebody is watching.
 *
 * ── The token, and the one rule it has ──────────────────────────────────────
 *
 * It never leaves this process. It is read here, held in the settings file, and
 * handed to the SDK or to a spawn's `env`. It is not on a command line (a
 * command line is spelled into the terminal by `job-queue.ts`, pasted into bug
 * reports, and listed by the process table), it is not in an IPC payload (the
 * renderer's shape is `CrucibleServerView`, which has a boolean where this has a
 * secret), and it is in no log line, including the ones that report a failure
 * involving it.
 *
 * ── Why the word "crucible" is in this filename ─────────────────────────────
 *
 * Because it is allowed to be: the engine (`src/`) must never name a product —
 * it speaks an OpenAI dialect to whatever is on the other end and cannot tell
 * one server from another — but the APP is the operator, and an operator that
 * loads a model, reads a capability record and renders a 409 by its code is
 * talking to a Crucible specifically. Pretending otherwise here would mean a
 * module full of sentences about "the server" that only one server can answer.
 */
import { spawn } from 'node:child_process';

import {
  CrucibleAuthError,
  CrucibleClient,
  CrucibleNotACrucible,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';

import {
  readAppSettings,
  writeAppSettings,
  clampCrucibleUrl,
  CRUCIBLE_SERVER_MAX,
  type CrucibleServerEntry,
} from './app-settings';
import { cloudProviderViews, enabledCloudProviders } from './cloud-providers';
import { foundryHost, hosted } from './host';
import {
  ANY_SLOT,
  LOCAL_SLOT_NAME,
  isLoopbackUrl,
  type CloudSettingsView,
  type ComputeSlot,
  type CrucibleProbe,
  type CrucibleServerEdit,
  type CrucibleServerView,
  type CrucibleSettingsView,
  type LocalCrucibleAdd,
  type LocalCrucibleFailure,
} from '../shared/slots';

/**
 * WHAT THE SERVER LOGS AS THE HOLDER OF OUR JOBS — and it must be this word.
 *
 * The SDK puts it in `User-Agent`, and that is what a Crucible reports back to
 * the NEXT client that finds the lane taken: `CrucibleBusy.holder`. So this
 * string is what BookForge's queue will print when Foundry is in the way, and
 * what this app will print when BookForge is. A clientName invented per call
 * site would make one machine look like two apps.
 */
export const CRUCIBLE_CLIENT_NAME = 'foundry';

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/** Every registered server, in priority order. The stored shape, token and all. */
export function crucibleServers(): CrucibleServerEntry[] {
  return readAppSettings().crucibleServers;
}

/** One entry by name, or null. Case-insensitive, because the picker is. */
export function crucibleServerNamed(name: string): CrucibleServerEntry | null {
  const key = name.trim().toLowerCase();
  return crucibleServers().find((entry) => entry.name.toLowerCase() === key) ?? null;
}

/** The registry as the renderer is allowed to see it. */
export function crucibleServerViews(): CrucibleServerView[] {
  return crucibleServers().map(viewOf);
}

function viewOf(entry: CrucibleServerEntry): CrucibleServerView {
  return {
    name: entry.name,
    url: entry.url,
    enabled: entry.enabled,
    tokenSet: entry.token.length > 0,
    loopback: isLoopbackUrl(entry.url),
  };
}

/**
 * REPLACE THE WHOLE REGISTRY — add, remove, rename, reorder and enable, all at
 * once, in one door.
 *
 * ── Why one door and not five ───────────────────────────────────────────────
 *
 * Because four of the five are the same operation on an ordered array, and the
 * fifth (reorder) IS the array. A `crucible:reorder` that moved an index while
 * `crucible:rename` changed a name would be two writers of one list, and a drag
 * that landed between them would write one of the two changes. The card holds
 * the list it is editing and sends it whole; the last write wins, which is what
 * a settings card means.
 *
 * ── The token is carried by its ABSENCE ─────────────────────────────────────
 *
 * `token: null` on an incoming entry means "keep what is stored", and it is what
 * the card sends for every row nobody retyped — because the card has never been
 * told the token and so cannot send it back. The match is by NAME against the
 * stored list, which is why a rename and a new token in the same gesture is the
 * one case the card must send a token for: the old name is gone and there is
 * nothing to carry forward from. It is refused by name rather than silently
 * dropping the server.
 */
export function writeCrucibleServers(edits: readonly CrucibleServerEdit[]): CrucibleServerView[] {
  refuseHostedRegistryChange();
  const stored = new Map(crucibleServers().map((entry) => [entry.name.toLowerCase(), entry]));
  /*
   * THE OTHER REGISTRY'S NAMES, read here for the reason `writeCloudProviders`
   * reads this one: two arrays with two clamps cannot see each other, and a slot
   * list with two rows called one thing is a row nobody can choose between. The
   * refusal is by name rather than a silent drop, because somebody who typed a
   * name meant something by it and deserves to be told what already has it.
   */
  const cloud = new Set(
    readAppSettings().cloudProviders.map((entry) => entry.name.toLowerCase()),
  );
  const next: CrucibleServerEntry[] = [];
  for (const edit of edits.slice(0, CRUCIBLE_SERVER_MAX)) {
    const name = typeof edit.name === 'string' ? edit.name.replace(/\s+/g, ' ').trim() : '';
    const url = clampCrucibleUrl(edit.url);
    if (name.length === 0) throw new Error('A server needs a name — it is what a queue row waits for.');
    if (cloud.has(name.toLowerCase())) {
      throw new Error(
        `"${name}" is already the name of a cloud provider. Two slots with one name is a row `
        + 'nobody can choose between — give this one a different name.',
      );
    }
    if (url === null) {
      throw new Error(
        `"${name}" needs an address like http://192.168.1.20:7100 — the server's base URL, `
        + 'without /v1 on the end.',
      );
    }
    const carried = stored.get(name.toLowerCase());
    const token = typeof edit.token === 'string' && edit.token.trim().length > 0
      ? edit.token.trim()
      : carried?.token ?? '';
    if (token.length === 0) {
      throw new Error(
        `"${name}" needs a token. A Crucible has no anonymous mode — run \`crucible token --show\` `
        + 'on that machine and paste what it prints.',
      );
    }
    next.push({ name, url, token, enabled: edit.enabled !== false });
  }
  /*
   * THE CLAMP IS THE SECOND READER AND THE LAST WORD. Everything above refuses
   * by name so the card can say what to fix; `clampCrucibleServers` (inside
   * `writeAppSettings`) drops what it cannot store — a duplicate name, a
   * reserved one — and the answer is read back OUT of the file rather than
   * returned from this array, on this app's standing rule that a settings door
   * answers with what was stored and never with what was sent.
   */
  writeAppSettings({ crucibleServers: next });
  return crucibleServerViews();
}

/**
 * ADD ONE SERVER, for a caller that is not editing the list.
 *
 * The Servers card sends the whole registry because it holds the whole registry;
 * the setup wizard holds three text boxes and has never seen the list, and
 * making it read one in order to append to it would be a second reader of the
 * order with a window between the read and the write. So this reads, appends and
 * hands the result to {@link writeCrucibleServers} — THE SAME ONE WRITER, with
 * every refusal it makes, rather than a second path into the settings file.
 *
 * AN EXISTING NAME IS REPLACED IN PLACE, keeping its position and its enabled
 * state, which is `addLocalCrucible`'s rule for the same reason: somebody
 * re-adding a server they already have is fixing its token, and a second entry
 * beside the first would leave the stale one in the picker.
 */
export function addCrucibleServer(name: string, url: string, token: string): CrucibleServerView[] {
  const label = name.replace(/\s+/g, ' ').trim();
  const kept = crucibleServers()
    .filter((entry) => entry.name.toLowerCase() !== label.toLowerCase())
    .map((entry): CrucibleServerEdit => ({
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      // Null, so the stored token is carried forward — this function has no
      // business handling the tokens of servers it was not asked about.
      token: null,
    }));
  return writeCrucibleServers([...kept, { name: label, url, enabled: true, token }]);
}

/**
 * HOSTED, THE REGISTRY IS SOMEBODY ELSE'S — `library:set`'s refusal, for the
 * same reason (docs/SLOTS.md §3: *"The vendored (BookForge-hosted) app takes its
 * slot list from the host"*).
 *
 * A refusal rather than a hidden card: the card IS hidden hosted, and this is
 * the door behind it. Something that can be reached by an IPC message must
 * refuse at the door as well, or the hiding is a decoration.
 */
function refuseHostedRegistryChange(): void {
  if (!hosted()) return;
  throw new Error(
    'The servers are the host application\'s while Foundry is running inside it. '
    + 'Change them there.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The slots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHERE A JOB'S COMPUTE CAN GO, in priority order.
 *
 * ── The local slot, and the one thing that removes it ──────────────────────
 *
 * The machine's own GPU is first and is what a person with no Crucible sees —
 * one slot, no picker, nothing to learn. It disappears for exactly one reason:
 * an ENABLED entry whose URL is loopback. Owen: *"if theyre using crucible on
 * their local machine, the local GPU disappears."* One card, one owner — a local
 * Crucible and an Ollama on one box would be two slots pointing at one GPU, and
 * the board would cheerfully start a job in each.
 *
 * WHAT "DISAPPEARS" MEANS IS TEXT ACTS, and the line is worth stating because
 * reading is the other expensive thing this app does. Page reading stays on its
 * own local path until a Crucible `pages` slot is wired (see `CRUCIBLE_READS` in
 * crucible-dispatch.ts, and Package B, which owns that reader). So a loopback
 * Crucible takes the translate/simplify/clean/analyse work off Ollama and leaves
 * the reader where it is; nothing about that is hidden from the person, because
 * the reader has a settings row of its own.
 *
 * ── THE CLOUD SLOTS COME LAST, AND THE ORDER IS THE WHOLE STATEMENT ────────
 *
 * One per ENABLED cloud provider (docs/SLOTS.md §3, Package F), after every
 * Crucible. The position matters because this list is what `any` walks in rank
 * order — and `any` STEPS PAST a cloud slot by kind rather than taking it
 * (`placeJob`, crucible-dispatch.ts), so putting them last means the walk has
 * already tried every machine that costs nothing before it reaches the ones that
 * cost money and declines them. A person who wants one says so on the row.
 *
 * A DUPLICATE NAME IS DROPPED HERE AS THE LAST WORD. Both writers refuse a name
 * the other list already has, so this cannot happen through the cards; a
 * hand-edited settings file can still produce it, and a picker with two rows
 * called one thing is a row nobody can choose between. The CRUCIBLE keeps the
 * name, because it was in the list first when this feature landed and because a
 * dropped cloud slot costs nothing but a slot nobody picked.
 *
 * ── Hosted, this list is the host's whole answer ───────────────────────────
 *
 * Including the emptiness of it. A host that registers no `slots` provider gets
 * an empty list, and an empty list is not a broken app: the dispatcher reads it
 * as "no placement to decide" and every job takes the path it took before this
 * feature existed. That is what makes this additive for BookForge until they
 * choose to supply one. A host that offers no cloud slot therefore has none —
 * this app's own `cloudProviders` are not merged into a host's list, because the
 * work in a hosted window runs on the host's compute and its bill is the host's.
 */
export function computeSlots(): ComputeSlot[] {
  if (hosted()) return hostSlots();
  const servers = crucibleServers().filter((entry) => entry.enabled);
  const local: ComputeSlot[] = servers.some((entry) => isLoopbackUrl(entry.url))
    ? []
    : [{ name: LOCAL_SLOT_NAME, kind: 'local' }];
  const out: ComputeSlot[] = [
    ...local,
    ...servers.map((entry): ComputeSlot => ({ name: entry.name, kind: 'crucible', url: entry.url })),
  ];
  const taken = new Set(out.map((slot) => slot.name.toLowerCase()));
  for (const provider of enabledCloudProviders()) {
    if (taken.has(provider.name.toLowerCase())) continue;
    taken.add(provider.name.toLowerCase());
    /*
     * NO `url` ON A CLOUD SLOT, deliberately, and `ComputeSlot.url` carries the
     * whole argument: `localLane` reads that field to decide which lane is this
     * machine's own card, and an OpenAI-compatible endpoint at localhost would
     * be adopted as the local lane. The address is on the provider entry, which
     * is what the placement composes `--endpoint` from.
     */
    out.push({ name: provider.name, kind: 'cloud' });
  }
  return out;
}

/**
 * The host's slot list, cleaned.
 *
 * A HOST'S MISTAKE MUST NOT STRAND A JOB, so this reads defensively where the
 * rest of the module reads the settings file it wrote itself: a throw is caught
 * and logged as an empty list (every job takes the local path, which is what a
 * host with no provider gets), and a row that is not a slot is dropped. What it
 * refuses outright is a `local` slot from a host — SLOTS.md §3 says the vendored
 * app *"shows no local slot"*, and a host that sent one would be offering this
 * window a GPU the host's own queue is already rationing.
 */
function hostSlots(): ComputeSlot[] {
  const provider = foundryHost()?.slots;
  if (provider === undefined) return [];
  let offered: readonly ComputeSlot[];
  try {
    offered = provider.call(foundryHost()) ?? [];
  } catch (err) {
    console.error(
      `[slots] the host's slot provider threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const seen = new Set<string>();
  const out: ComputeSlot[] = [];
  for (const slot of offered) {
    if (typeof slot !== 'object' || slot === null) continue;
    const name = typeof slot.name === 'string' ? slot.name.trim() : '';
    if (name.length === 0 || seen.has(name.toLowerCase())) continue;
    if (slot.kind !== 'crucible' && slot.kind !== 'cloud') continue;
    const url = typeof slot.url === 'string' ? slot.url : undefined;
    seen.add(name.toLowerCase());
    out.push(url === undefined ? { name, kind: slot.kind } : { name, kind: slot.kind, url });
  }
  return out;
}

/**
 * WHAT A NEW ROW SHOULD WAIT FOR — resolved at the press, never at the spawn.
 *
 * `top` becomes the NAME of the top-ranked enabled slot, because docs/SLOTS.md
 * §3 rules that *"queued rows do NOT move when servers are re-ranked"* and a row
 * carrying the word "top" would move. `any` stays the reserved word, which is
 * the one answer that genuinely means "decide later".
 *
 * UNDEFINED WHEN THERE IS NOTHING TO DECIDE — no slots at all (hosted with no
 * provider), or exactly one. A row with no `waitFor` is every row this queue has
 * ever held, and it takes the local path; writing a name onto it would put a
 * fact on the wire that the picker is not even drawn to show.
 *
 * AND `top` IS THE TOP NON-CLOUD SLOT (docs/SLOTS.md §3: a cloud provider is *"a
 * deliberate per-job choice, never something `any` falls through to"*). The
 * ordering in `computeSlots` already puts every cloud slot last, so the filter
 * changes nothing today — it is here so that a later reordering cannot make a
 * standing preference start billing somebody by default. The same sentence in
 * two places is the point: `any` steps past them in the walk, and `top` cannot
 * name one here.
 */
export function waitForOfNewJob(): string | undefined {
  const slots = computeSlots();
  if (slots.length < 2) return undefined;
  if (readAppSettings().newJobsWaitFor === ANY_SLOT) return ANY_SLOT;
  return slots.find((slot) => slot.kind !== 'cloud')?.name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Talking to one, for a settings row
// ─────────────────────────────────────────────────────────────────────────────

/** A client for one entry. The only place a token meets the SDK. */
export function clientFor(entry: CrucibleServerEntry): CrucibleClient {
  return new CrucibleClient({
    url: entry.url,
    token: entry.token,
    clientName: CRUCIBLE_CLIENT_NAME,
  });
}

/**
 * TEST CONNECTION — `info()`, which is authenticated, so one call answers both
 * "is there a Crucible there" and "is this the right token".
 *
 * Every failure keeps the SDK's own sentence. They already name what to fix
 * ("crucible at http://… is unreachable: …", "crucible refused the token") and a
 * word of ours in place of one of those is how a fixable problem becomes an
 * unfixable one. The types are named in the catch anyway — not to reword them,
 * but so that a throw this module has NOT anticipated is visibly a different
 * branch rather than something that quietly wore the same sentence.
 */
export async function probeCrucible(name: string): Promise<CrucibleProbe> {
  const entry = crucibleServerNamed(name);
  if (entry === null) return { outcome: 'failed', message: `There is no server called "${name}".` };
  return probeEntry(entry);
}

/**
 * TEST AN ADDRESS AND A TOKEN THAT ARE NOT IN THE REGISTRY YET.
 *
 * The setup wizard's "Connect to a Crucible server" door (docs/SETUP.md, Wave 61
 * package E) has a URL box, a token box and a Test button, and none of those
 * three has been saved when the button is pressed. Testing after adding would be
 * this app writing a server into somebody's settings in order to find out
 * whether it is a server.
 *
 * IT IS THE SAME PROBE, through the same client and the same error handling —
 * the only difference is where the two fields came from. A second probe with its
 * own error branches is how one surface starts reporting "unreachable" where the
 * other reports the SDK's sentence about a refused token.
 *
 * THE TOKEN IS NOT STORED BY THIS CALL and is not logged by it. It arrives over
 * IPC from a box the person is typing in, is used for one request, and is
 * dropped; only a later `crucible:save` writes it anywhere.
 */
export async function probeCrucibleAt(url: string, token: string): Promise<CrucibleProbe> {
  const clamped = clampCrucibleUrl(url);
  if (clamped === null) {
    return {
      outcome: 'failed',
      message: 'That needs to be an address like http://192.168.1.20:7100 — the server\'s base URL, '
        + 'without /v1 on the end.',
    };
  }
  if (token.trim().length === 0) {
    return {
      outcome: 'failed',
      message: 'A Crucible has no anonymous mode. Run `crucible token --show` on that machine and '
        + 'paste what it prints.',
    };
  }
  return probeEntry({ name: clamped, url: clamped, token: token.trim(), enabled: true });
}

/** The probe itself. Both doors above are this function plus a way of naming the server. */
async function probeEntry(entry: CrucibleServerEntry): Promise<CrucibleProbe> {
  try {
    const info = await clientFor(entry).info();
    return {
      outcome: 'ok',
      serverName: info.server.name,
      version: info.server.version,
      backend: info.host.backend,
      gpu: `${info.host.gpu.vendor} ${info.host.gpu.name}`.trim(),
    };
  } catch (err) {
    if (
      err instanceof CrucibleUnreachable
      || err instanceof CrucibleNotACrucible
      || err instanceof CrucibleAuthError
      || err instanceof CrucibleVersionError
    ) {
      return { outcome: 'failed', message: err.message };
    }
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The local server, read from its own config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADD THE CRUCIBLE ON THIS MACHINE, by reading the file that server itself
 * reads.
 *
 * ── Why this is not "type in localhost and paste a token" ──────────────────
 *
 * Because the token would immediately be a second copy of a fact with an owner.
 * `crucible init --force` mints a new one, the copy goes stale, and the first
 * symptom is a 401 that nothing explains. BookForge reached this the hard way
 * and the rule it landed on is the one mirrored here: the local server's single
 * owner is `<CRUCIBLE_HOME>/config.toml` — `[server] host/port` and `[auth]
 * token` — and the way to register it is to read that file. Pressing the button
 * again after a re-init is how a stale entry is fixed, and it is one press.
 *
 * ── On Windows the file is inside WSL ──────────────────────────────────────
 *
 * Windows is never a Crucible backend, so the local server lives in a WSL2
 * guest and the file is read through `wsl.exe -d <distro> --exec bash -c`.
 * `--exec` and not the implicit shell: the implicit form pre-expands `$VAR` on
 * the WINDOWS side, so `$HOME` would resolve to the Windows profile and the
 * command would look in a directory that does not exist inside the guest. The
 * distro comes from this app's own `wslDistro` setting and there is NO DEFAULT:
 * "the default distro" is whatever `wsl --set-default` last said, and a token
 * read out of the wrong guest is a wrong token.
 */
export async function addLocalCrucible(name: string): Promise<LocalCrucibleAdd> {
  refuseHostedRegistryChange();
  let read: LocalConfig;
  try {
    read = await readLocalConfig();
  } catch (err) {
    const failure = err instanceof LocalCrucibleError
      ? err
      : new LocalCrucibleError('wsl_read_failed', err instanceof Error ? err.message : String(err));
    return { outcome: 'failed', code: failure.code, message: failure.message };
  }
  const wanted = name.replace(/\s+/g, ' ').trim();
  const label = wanted.length > 0 ? wanted : read.serverName;
  const existing = crucibleServers();
  const clash = existing.find((entry) => entry.url === read.url && entry.name !== label);
  if (clash !== undefined) {
    return {
      outcome: 'failed',
      code: 'already_registered',
      message: `${read.url} is already registered as "${clash.name}". Rename or remove that entry first.`,
    };
  }
  /*
   * A REPLACE RATHER THAN A SECOND ENTRY when the name is already taken, and it
   * is the whole reason pressing the button twice is the fix for a stale token:
   * the second press overwrites the first entry's token with whatever the file
   * says now, in place, keeping its position in the ranking and its enabled
   * state. A new entry would leave the stale one beside it in the picker.
   */
  const kept = existing.filter((entry) => entry.name.toLowerCase() !== label.toLowerCase());
  const wasEnabled = existing.find((entry) => entry.name.toLowerCase() === label.toLowerCase())?.enabled;
  const entry: CrucibleServerEntry = {
    name: label,
    url: read.url,
    token: read.token,
    enabled: wasEnabled ?? true,
  };
  writeAppSettings({ crucibleServers: [...kept, entry] });
  return {
    outcome: 'added',
    servers: crucibleServerViews(),
    serverName: read.serverName,
    url: read.url,
    configPath: read.configPath,
  };
}

/** What the local `config.toml` said. The token is returned and never logged. */
interface LocalConfig {
  serverName: string;
  url: string;
  token: string;
  /** The path, as the reading side names it — `<distro>:/home/x/.crucible/…` under WSL. */
  configPath: string;
}

class LocalCrucibleError extends Error {
  readonly code: LocalCrucibleFailure;

  constructor(code: LocalCrucibleFailure, message: string) {
    super(message);
    this.name = 'LocalCrucibleError';
    this.code = code;
  }
}

/**
 * The guest-side command, as one string for `bash -c`.
 *
 * Exit 3 is "there is no config there", told apart from every other failure so
 * that "you have no local Crucible" — which is an ordinary and correct state for
 * a laptop that only ever renders on the Mac — does not arrive wearing the same
 * sentence as "wsl.exe would not run".
 *
 * `${CRUCIBLE_HOME:-$HOME/.crucible}` resolves exactly as the server's own
 * `crucible_home()` does, INSIDE the guest, which is the whole reason this is a
 * script and not a path composed on the Windows side.
 */
const LOCAL_CONFIG_SCRIPT =
  'p="${CRUCIBLE_HOME:-$HOME/.crucible}/config.toml"; '
  + 'if [ ! -f "$p" ]; then echo "$p" >&2; exit 3; fi; '
  + 'echo "$p"; cat "$p"';

async function readLocalConfig(): Promise<LocalConfig> {
  if (process.platform === 'win32') return readLocalConfigThroughWsl();
  /*
   * On macOS and Linux the file is simply on this filesystem, and it is read
   * with the same script through the login shell's own `sh`, so that
   * `$CRUCIBLE_HOME` is resolved by a shell rather than by this process's idea
   * of the environment — the server reads the variable the user's shell exports,
   * and an Electron app launched from the Dock does not inherit a login shell's
   * environment at all.
   */
  const result = await runCommand('/bin/sh', ['-c', LOCAL_CONFIG_SCRIPT]);
  return interpretLocalRead(result, null);
}

async function readLocalConfigThroughWsl(): Promise<LocalConfig> {
  const distro = readAppSettings().wslDistro;
  if (distro.length === 0) {
    throw new LocalCrucibleError(
      'no_wsl_distro',
      'The Crucible on a Windows machine runs inside WSL, and no WSL distro is set. '
      + 'Name the distro in this card first — there is deliberately no default, because a '
      + 'server read out of the wrong guest is a different server with a different token.',
    );
  }
  /*
   * `--exec` and not the implicit shell. The implicit form hands the command
   * line to a shell on the WINDOWS side first, which expands `$CRUCIBLE_HOME`
   * and `$HOME` against the Windows environment before the guest ever sees
   * them — so the script would look for a config in `C:\Users\…/.crucible`,
   * find nothing, and report "no local Crucible" on a machine that has one.
   */
  const result = await runCommand('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', LOCAL_CONFIG_SCRIPT]);
  return interpretLocalRead(result, distro);
}

function interpretLocalRead(result: CommandResult, distro: string | null): LocalConfig {
  const where = distro === null ? 'this machine' : `WSL distro "${distro}"`;
  if (result.failure !== null) {
    throw new LocalCrucibleError(
      'wsl_read_failed',
      `Reading the local Crucible's config on ${where} failed: ${result.failure}`,
    );
  }
  if (result.code === 3) {
    throw new LocalCrucibleError(
      'no_local_config',
      `There is no Crucible on ${where}: ${result.stderr.trim() || 'no config.toml'} does not exist. `
      + 'Install one with `crucible init` there, or add a remote server instead.',
    );
  }
  if (result.code !== 0) {
    throw new LocalCrucibleError(
      'wsl_read_failed',
      `Reading the local Crucible's config on ${where} exited ${result.code}: `
      + `${result.stderr.trim() || '(nothing on stderr)'}`,
    );
  }
  const newline = result.stdout.indexOf('\n');
  if (newline < 0) {
    throw new LocalCrucibleError(
      'wsl_read_failed',
      `Nothing usable came back from ${where} — the config path was not printed before the file.`,
    );
  }
  const configPath = result.stdout.slice(0, newline).trim();
  const named = distro === null ? configPath : `${distro}:${configPath}`;
  return parseLocalConfig(result.stdout.slice(newline + 1), named);
}

/**
 * `[server] name/host/port` and `[auth] token`, out of a config.toml.
 *
 * ── A minimal parser, and why it refuses instead of guessing ───────────────
 *
 * Neither Node nor bun ships a TOML parser and this app has no dependency that
 * does. Adding one for four keys would put a package in the bundle whose surface
 * is a hundred times the question being asked. So this reads the two tables it
 * needs and REFUSES EVERY LINE IT DOES NOT UNDERSTAND inside them — an array, a
 * multi-line string, an inline table, a dotted key. That is the important half:
 * a parser that skipped what it could not read would eventually skip the `token`
 * line and report "auth.token is missing" about a file that has it, which is a
 * worse failure than "this file has something in it I cannot read".
 *
 * Lines outside `[server]` and `[auth]` are SKIPPED rather than refused, because
 * the real file has `[jobs]`, `[accelerator]` and `[[capability.classes]]` in it
 * and none of them is any of this reader's business.
 */
export function parseLocalConfig(text: string, configPath: string): LocalConfig {
  let table: string | null = null;
  let name: string | null = null;
  let host: string | null = null;
  let port: number | null = null;
  let token: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = /^\[\[?([A-Za-z0-9_.-]+)\]?\]$/.exec(line);
    if (header !== null) {
      table = header[1] ?? null;
      continue;
    }
    if (table !== 'server' && table !== 'auth') continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (pair === null) {
      throw new LocalCrucibleError(
        'config_unreadable',
        `${configPath}, line ${index + 1}: this reader understands only "key = value" inside `
        + `[${table}], and that line is not one. Nothing was taken from the file.`,
      );
    }
    const key = pair[1] ?? '';
    const raw = pair[2] ?? '';
    if (table === 'server' && key === 'name') name = readTomlString(raw, configPath, index + 1);
    else if (table === 'server' && key === 'host') host = readTomlString(raw, configPath, index + 1);
    else if (table === 'server' && key === 'port') port = readTomlInteger(raw, configPath, index + 1);
    else if (table === 'auth' && key === 'token') token = readTomlString(raw, configPath, index + 1);
    /*
     * Any OTHER key in those two tables is skipped without complaint. The
     * refusal above is about a line whose SHAPE this reader cannot parse, not
     * about a key it has no use for — a `[server] workers = 4` added next year
     * must not stop somebody registering their own machine.
     */
  }
  if (host === null || port === null) {
    throw new LocalCrucibleError(
      'config_missing_key',
      `${configPath} has no [server] host/port. The server itself would refuse to start on it.`,
    );
  }
  if (token === null || token.length === 0) {
    throw new LocalCrucibleError(
      'config_missing_key',
      `${configPath} has no [auth] token. A Crucible has no anonymous mode — run \`crucible init\` there.`,
    );
  }
  /*
   * BIND ADDRESS → CONNECT ADDRESS, which is a mapping and not a fallback. A
   * server bound to `0.0.0.0` or `::` is listening on every interface, and the
   * interface a client on the same machine uses is loopback; the file records
   * only the first of those two facts. A specific bind address is used as
   * written, because that is a machine somebody configured deliberately.
   */
  const bind = host === '0.0.0.0' || host === '::' || host.length === 0 ? '127.0.0.1' : host;
  const authority = bind.includes(':') ? `[${bind}]` : bind;
  return {
    serverName: name ?? 'crucible',
    url: `http://${authority}:${port}`,
    token,
    configPath,
  };
}

function readTomlString(raw: string, configPath: string, line: number): string {
  const basic = /^"([^"\\]*)"$/.exec(raw);
  if (basic !== null) return basic[1] ?? '';
  const literal = /^'([^']*)'$/.exec(raw);
  if (literal !== null) return literal[1] ?? '';
  throw new LocalCrucibleError(
    'config_unreadable',
    `${configPath}, line ${line}: this reader understands only a plain quoted string here `
    + '(no escapes, no multi-line). Nothing was taken from the file.',
  );
}

function readTomlInteger(raw: string, configPath: string, line: number): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new LocalCrucibleError(
      'config_unreadable',
      `${configPath}, line ${line}: this reader understands only a plain integer here.`,
    );
  }
  return Number.parseInt(raw, 10);
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. Never both with a code. */
  failure: string | null;
}

/**
 * Run one command and collect what it said.
 *
 * ── The decode, which is the thing that makes this its own function ────────
 *
 * `wsl.exe` writes its OWN messages ("There is no distribution with the
 * supplied name") in UTF-16LE with a BOM, while everything the guest prints
 * comes through as UTF-8. So the two are interleaved on one pipe with two
 * encodings, and a `spawn(..., {encoding: 'utf8'})` turns the wsl.exe half into
 * a string of NUL-separated characters — which is how a legible refusal becomes
 * an unreadable one exactly when somebody needs to read it. Each chunk is
 * therefore decoded on its own, by the one thing that tells the two apart at a
 * glance: UTF-16LE ASCII has a NUL in every other byte.
 */
export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', failure: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, failure: 'it did not answer within 20 seconds' });
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += decodeChunk(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += decodeChunk(chunk); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, failure: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, failure: null }));
  });
}

/** One chunk, decoded as whichever of the two encodings it actually is. */
function decodeChunk(chunk: Buffer): string {
  if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
    return chunk.subarray(2).toString('utf16le');
  }
  /*
   * No BOM, so look at the bytes. Interleaved NULs in the first stretch of a
   * chunk mean UTF-16LE ASCII and mean nothing else: UTF-8 never contains a NUL
   * byte at all, so a single one is already conclusive and half of them is not a
   * judgement call.
   */
  const look = Math.min(chunk.length, 64);
  let nuls = 0;
  for (let index = 1; index < look; index += 2) if (chunk[index] === 0) nuls += 1;
  return nuls > 0 && nuls >= Math.floor(look / 4) ? chunk.toString('utf16le') : chunk.toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// The settings card's one read
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the Servers card draws, in one answer — see `CrucibleSettingsView`. */
export function crucibleSettingsView(): CrucibleSettingsView {
  const settings = readAppSettings();
  return {
    servers: crucibleServerViews(),
    slots: computeSlots(),
    newJobsWaitFor: settings.newJobsWaitFor,
    wslDistro: settings.wslDistro,
    hosted: hosted(),
  };
}

/**
 * And the Cloud providers card's one read — see `CloudSettingsView`.
 *
 * ── Why it is composed HERE and not in `cloud-providers.ts` ────────────────
 *
 * Because it carries the SLOT LIST, and `computeSlots` lives in this module.
 * Putting this function beside the providers would mean that module importing
 * this one while this one already imports it for the cloud slots — a cycle,
 * around a function whose whole job is to answer one question consistently. The
 * division stays what the two headers say: that module reads and writes the
 * providers, this one derives the slots, and the card's read is a slot question
 * with a list attached.
 */
export function cloudSettingsView(): CloudSettingsView {
  return {
    providers: cloudProviderViews(),
    slots: computeSlots(),
    hosted: hosted(),
  };
}
