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
 * is `echo`, which hands back the bytes it was given — which is exactly what
 * makes it a handshake: it proves the token, the API version, the queue, the
 * SSE stream, the artifact download and the provenance sidecar without loading
 * a model or touching a GPU.
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
  CrucibleAuthError,
  CrucibleConfigError,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
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

  const remote = Boolean(args.ping || args.info || args.health || args.echo);
  if (!remote) {
    throw new UsageError('pick a verb: --add / --remove / --list / --ping / --info / --health / --echo');
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
  if (args.health) {
    const health = await client.health();
    const resident = health.residentModels.length ? health.residentModels.join(', ') : 'none';
    console.log(`status ${health.status}\tqueue ${health.queueDepth}\tresident ${resident}`);
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
