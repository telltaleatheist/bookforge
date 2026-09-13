/**
 * crucible.js — the Crucible server registry and handshake, headless.
 *
 * Nothing here is reimplemented. The registry verbs call the SAME exported
 * functions the app will call when phase 2 gives them a settings row
 * (electron/crucible/servers.ts, COMPILED — dist/electron/crucible/servers.js),
 * and everything on the wire is `@crucible/client`, the SDK released beside the
 * server it speaks to. This file adds argument plumbing, a progress line on
 * stderr, and the refusal messages.
 *
 * WHAT CRUCIBLE IS. One inference server, many client apps: it runs models and
 * returns bytes, and never knows what an audiobook is. The spec is
 * C:\Users\tellt\Projects\crucible\docs\DESIGN.md. In phase 1 the only job type
 * was `echo`, which hands back the bytes it was given — which is exactly what
 * makes it a handshake: it proves the token, the API version, the queue, the
 * SSE stream, the artifact download and the provenance sidecar without loading
 * a model or touching a GPU.
 *
 * PHASE 2 adds the `llm` job type (crucible docs/PHASE2-LLM.md), and with it the
 * four OPERATOR verbs below. They exist because residency is a decision, not a
 * side effect: the server serves ONE model at a time, loading a second unloads
 * the first, and a cleanup run therefore never loads one itself. Somebody has to
 * say "put qwen3.5-9b on the Mac now" — that is --load, and it is a separate
 * command for the same reason `ollama pull` is.
 *
 * Requires BookForge to be BUILT (dist/electron present) but NOT running:
 *   npx tsc -p tsconfig.electron.json
 *
 * Usage:
 *   node cli/crucible.js --add --name <n> --url <u> (--token <t> | --token-file <path>)
 *   node cli/crucible.js --remove --name <n>
 *   node cli/crucible.js --list
 *   node cli/crucible.js --ping   --server <n>
 *   node cli/crucible.js --info   --server <n>
 *   node cli/crucible.js --health --server <n>
 *   node cli/crucible.js --echo   --server <n> --file <path> [--out <path>]
 *   node cli/crucible.js --models --server <n>
 *   node cli/crucible.js --load   --server <n> --model <id>
 *   node cli/crucible.js --unload --server <n> --model <id>
 *   node cli/crucible.js --chat   --server <n> --model <id> --prompt <text> [--stream] [--no-thinking]
 *   node cli/crucible.js --voices       --server <n>
 *   node cli/crucible.js --load-voice   --server <n> --voice <id>
 *   node cli/crucible.js --unload-voice --server <n> --voice <id>
 *   node cli/crucible.js --accelerator  --server <n>
 *   node cli/crucible.js --render --server <n> --voice <id> --language <c> --take <n>
 *                                 --text <path> --out <dir>
 *
 * PHASE 3 adds the `tts` job type and PHASE 4 the accelerator probe (crucible
 * docs/PHASE3-TTS.md, docs/PHASE4-AUDIO.md). The five verbs above are the same
 * shape as the four `llm` ones: a roster (--voices, beside --models), a
 * residency pair (--load-voice / --unload-voice, watched through events() as
 * --load is), a read (--accelerator), and one real job (--render, beside
 * --chat). The CLI is still the ONLY consumer — no UI, no IPC, no settings row.
 *
 * THREE NULLS THAT ARE NOT ZEROES, AND ARE PRINTED AS SUCH. This file says
 * `unknown` where the wire says `null`, because every one of these nulls means
 * "nobody would say" and printing a 0 or a `false` in its place would answer a
 * question that was never answered:
 *   - `holders[].bytes` — the driver declined a per-process figure (WDDM,
 *     permissions). A 0 here reads as "that process holds nothing", i.e. as an
 *     idle card, which is the one conclusion GET /v1/accelerator exists to stop.
 *   - `chunk.capped` — narrator does not put its frame cap on the wire, so the
 *     server publishes null rather than guessing. Printed as `false` it would
 *     call every runaway a long sentence, silently.
 *   - `chunk.tokens` — the same absence, for the same reason.
 * An EMPTY holders list is a fourth: under WSL2 the driver shim lists no
 * compute apps while a process inside that VM holds 17 GB, so --accelerator
 * says so in as many words and points at `unattributed`.
 *
 * THE TOKEN IS NEVER PRINTED. --list shows `****` and the last four characters,
 * which is enough to tell two tokens apart and not enough to use one. --add
 * takes --token-file for the same reason: a token pasted on a command line is a
 * token in the shell history.
 *
 * EVERY FAILURE IS NAMED. The SDK throws a different type for each way a call
 * can fail — unreachable, not-a-crucible, wrong token, wrong API version, a
 * refusal the server named, a 5xx, a payload v1 does not describe — and each
 * gets its own one-line message here and exit code 1. An exception that is NOT
 * one of those, and not a refusal this file or the registry states, is NOT
 * caught: an unexpected stack is a bug report, not a message.
 */
'use strict';
require('./electron-stub.js'); // intercept require('electron') for the compiled modules

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'electron');

const {
  CrucibleAcceleratorUnreadable,
  CrucibleAuthError,
  CrucibleConfigError,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
  readRenderResult,
} = require('@crucible/client');

/** This client's name in the server's log, and in its User-Agent. */
const CLIENT_NAME = 'bookforge-cli';

/** An argument this file refuses: a message for the operator, never a stack. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Which server the call in flight is for, so the error line can name it. */
let inFlightServer = null;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    let key, val;
    if (eq >= 0) { key = body.slice(0, eq); val = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { key = body; val = argv[++i]; }
    else { key = body; val = true; }
    a[key] = val;
  }
  return a;
}

/** A flag that must carry a value, not merely be present. */
function required(args, key, why) {
  const value = args[key];
  if (value === undefined || value === true || value === '') {
    throw new UsageError(`--${key} <value> is required: ${why}`);
  }
  return value;
}

function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * "This host has no backend block for that row" — so there is no revision to
 * name, no cap to state and no estimate to print.
 *
 * ASCII, and every column that can be absent uses this one spelling. A console
 * on a cp1252 code page renders an em dash as `?`, and a table whose "no answer"
 * marker is a question mark reads as a question rather than an answer.
 */
const NOT_ON_THIS_HOST = 'n/a';

/** A VRAM figure in GiB. Every caller's numbers are bytes off the wire. */
function gibHuman(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`;
}

/**
 * A model's or voice's memory estimate for the table. `null` is not 0 and is not
 * blank: the manifest has no backend block for this host, so there is no figure
 * to print and saying `0.0 GiB` would read as "needs nothing" (PHASE2-LLM.md
 * section 5, PHASE3-TTS.md section 2).
 */
function memoryHuman(bytes) {
  if (bytes === null) return NOT_ON_THIS_HOST;
  return gibHuman(bytes);
}

/**
 * A figure the wire may decline to give: `null` is printed as `unknown`, never
 * as `0`.
 *
 * `holders[].bytes` is null wherever the driver withholds per-process figures,
 * and `0` there tells a reader that a process holding several gigabytes is
 * holding none — which reads as an idle card, the one conclusion
 * GET /v1/accelerator exists to prevent (PHASE4-AUDIO.md section 5).
 */
function maybeBytesHuman(bytes) {
  if (bytes === null) return 'unknown';
  return gibHuman(bytes);
}

/**
 * A flag that must carry a non-negative integer. No default, because every
 * caller of this is a decision the server refuses rather than picking.
 */
function requiredIndex(args, key, why) {
  const raw = String(required(args, key, why));
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--${key} must be a non-negative integer, got "${raw}": ${why}`);
  }
  return Number(raw);
}

/**
 * The chunks to render, read out of a file the operator wrote.
 *
 * Two shapes, both exact, neither guessed at:
 *   - `.jsonl` — one `{"index": N, "text": "..."}` per line, which is
 *     RenderChunk itself. Use it when the indices are not 0..n-1: they are file
 *     names downstream (`<index>.flac`), and BookForge's assembly and resume
 *     look for the ones the session already knows about.
 *   - anything else — one chunk per line, index = the 0-based line number.
 *
 * A BLANK LINE IS REFUSED, naming it. In the line-per-chunk shape a blank line
 * has no text to speak, and skipping it would shift every later chunk's index by
 * one — renaming files the caller believed it had named.
 *
 * The per-(voice, backend) character cap is deliberately NOT checked here. It
 * lives on the voice row (`--voices`, `max_chars`) and the server refuses an
 * over-long chunk by name with `chunk_too_long`; a second copy of that number in
 * this file would be a second thing to drift out of date.
 */
function readRenderChunks(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // An empty file is "no chunks", which is a different thing to say than "line 1
  // is blank" — there is no line 1 to point at.
  if (raw.trim() === '') {
    throw new UsageError(`${file} is empty - a render needs at least one chunk`);
  }
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const jsonl = path.extname(file).toLowerCase() === '.jsonl';
  const chunks = [];
  const seen = new Map();     // index -> the line that claimed it

  lines.forEach((line, at) => {
    const where = `${file} line ${at + 1}`;
    let chunk;
    if (jsonl) {
      if (line.trim() === '') {
        throw new UsageError(`${where} is blank; a .jsonl row is one chunk, so a blank row is a `
          + 'chunk with no index and no text');
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new UsageError(`${where} is not JSON (${err.message}); a .jsonl chunk file is one `
          + '{"index": N, "text": "..."} object per line');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new UsageError(`${where} is not a JSON object; each row is {"index": N, "text": "..."}`);
      }
      if (!Number.isInteger(parsed.index) || parsed.index < 0) {
        throw new UsageError(`${where} has no integer "index" >= 0 - the index is this chunk's `
          + 'file name on the way back (<index>.flac) and is never assigned for you');
      }
      if (typeof parsed.text !== 'string' || parsed.text === '') {
        throw new UsageError(`${where} has no non-empty "text"`);
      }
      chunk = { index: parsed.index, text: parsed.text };
    } else {
      if (line.trim() === '') {
        throw new UsageError(`${where} is blank. One line is one chunk and its NUMBER is the `
          + "chunk's index, so dropping a blank line would renumber every chunk after it. Remove "
          + 'the line, or use a .jsonl file that states each index');
      }
      chunk = { index: at, text: line };
    }
    const clash = seen.get(chunk.index);
    if (clash !== undefined) {
      throw new UsageError(`${where} claims index ${chunk.index}, which line ${clash} already `
        + 'claimed; two chunks cannot share one index because an index is a file name');
    }
    seen.set(chunk.index, at + 1);
    chunks.push(chunk);
  });
  return chunks;
}

/**
 * Watch a job to its terminal event, printing every event on stderr the way
 * --echo does, and hand the caller the terminal one. Shared by --load and
 * --unload, which are ordinary jobs on the same exclusive lane as everything
 * else — a chat request can therefore never race a load.
 */
async function watchJob(client, jobId, label) {
  process.stderr.write(`[crucible] job ${jobId} (${label})\n`);
  let terminal = null;
  for await (const event of client.events(jobId)) {
    process.stderr.write(`[crucible] #${event.id} ${event.event} ${JSON.stringify(event.data)}\n`);
    if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
      terminal = event;
    }
  }
  if (terminal === null) {
    // The SDK ends the iterator only on a terminal event or by throwing, so this
    // is unreachable by contract. Stated rather than assumed.
    throw new Error(`the event stream for job ${jobId} ended with no terminal event`);
  }
  return terminal;
}

/**
 * One line per SDK error type, or `null` for anything that is not one.
 *
 * These eight are the SDK's whole error vocabulary (sdk/ts/README.md,
 * "Errors"). Each says what a reader can do about it, and none of them is a
 * retry: a dead server is reported as a dead server.
 */
function describeSdkError(err) {
  const at = inFlightServer === null ? 'crucible' : `crucible "${inFlightServer}"`;
  if (err instanceof CrucibleConfigError) {
    return `${at}: the client was built wrong — ${err.message}`;
  }
  if (err instanceof CrucibleUnreachable) {
    // This error's own message already names the URL and says "is unreachable",
    // so prefixing it with `at` a second time would say it twice.
    const named = inFlightServer === null ? '' : `${inFlightServer}: `;
    return `${named}${err.message}. Is the server running, and is this machine on its network?`;
  }
  if (err instanceof CrucibleNotACrucible) {
    return `${at} answered /v1/ping but is not a crucible: ${err.body}. Check the url.`;
  }
  if (err instanceof CrucibleAuthError) {
    return `${at} refused the token (${err.code}): ${err.serverMessage}. Re-add the server with `
      + 'the token `crucible token --show` prints on that host.';
  }
  if (err instanceof CrucibleVersionError) {
    return `${at} speaks API version ${err.serverApiVersion}, this client speaks `
      + `${err.clientApiVersion} (${err.code}): ${err.serverMessage}. One of the two must be updated.`;
  }
  if (err instanceof CrucibleRefused) {
    return `${at} refused the request (${err.status} ${err.code}): ${err.serverMessage}`;
  }
  // BEFORE CrucibleServerError, which it extends. The narrower type exists for
  // the one conclusion it must never be confused with: the probe RAN and could
  // not read the card (nvidia-smi missing, refusing, timing out). It is not an
  // answer about the card, and it is emphatically not "the card is free" — the
  // server raises rather than returning zeroes precisely so that it cannot be
  // read that way (PHASE4-AUDIO.md section 5).
  if (err instanceof CrucibleAcceleratorUnreadable) {
    return `${at} cannot see its accelerator (${err.status} ${err.code}): ${err.serverMessage}. `
      + 'That is "ask again", NOT "the card is idle" - nothing here has been told what is on it.';
  }
  if (err instanceof CrucibleServerError) {
    return `${at} failed the request (${err.status} ${err.code}): ${err.serverMessage}. The `
      + 'server broke; its own log says why.';
  }
  if (err instanceof CrucibleProtocolError) {
    return `${at} sent something API v1 does not describe: ${err.detail}. The server and this `
      + 'client disagree about the protocol.';
  }
  return null;
}

async function run(args) {
  if (!fs.existsSync(DIST)) {
    throw new UsageError('dist/electron missing — build first:  npx tsc -p tsconfig.electron.json');
  }
  const servers = require(path.join(DIST, 'crucible', 'servers.js'));

  // ── --add ─────────────────────────────────────────────────────────────────
  if (args.add) {
    const name = required(args, 'name', 'the name this machine will know the server by');
    const url = required(args, 'url', 'the server base URL, without /v1');
    const hasToken = args.token !== undefined;
    const hasTokenFile = args['token-file'] !== undefined;
    if (hasToken && hasTokenFile) {
      throw new UsageError('--token and --token-file both name the bearer token; pass one');
    }
    if (!hasToken && !hasTokenFile) {
      throw new UsageError('--add needs the bearer token: --token <t>, or --token-file <path> so '
        + 'it does not sit in your shell history');
    }
    let token;
    if (hasTokenFile) {
      const file = path.resolve(required(args, 'token-file', 'the file holding the bearer token'));
      if (!fs.existsSync(file)) throw new UsageError(`no such token file: ${file}`);
      token = fs.readFileSync(file, 'utf8').trim();
    } else {
      token = String(required(args, 'token', 'the bearer token `crucible token --show` prints'));
    }
    const added = servers.addServer({ name, url, token });
    console.log(`added ${added.name}  ${added.url}  token ${added.tokenMasked}`);
    return;
  }

  // ── --remove ──────────────────────────────────────────────────────────────
  if (args.remove) {
    const name = required(args, 'name', 'which server to forget');
    const gone = servers.removeServer(name);
    console.log(`removed ${gone.name}  ${gone.url}`);
    return;
  }

  // ── --list ────────────────────────────────────────────────────────────────
  // The listing type cannot carry a plaintext token; see electron/crucible/servers.ts.
  if (args.list) {
    const rows = servers.listServers();
    if (rows.length === 0) {
      console.log(`no crucible servers registered  —  ${servers.registryPath()}`);
      return;
    }
    for (const row of rows) {
      console.log(`${row.name}\t${row.url}\ttoken ${row.tokenMasked}\tadded ${row.added}`);
    }
    console.log(`\n${rows.length} server(s)  —  ${servers.registryPath()}`);
    return;
  }

  const remote = Boolean(args.ping || args.info || args.health || args.echo
    || args.models || args.load || args.unload || args.chat
    || args.voices || args['load-voice'] || args['unload-voice']
    || args.accelerator || args.render);
  if (!remote) {
    throw new UsageError('pick a verb: --add / --remove / --list / --ping / --info / --health / '
      + '--echo / --models / --load / --unload / --chat / --voices / --load-voice / '
      + '--unload-voice / --accelerator / --render');
  }
  const serverName = required(args, 'server', 'which registered crucible to call');
  // Resolved BEFORE the call, so an unknown server is a registry refusal rather
  // than a network one, and every later error line can name the server.
  const client = servers.crucibleClientFor(serverName, CLIENT_NAME);
  inFlightServer = serverName;

  // ── --ping ────────────────────────────────────────────────────────────────
  // Unauthenticated on purpose, so "wrong address" and "wrong token" are two
  // different answers. It is therefore NOT a token check — --health is.
  if (args.ping) {
    const pong = await client.ping();
    console.log(`${serverName}\t${client.url}\tcrucible "${pong.name}"  api v${pong.apiVersion}`);
    return;
  }

  // ── --info ────────────────────────────────────────────────────────────────
  if (args.info) {
    const info = await client.info();
    console.log(`server        ${info.server.name}  v${info.server.version}  api v${info.server.apiVersion}`);
    console.log(`host          ${info.host.platform}/${info.host.arch}`);
    console.log(`backend       ${info.host.backend}`);
    console.log(`gpu           ${info.host.gpu.vendor} ${info.host.gpu.name}  `
      + `${(info.host.gpu.vramBytes / (1024 ** 3)).toFixed(1)} GiB`);
    // NOT the same list as the capabilities below, deliberately: a capability
    // says what this server can SERVE, job_types says what to ASK IT WITH. One
    // capability can be operated by several job types — `llm` is a capability,
    // `load-model` and `unload-model` are things you post and are capabilities
    // of neither.
    console.log(`job types     ${info.jobTypes.length === 0 ? '(none)' : info.jobTypes.join(', ')}`);
    if (info.capabilities.length === 0) console.log('capabilities  (none advertised)');
    for (const cap of info.capabilities) {
      const models = cap.models.length
        ? cap.models.map((m) => `${m.id}@${m.revision}${m.resident ? ' (resident)' : ''}`).join(', ')
        : 'no models';
      console.log(`capability    ${cap.jobType}  —  ${models}`);
    }
    return;
  }

  // ── --health ──────────────────────────────────────────────────────────────
  //
  // `residentKind` is phase 3's addition: one card holds one thing and that
  // thing may now be a voice, so the id in `residentModels` does not say which
  // door to knock on. `chat()` against a server with a VOICE resident is
  // `model_not_resident`, and the two are different situations.
  if (args.health) {
    const health = await client.health();
    const resident = health.residentModels.length ? health.residentModels.join(', ') : 'none';
    // null means nothing is resident, which `resident none` has already said;
    // printing `kind null` beside it would be a second way to say the same
    // thing, one of which looks like a missing field.
    const kind = health.residentKind === null ? '' : `\tkind ${health.residentKind}`;
    console.log(`status ${health.status}\tqueue ${health.queueDepth}\tresident ${resident}${kind}`);
    return;
  }

  // ── --models ──────────────────────────────────────────────────────────────
  // GET /v1/models. Four booleans that are four different facts, and none of
  // them implies another: backendSupported (there is a block for this host's
  // backend), installed (weights on disk), resident (an engine is serving it
  // now), loadable (asking for it now would succeed — which also depends on the
  // accelerator guard). A row that is not loadable ALWAYS carries the server's
  // own reason, so the reason column is printed instead of the boolean.
  if (args.models) {
    const rows = await client.models();
    if (rows.length === 0) {
      console.log(`${serverName} advertises no models`);
      return;
    }
    console.log('id\tinstalled\tresident\tloadable\trevision\tmemory');
    for (const row of rows) {
      const loadable = row.loadable ? 'yes' : `no: ${row.reason}`;
      // revision is null — not "" — when this host has no backend block; the two
      // are different answers ("no pin recorded" vs "cannot serve it here").
      const revision = row.revision === null ? NOT_ON_THIS_HOST : row.revision.slice(0, 12);
      console.log(`${row.id}\t${row.installed ? 'yes' : 'no'}\t${row.resident ? 'yes' : 'no'}`
        + `\t${loadable}\t${revision}\t${memoryHuman(row.memoryBytesEstimate)}`);
    }
    return;
  }

  // ── --load ────────────────────────────────────────────────────────────────
  // A normal job: queued, then a `warming` per line of the engine's own
  // readiness, then done {resident}. ONE model is resident at a time, so this
  // unloads whatever was there — which is why it is an explicit operator verb
  // and never something a cleanup run does for you.
  if (args.load) {
    const model = required(args, 'model', 'which model to make resident');
    process.stderr.write(`[crucible] ${serverName} ${client.url}: load ${model}\n`);
    const jobId = await client.loadModel(model);
    const terminal = await watchJob(client, jobId, `load ${model}`);
    if (terminal.event !== 'done') {
      console.error(`[crucible] load ${model} ended ${terminal.event}: ${JSON.stringify(terminal.data)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`resident    ${terminal.data.resident}  on ${serverName}`);
    return;
  }

  // ── --unload ──────────────────────────────────────────────────────────────
  // Also a job. `done {resident: null}` is the same field the load reports,
  // saying what is resident NOW — which after an unload is nothing.
  if (args.unload) {
    const model = required(args, 'model', 'which model to unload');
    process.stderr.write(`[crucible] ${serverName} ${client.url}: unload ${model}\n`);
    const jobId = await client.unloadModel(model);
    const terminal = await watchJob(client, jobId, `unload ${model}`);
    if (terminal.event !== 'done') {
      console.error(`[crucible] unload ${model} ended ${terminal.event}: ${JSON.stringify(terminal.data)}`);
      process.exitCode = 1;
      return;
    }
    const now = terminal.data.resident === null || terminal.data.resident === undefined
      ? 'nothing' : terminal.data.resident;
    console.log(`resident    ${now}  on ${serverName}`);
    return;
  }

  // ── --chat ────────────────────────────────────────────────────────────────
  // One completion against the RESIDENT model. Naming a model that is not
  // resident is a 409 the SDK surfaces as CrucibleRefused model_not_resident,
  // which describeSdkError prints with the server's own message naming what IS
  // resident — never a silent load, never a retry.
  //
  // --no-thinking sends chat_template_kwargs {enable_thinking: false}. Omitting
  // it sends NOTHING and leaves the model's own default alone; there is no
  // --thinking-on/off pair defaulting to one of them, because "the model's
  // default" is a third answer and this flag must not erase it.
  if (args.chat) {
    const model = required(args, 'model', 'which model to talk to (it must be the resident one)');
    const prompt = required(args, 'prompt', 'the text to send as the user turn');
    if (args.thinking !== undefined) {
      throw new UsageError('--thinking is not a flag here: pass --no-thinking to turn reasoning '
        + "off, or pass neither to leave the model's own default alone");
    }
    const options = { model, messages: [{ role: 'user', content: String(prompt) }] };
    if (args['no-thinking']) options.thinking = false;

    if (args.stream) {
      process.stderr.write(`[crucible] ${serverName} ${client.url}: chat ${model} (streamed)\n`);
      let any = false;
      for await (const delta of client.chatStream(options)) {
        any = true;
        process.stdout.write(delta);
      }
      process.stdout.write('\n');
      if (!any) {
        // The SDK requires `content` on a completion, but a stream can legally
        // carry only reasoning frames. An answer that is not there is not an
        // empty answer — say so rather than exiting 0 on a blank line.
        console.error('[crucible] the stream carried no content deltas — if this is a reasoning '
          + 'model, pass --no-thinking or raise the token budget');
        process.exitCode = 1;
      }
      return;
    }

    process.stderr.write(`[crucible] ${serverName} ${client.url}: chat ${model}\n`);
    const answer = await client.chat(options);
    console.log(answer.content);
    process.stderr.write(`[crucible] model ${answer.model}  finish ${answer.finishReason}  `
      + `tokens ${answer.usage.promptTokens}+${answer.usage.completionTokens}`
      + `=${answer.usage.totalTokens}\n`);
    return;
  }

  // ── --voices ──────────────────────────────────────────────────────────────
  // GET /v1/voices. A voice is to `tts` what a model is to `llm`, and the four
  // booleans mean exactly what they mean in --models: backendSupported (the
  // manifest has a block for this host's backend), installed (weights on disk),
  // resident (narrator is serving it now), loadable (everything this host needs
  // is in place). `loadable` is a fact about the DISK and deliberately does not
  // run nvidia-smi, so a row saying `yes` can still be refused at load time with
  // `accelerator_busy` — that question is --accelerator's.
  //
  // THE REASON IS THE POINT OF THIS TABLE. On a machine where `crucible install
  // tts` has never run, every voice is `loadable: false` and the server's reason
  // names the env that is missing AND the command that installs it. A bare "no"
  // would leave an operator with nothing to do next, so the reason is printed in
  // the column's place, verbatim and in the server's own words.
  if (args.voices) {
    const rows = await client.voices();
    if (rows.length === 0) {
      console.log(`${serverName} advertises no voices`);
      return;
    }
    console.log('id\tkind\tengine\tlang\tinstalled\tresident\trevision\tmax_chars\trate\ttakes'
      + '\tmemory\tloadable');
    for (const row of rows) {
      // A voice row carries `reason: null` when it IS loadable, where a model
      // row omits the key; both are read as they come rather than tidied.
      const loadable = row.loadable ? 'yes' : `no: ${row.reason}`;
      const revision = row.revision === null ? NOT_ON_THIS_HOST : row.revision.slice(0, 12);
      // maxChars is null for the same reason memoryBytesEstimate is: it lives in
      // the backend block this host does not have. It is CHARACTERS, and it is
      // the cap certificate a client packs to.
      const maxChars = row.maxChars === null ? NOT_ON_THIS_HOST : String(row.maxChars);
      console.log(`${row.id}\t${row.kind}\t${row.narratorEngine}\t${row.language}`
        + `\t${row.installed ? 'yes' : 'no'}\t${row.resident ? 'yes' : 'no'}`
        + `\t${revision}\t${maxChars}\t${row.sampleRate}\t${row.takes}`
        + `\t${memoryHuman(row.memoryBytesEstimate)}\t${loadable}`);
    }
    return;
  }

  // ── --load-voice ──────────────────────────────────────────────────────────
  // The same shape as --load, because it is the same thing: one card holds one
  // thing, and since PHASE3-TTS.md section 5 that thing may be a voice or a
  // model. So loading a voice unloads whichever it was, and it is refused for
  // the same reasons a model load is — unknown, not installed, unsupported on
  // this backend, too big for the free VRAM, the card busy with someone else's
  // work — plus one of its own: the tts env for this voice's narrator engine is
  // not installed (`env_missing`), which --voices states in advance.
  if (args['load-voice']) {
    const voice = required(args, 'voice', 'which voice to make resident');
    process.stderr.write(`[crucible] ${serverName} ${client.url}: load voice ${voice}\n`);
    const jobId = await client.loadVoice(voice);
    const terminal = await watchJob(client, jobId, `load-voice ${voice}`);
    if (terminal.event !== 'done') {
      console.error(`[crucible] load-voice ${voice} ended ${terminal.event}: `
        + `${JSON.stringify(terminal.data)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`resident    ${terminal.data.resident}  on ${serverName}`);
    return;
  }

  // ── --unload-voice ────────────────────────────────────────────────────────
  // `done {resident: null}` once narrator has exited and the card is back.
  // `voice_not_resident` if it was not loaded — INCLUDING when a model holds the
  // card, which the server states as its own refusal rather than as "nothing is
  // loaded", because they call for different next moves.
  if (args['unload-voice']) {
    const voice = required(args, 'voice', 'which voice to unload');
    process.stderr.write(`[crucible] ${serverName} ${client.url}: unload voice ${voice}\n`);
    const jobId = await client.unloadVoice(voice);
    const terminal = await watchJob(client, jobId, `unload-voice ${voice}`);
    if (terminal.event !== 'done') {
      console.error(`[crucible] unload-voice ${voice} ended ${terminal.event}: `
        + `${JSON.stringify(terminal.data)}`);
      process.exitCode = 1;
      return;
    }
    const now = terminal.data.resident === null || terminal.data.resident === undefined
      ? 'nothing' : terminal.data.resident;
    console.log(`resident    ${now}  on ${serverName}`);
    return;
  }

  // ── --accelerator ─────────────────────────────────────────────────────────
  // GET /v1/accelerator: what is on the card, who holds it, and which of them
  // are Crucible's own. It REPORTS and it never evicts.
  //
  // Read the three refusals-to-answer before concluding anything:
  //   - a holder's `bytes` may be null (the driver will not say per process);
  //     printed `unknown`, never 0.
  //   - an EMPTY holders list is not an idle card. Under WSL2 — the host
  //     BookForge runs on — the driver shim answers the compute-app query with
  //     no entries while a process inside that same VM holds 17 GB, and
  //     `unattributed` is then the only honest report that the card is busy.
  //   - a 503 `accelerator_unreadable` is not an answer about the card at all;
  //     see describeSdkError.
  if (args.accelerator) {
    const state = await client.accelerator();
    console.log(`backend       ${state.backend}`);
    console.log(`gpu           ${state.gpu.vendor} ${state.gpu.name}  `
      + `${gibHuman(state.gpu.totalBytes)} total`);
    console.log(`free          ${gibHuman(state.freeBytes)}`);
    console.log(`used          ${gibHuman(state.usedBytes)}`);
    console.log(`desktop       ${gibHuman(state.desktopAllowanceBytes)} held back for this host's `
      + 'own desktop');
    // null on mlx-darwin, where "used unified memory" is the OS doing its job
    // and attributing it to compute processes is not a question vm_stat answers.
    console.log(`unattributed  ${state.unattributedBytes === null
      ? 'unknown (this backend cannot attribute memory to compute processes)'
      : `${gibHuman(state.unattributedBytes)} in use that no listed holder accounts for`}`);
    if (state.resident === null) {
      console.log('resident      nothing - crucible holds none of this card');
    } else {
      console.log(`resident      ${state.resident.kind} ${state.resident.id}  since `
        + `${state.resident.since}  est ${gibHuman(state.resident.memoryBytesEstimate)}`);
    }
    if (state.holders.length === 0) {
      console.log('holders       the driver listed NONE - which is not the same as an idle card; '
        + 'read `unattributed` above');
    } else {
      console.log(`holders       ${state.holders.length} compute process(es)`);
      for (const holder of state.holders) {
        console.log(`  pid ${holder.pid}\t${holder.name}\t${maybeBytesHuman(holder.bytes)}`
          + `\t${holder.ownedByCrucible ? "crucible's own" : 'not crucible'}`);
      }
    }
    console.log(`detail        ${state.detail}`);
    return;
  }

  // ── --render ──────────────────────────────────────────────────────────────
  // One `tts` job: text in, `<index>.flac` out, written where BookForge's
  // assembly and resume already look.
  //
  // The bytes cross the wire even from a server on localhost, because there is
  // no shared mount, ever. writeArtifactsTo fetches each artifact as its event
  // lands — overlapped with the next chunk still generating — writes the
  // provenance sidecar FIRST and then the FLAC, and renames both into place, so
  // `<index>.flac` only ever exists complete and only ever beside the record of
  // which voice, which revision and which server made it. BookForge's resume
  // test is "the file exists and exceeds 1024 bytes", which a half-written FLAC
  // would pass.
  //
  // THE VOICE NEED NOT BE RESIDENT. A render owns the exclusive lane for its
  // whole duration and is an operator's explicit order, so it loads its own
  // voice if it has to, emitting `warming` exactly as --load-voice does. That is
  // the one asymmetry with `llm`, where an unattended chat never loads.
  if (args.render) {
    const voice = required(args, 'voice', 'which voice to render in (it is the `model` on the wire)');
    const language = required(args, 'language', "the manifest's language tag for this text, e.g. en");
    // No default. `0` is the engine's own sampling, which is a RUNG and not an
    // absence; a take the caller did not choose is a silent substitution, and a
    // rung past the end of the ladder is `unknown_take` and never clamped.
    const take = requiredIndex(args, 'take', 'which rung of the voice\'s take ladder to render at '
      + '(0 is the engine\'s own sampling; --voices says how many rungs it has)');
    const textFile = path.resolve(required(args, 'text', 'the file holding the chunks to render'));
    if (!fs.existsSync(textFile)) throw new UsageError(`no such chunk file: ${textFile}`);
    const outDir = path.resolve(required(args, 'out', 'the directory to write <index>.flac into'));
    const chunks = readRenderChunks(textFile);

    process.stderr.write(`[crucible] ${serverName} ${client.url}: render ${voice} `
      + `take ${take} ${language}, ${chunks.length} chunk(s) from ${textFile}\n`);
    const jobId = await client.render({ voice, language, take, chunks });
    process.stderr.write(`[crucible] job ${jobId}\n`);

    let terminal = null;
    for await (const write of client.writeArtifactsTo(jobId, outDir)) {
      if (write.kind === 'written') {
        console.log(`wrote       ${write.written.name}  ${write.written.path}  `
          + `(${bytesHuman(write.written.bytes)})`);
        continue;
      }
      const event = write.event;
      if (event.event === 'chunk') {
        // The whole guard interface, and the two fields that must not be read as
        // measurements they are not. `capped === null` is "narrator did not put
        // its frame cap on the wire" — printed `false` it would call every
        // runaway a long sentence, silently, which is the exact failure this
        // event exists to prevent. `tokens` is null for the same reason.
        const d = event.data;
        const capped = d.capped === null ? 'unknown' : String(d.capped);
        const tokens = d.tokens === null ? 'unknown' : String(d.tokens);
        console.log(`chunk    ${d.index}\t${d.seconds.toFixed(2)} s\t${d.chars} chars`
          + `\t${d.charsPerSec.toFixed(1)} chars/s\ttokens ${tokens}\tcapped ${capped}`);
        continue;
      }
      process.stderr.write(`[crucible] #${event.id} ${event.event} ${JSON.stringify(event.data)}\n`);
      if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
        terminal = event;
      }
    }
    if (terminal === null) {
      // The SDK ends the iterator only on a terminal event or by throwing, so
      // this is unreachable by contract. Stated rather than assumed.
      throw new Error(`the event stream for job ${jobId} ended with no terminal event`);
    }
    if (terminal.event !== 'done') {
      console.error(`[crucible] render ${voice} ended ${terminal.event}: `
        + `${JSON.stringify(terminal.data)}`);
      process.exitCode = 1;
      return;
    }

    // A SUCCESSFUL JOB CAN STILL HAVE FAILED CHUNKS. One bad sentence never
    // sinks the other 1,399, so the server reports each and carries on; this is
    // the authoritative list of them, and a chunk with no `<index>.flac` is a
    // file that is not there. The exit code says so, because an operator who
    // asked for N files and got fewer has not had the thing they asked for.
    const result = readRenderResult(terminal.data);
    console.log(`rendered    ${result.rendered} of ${chunks.length} chunk(s)  take ${result.take}  `
      + `${result.sampleRate} Hz`);
    console.log(`out         ${outDir}`);
    if (result.failed.length > 0) {
      console.error(`[crucible] ${result.failed.length} chunk(s) produced no audio:`);
      for (const failure of result.failed) {
        console.error(`  chunk ${failure.index}: ${failure.message}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  // ── --echo ────────────────────────────────────────────────────────────────
  // The whole handshake in one command: submit with the bytes inline, watch the
  // SSE stream, download the artifact, persist the provenance sidecar beside it,
  // and compare. Exit 0 ONLY if the bytes came back identical — an echo that
  // returns something else is a failure even though every call succeeded.
  const file = path.resolve(required(args, 'file', 'the file to send through the echo job'));
  if (!fs.existsSync(file)) throw new UsageError(`no such file: ${file}`);
  const sent = fs.readFileSync(file);
  const artifactName = path.basename(file);
  const out = args.out && args.out !== true ? path.resolve(args.out) : `${file}.echo`;

  process.stderr.write(`[crucible] ${serverName} ${client.url}: echo ${artifactName} `
    + `(${bytesHuman(sent.length)})\n`);
  const jobId = await client.submit({
    type: 'echo',
    params: {},
    inputs: { [artifactName]: { inline: new Uint8Array(sent) } },
  });
  process.stderr.write(`[crucible] job ${jobId}\n`);

  let terminal = null;
  for await (const event of client.events(jobId)) {
    process.stderr.write(`[crucible] #${event.id} ${event.event} ${JSON.stringify(event.data)}\n`);
    if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
      terminal = event;
    }
  }
  if (terminal === null) {
    // The SDK ends the iterator only on a terminal event or by throwing, so this
    // is unreachable by contract. Stated rather than assumed.
    throw new Error(`the event stream for job ${jobId} ended with no terminal event`);
  }
  if (terminal.event !== 'done') {
    console.error(`[crucible] job ${jobId} ended ${terminal.event}: ${JSON.stringify(terminal.data)}`);
    process.exitCode = 1;
    return;
  }

  const got = Buffer.from(await client.artifact(jobId, artifactName));
  fs.writeFileSync(out, got);
  // The sidecar is persisted VERBATIM (DESIGN.md section 7): snake_case keys,
  // exactly as the server wrote them. A finished artifact says which server made
  // it, and rewriting the keys would corrupt the thing being persisted.
  const provenance = await client.provenance(jobId, artifactName);
  const sidecar = `${out}.provenance.json`;
  fs.writeFileSync(sidecar, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  console.log(`artifact    ${out}  (${bytesHuman(got.length)})`);
  console.log(`provenance  ${sidecar}  —  ${provenance.server.name} v${provenance.server.version}, `
    + `backend ${provenance.backend}, job_type ${provenance.job_type}`);
  if (!got.equals(sent)) {
    console.error(`[crucible] the echoed bytes DIFFER from ${file} `
      + `(sent ${sent.length} B, got ${got.length} B) — the artifact path is not lossless`);
    process.exitCode = 1;
    return;
  }
  console.log(`identical   ${sent.length} bytes round-tripped through ${serverName}`);
}

run(parseArgs(process.argv.slice(2))).catch((err) => {
  const line = describeSdkError(err);
  if (line !== null) {
    console.error(`[crucible] ${line}`);
    process.exitCode = 1;
    return;
  }
  // The registry's own named refusals, and this file's argument refusals.
  if (err instanceof UsageError || (err instanceof Error && err.name === 'CrucibleRegistryError')) {
    console.error(`[crucible] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  throw err;   // anything else is a bug, and a bug gets its stack
});
