/**
 * text-server — THE ARBITER FOR THE TEXT-PASS vLLM: it stages the weights, starts
 * the server before a language act, stops it when the work drains, and steps off
 * the card the moment a render wants it.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-08: *"lets build in vllm batching. ollama batching doesnt work.
 * its an unfinished feature ollama tried to implement but isnt accessible on the
 * mac or pc. cuda graphs/vllm would probably be the best for all three
 * features."* And an hour later, once the engine half had landed: *"build that
 * piece. the arbiter that starts/stops it."*
 *
 * Foundry (engine 19f5e70) speaks `--server ollama|vllm` and NOTHING ELSE — it
 * never starts, stops or warms a server (foundry-app/VENDORED.md's last
 * paragraph; the engine checkout's docs/VLLM.md §5, "BookForge's arbiter owns
 * that server's life"). This file is that owner.
 *
 * ── Shaped after vlm-page-server.ts, which is the proven one ────────────────
 *
 * The reading server (electron/vlm-page-server.ts) is BookForge's working
 * WSL-hosted vLLM manager and every load-bearing piece below is its:
 *
 *   · ONE IN-FLIGHT START PROMISE, so two text passes beginning together share
 *     one spawn instead of reserving the same VRAM twice.
 *   · READINESS FROM THE LOG AS WELL AS THE PORT. Polling `/v1/models` alone
 *     turns every failure into the whole timeout. MEASURED on this PC's first
 *     start (2026-09-08): the sampler warm-up died with `RuntimeError: Could not
 *     find nvcc` NINETY SECONDS in, after the weights had already loaded — a
 *     fatal line arrives long before any deadline, and scanning for it is what
 *     turns fifteen minutes of waiting into a named failure with the tail.
 *   · SIGTERM FROM INSIDE THE GUEST, never a taskkill on wsl.exe. SIGKILLing a
 *     process that holds the CUDA device is the documented way to wedge WSL
 *     until a reboot (CLAUDE.md; memory `wsl-wedge-proofing`). The stop goes
 *     through `wslPkillGraceful`, the house's one graceful in-guest kill — it
 *     never escalates to SIGKILL, and it verifies the exit.
 *
 * What is NOT taken from it: the reading server registers no `onYield` on
 * purpose (yielding mid-conversion fails a ninety-minute run). This one DOES.
 * A text pass is minutes, not hours, and the card's real work is the renders —
 * so the text server is the LOW-priority holder, exactly as `GPU_OWNER_LLAMA`
 * is in gpu-arbiter.ts: a TTS acquire calls our yield, we stop, the render runs.
 *
 * ── The measured numbers this exists to buy ─────────────────────────────────
 *
 * Ollama 0.33.3 refuses to decode the qwen35 architecture in parallel on its
 * llama.cpp backend (sched.go:509), so `OLLAMA_NUM_PARALLEL=4` and Foundry's
 * four-in-flight pool bought nothing: every text pass ran ONE request at a time.
 * Through this server, on the Pokemon book, the same cleanup went from
 * **110 blocks/min to 458 blocks/min** — 7 requests in flight at
 * `--gpu-memory-utilization 0.90`, with 3 more queued for KV capacity.
 *
 * The cost side, also measured on this PC (2026-09-08): **~110 s to start**
 * (15 s model load, 94 s init, "Application startup complete" at ~110 s) and
 * therefore **~95 s to swap** one profile for another.
 *
 * ── A PROFILE THAT IS NOT ON DISK STAGES ITSELF ─────────────────────────────
 *
 * Owen, 2026-09-08, asked what a translation should do when the 27B's weights
 * are not there: *"id rather it just switch to the correct profile rather than
 * failing."* So an absent model is not a refusal — `ensureTextServer` downloads
 * it (pinned revision, into the guest's ext4, resumable, with the gigabytes on
 * the queue row) and then starts the server. The ONE thing that still refuses by
 * name is a download that cannot happen at all: no network, no disk, a revision
 * that is gone. That is the failure a machine cannot resolve on its own.
 *
 * ── The rule about somebody else's server ───────────────────────────────────
 *
 * Foundry's rule for its reading server, kept verbatim here (their
 * vllm-server.ts header): *if the port already answers, that server is USED and
 * never owned*. This file goes one step further, because the served NAME is
 * recorded in Foundry's bank key, its records key and its narration stamp: a
 * server on our port whose `/v1/models` id is not the profile's served name is
 * SOMEBODY ELSE'S. It is refused by name, never used, and never stopped —
 * cleaning a book against a model nobody named is worse than refusing to.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  getWslCondaPath,
  getWslDistro,
  getWslHiggsCondaEnv,
  windowsToWslPath,
  wslCondaEnvPrefix,
  wslScriptArgs,
} from './tool-paths';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import {
  execWsl,
  wslPkillGraceful,
  type WslPkillOptions,
  type WslPkillOutcome,
} from './wsl-lifecycle';
import { externalGpuJobLock } from '../shared/gpu/external-job-lock';
import { RollingLogger } from './rolling-logger';

// ─────────────────────────────────────────────────────────────────────────────
// The port, the URL, and the process this file owns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The loopback port the text server answers on. ONE place, and the launcher's
 * own default (`VLLM_TEXT_PORT:-8300`, electron/scripts/vllm/serve_text_vllm.sh)
 * agrees with it — `tools/test-text-server.js` reads the script and asserts that,
 * because two spellings of a port is a server nobody can find.
 *
 * 8300 is clear of everything else that serves on this machine: Higgs on 8095
 * (vllm-omni) and 8200 (SGLang-Omni), BookForge's page reader on 8077, Foundry's
 * own reading server on 8000, ollama on 11434.
 */
export const TEXT_SERVER_PORT = 8300;

/** What Foundry is handed as `--endpoint`. `/v1` is the OpenAI-compatible prefix. */
export const TEXT_SERVER_URL = `http://localhost:${TEXT_SERVER_PORT}/v1`;

/**
 * The command line of a text server serving `servedName`, as a regex SOURCE —
 * what a STOP matches, and nothing wider.
 *
 * THREE THINGS ARE IN IT, and each one is a server this must NOT kill:
 *
 *   · `[v]llm` rather than `vllm`. MEASURED 2026-09-08: a
 *     `bash -lc 'pkill -f "vllm.entrypoints…"'` matches its OWN shell's command
 *     line and kills itself before it ever reaches the server. `wslPkillGraceful`
 *     cannot hit that — it runs `pgrep -af` under `wsl.exe --exec` (no shell at
 *     all) and then `kill -TERM` on the explicit pids it got back, precisely so a
 *     pattern cannot re-match anything in the guest. The bracket costs one
 *     character and holds wherever else this string travels.
 *   · THE SERVED NAME, which is what keeps "never stop somebody else's server"
 *     true even in the race this file's own start-time check exists for: if
 *     another server takes port 8300 while ours is coming up, our start fails —
 *     and the teardown of OUR spawn must not take THEIRS with it. A server
 *     started for a different model does not match.
 *   · THE PORT, so a hand-started vLLM elsewhere — the user's own, or the page
 *     reader on 8077 — is never in scope at all.
 */
export function textServerProcessPattern(servedName: string): string {
  return `[v]llm\\.entrypoints\\.openai\\.api_server.*--served-model-name `
    + `${servedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*--port ${TEXT_SERVER_PORT}`;
}

/**
 * The same process, WITHOUT the port, for the one caller that reads it out of
 * `ps -eo args` rather than `pgrep` — `parallel-tts-bridge`'s global orphan
 * sweep, whose pattern is `narrator\.compat\.(worker|app)|vllm` and would
 * otherwise SIGTERM this server as an orphaned vLLM.
 *
 * `wslPkillGraceful`'s `excludeRe` is tested against `ps` output, and `ps`
 * TRUNCATES long command lines where pgrep does not (wsl-lifecycle.ts says so in
 * `matchingPids`). `--port 8300` sits at the END of this server's argv, so a
 * truncated row would fail an exclusion that demanded it — and failing an
 * exclusion means SIGTERMing the thing the exclusion exists to protect. Erring
 * wide is the safe direction for a protection.
 */
export const TEXT_SERVER_PROTECT_RE = '[v]llm\\.entrypoints\\.openai\\.api_server';

/** The arbiter owner label. Distinct from every TTS owner, so we are sequenced. */
export const GPU_OWNER_TEXT = 'vllm:text';

/**
 * The whole start budget. Generous against the measured 110 s because a FIRST
 * start on a cold page cache, or with another process still handing back VRAM, is
 * legitimately slower — and the fatal-line scan is what keeps a genuinely broken
 * start from actually costing this long.
 */
const STARTUP_TIMEOUT_MS = 10 * 60_000;

/** How long the guest gets to release the CUDA device after SIGTERM. Measured: a few seconds. */
const SHUTDOWN_GRACE_MS = 60_000;

/** Lines kept for a failure that has to explain itself. */
const LOG_CAP = 400;

/** A stage's ceiling. 21 GB over a slow line is hours; a wedge is not. */
const STAGE_TIMEOUT_MS = 6 * 60 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// The profiles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE MODEL, SERVED ONE WAY — everything a start needs and nothing a caller
 * decides.
 *
 * `servedName` IS THE RECORD, not decoration. Foundry (19f5e70) resolves the
 * model by asking `/v1/models` and writes THAT id into the bank key, the records
 * key and the narration stamp. It carries no separate precision field, because a
 * server cannot report its dtype — so the served name must SAY the dtype, or two
 * books cleaned at two precisions are byte-indistinguishable in their records.
 *
 * AND THE SERVED NAME MUST STILL LOOK LIKE A QWEN 3. Foundry's `takesThinkField`
 * (foundry src/translate/ollama.ts) is `/^qwen3(\.|:|-|$)/i` over the last path
 * segment of the served name, and it is what puts
 * `chat_template_kwargs.enable_thinking=false` on the request. A name that fails
 * that test does not disable thinking, and the model reasons before every block
 * of the book — minutes of GPU per block, on a pass that asks temperature 0 for a
 * rewrite. `assertProfileTable()` below holds it, and so does the keeper.
 *
 * `modelDir` is relative to the GUEST'S HOME, the only root true on every WSL
 * install; the launcher is handed `"$HOME/<modelDir>"` and expands it itself.
 *
 * `hfRevision` IS PINNED. `main` moves, and a repo that moved under a book is a
 * records key that means two different models on two different days.
 */
export interface TextModelProfile {
  id: string;
  /** `--served-model-name`, and therefore what every Foundry record says. */
  servedName: string;
  /** Weights directory, relative to the guest's `$HOME`. */
  modelDir: string;
  /** Where the weights come from when they are not staged. */
  hfRepo: string;
  /** The commit staged, pinned — never `main`. */
  hfRevision: string;
  /** Roughly what the download weighs, for the sentence before it starts. */
  approxGB: number;
  /** `--dtype`. */
  dtype: string;
  /** `--max-num-seqs`. */
  maxNumSeqs: number;
  /** `--max-model-len`. */
  maxModelLen: number;
  /** `--gpu-memory-utilization`. */
  gpuMemUtil: number;
  /**
   * `--mamba-cache-dtype` / `--kv-cache-dtype` — THE DEPTH KNOBS, per profile.
   *
   * Both Qwen 3.5 and Qwen 3.8 are HYBRID: three of every four layers are Gated
   * DeltaNet with a FIXED recurrent state per sequence (~50 MB on the 9B, ~148 MB
   * on the 27B at fp32), one in four is full attention with a tiny KV. vLLM pads
   * the attention page to the state's size, so a sequence costs pages of ~1,600
   * tokens — which is why the measured pool of 3.3 GB held only 22,420 tokens and
   * admitted 7 requests. Halving the STATE dtype is what buys depth; the KV dtype
   * buys almost nothing here. `auto` is vLLM's own default and is what both
   * profiles run today (docs/TEXT-SERVER.md, "Open items": 12-16 in flight).
   */
  mambaCacheDtype: string;
  kvCacheDtype: string;
  /** What this profile is FOR, for the log line and the docs table. */
  purpose: string;
}

/**
 * THE PROFILE TABLE.
 *
 * Owen's plan (2026-09-08, through Foundry): the cleanup stays a 9B at 16 bits —
 * measured 2026-09-08, the 27b Foundry's language dialogs open with walks a book
 * at ~9 blocks/min against ~50 on the 9b — while translate, simplify and analyse
 * want the 27B's judgement and can afford 4-bit weights for it.
 *
 * The 9B is already on this PC at `~/models/Qwen3.5-9B` (staged by hand before
 * this file existed); the 27B stages itself on first use.
 */
export const TEXT_MODEL_PROFILES: Readonly<Record<string, TextModelProfile>> = Object.freeze({
  'qwen35-9b-bf16': Object.freeze({
    id: 'qwen35-9b-bf16',
    servedName: 'Qwen3.5-9B-bf16',
    modelDir: 'models/Qwen3.5-9B',
    hfRepo: 'Qwen/Qwen3.5-9B',
    // The repo's own `sha` at 2026-09-08, from
    // `GET https://huggingface.co/api/models/Qwen/Qwen3.5-9B`. It is the commit
    // the copy already on this machine came from.
    hfRevision: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a',
    approxGB: 19,
    dtype: 'bfloat16',
    // Foundry's pool sends 4 today (`--concurrency 4`); the server admits more so
    // a wider pool needs no server change. MEASURED at util 0.90 on this 24.5 GB
    // card: 7 in flight, 3 more queued for KV capacity — the ceiling is the cache,
    // not this number.
    maxNumSeqs: 16,
    // Foundry pins num_ctx 12288 on Ollama (its longest system prompt + block +
    // answer); 16384 covers that with headroom. Prefix caching makes the shared
    // ~6 kB system prompt cost one prefill for the whole book.
    maxModelLen: 16_384,
    // MEASURED on the first run (Pokemon, 2026-09-08): 18.26 GiB of weights and
    // a cache pool of 22,420 tokens at 0.90 of this 24.5 GB card.
    gpuMemUtil: 0.90,
    mambaCacheDtype: 'auto',
    kvCacheDtype: 'auto',
    purpose: 'the narration cleanup — every block of the book, temperature 0',
  }),
  'qwen38-27b-awq-int4': Object.freeze({
    id: 'qwen38-27b-awq-int4',
    // The REPO'S capitalisation, exactly, and the precision said out loud. It
    // also passes Foundry's `^qwen3[.:-]` think-field test — see the interface's
    // docblock; a served name that failed it would make the model reason before
    // every block.
    servedName: 'Qwen3.8-27B-AWQ-INT4',
    modelDir: 'models/Qwen3.8-27B-AWQ-INT4',
    hfRepo: 'cyankiwi/Qwen3.8-27B-AWQ-INT4',
    // The repo's own `sha` at 2026-09-08, from
    // `GET https://huggingface.co/api/models/cyankiwi/Qwen3.8-27B-AWQ-INT4`
    // (lastModified 2026-08-15). compressed-tensors pack-quantized, 4 bits.
    hfRevision: '63768c10df38c0395e12ef49edac1bd539eaeeea',
    approxGB: 21,
    // `auto`, not bfloat16: the weights are compressed-tensors INT4 and vLLM
    // picks the activation dtype from the quantization config. Naming a dtype
    // here would be this file having an opinion about somebody else's checkpoint.
    dtype: 'auto',
    maxNumSeqs: 16,
    maxModelLen: 16_384,
    // UNMEASURED for this model. The weights are 20 GB across five shards
    // (staged on this PC 2026-09-08), so a 24.5 GB card at 0.90 leaves a much
    // thinner cache pool than the 9B's 3.3 GB — this number and the two cache
    // dtypes below are the first things to revisit once a translation has run.
    // See docs/TEXT-SERVER.md, "Open items".
    gpuMemUtil: 0.90,
    mambaCacheDtype: 'auto',
    kvCacheDtype: 'auto',
    purpose: 'translate, simplify and analyse — the 27B Owen ruled the standard for all three',
  }),
});

/** The language acts. `analysis` is Foundry's own kind; see `profileForKind`. */
export type TextPassKind = 'clean' | 'translate' | 'simplify' | 'analysis';

/**
 * Which model a language act runs on.
 *
 * A CLEANUP IS NOT A TRANSLATION AND THE 9B IS NOT A SUBSTITUTE FOR THE 27B.
 * That is the whole reason this is a function and not a constant: the caller
 * asserts the served name onto the request before Foundry runs it, so a
 * translation can never end up recorded against the cleanup's model.
 *
 * `analysis` is here because it is the third act Owen named, not because it
 * arrives yet: no `analysis` row crosses the host queue today (`FoundryJobKind`,
 * electron/foundry-host-queue.ts, is `epub|txt|pdf|read|translate|simplify|clean`),
 * so Foundry runs it in its own queue. When it does cross, it joins the 27B row
 * it already belongs to rather than needing a decision that day.
 */
export function profileForKind(kind: TextPassKind): TextModelProfile {
  switch (kind) {
    case 'clean':
      return TEXT_MODEL_PROFILES['qwen35-9b-bf16']!;
    case 'translate':
    case 'simplify':
    case 'analysis':
      return TEXT_MODEL_PROFILES['qwen38-27b-awq-int4']!;
    default: {
      const said: string = kind;
      throw new Error(
        `"${said}" is not a language act this arbiter has a model for. The four are clean, `
        + 'translate, simplify and analysis (electron/text-server.ts, profileForKind).');
    }
  }
}

/**
 * THE MODEL A REQUEST MUST NAME, asserted rather than hoped for.
 *
 * Owen, 2026-09-08: *"verify that when i run translate/simplify in foundry, they
 * will correctly use the 27b model in vllm and not the 9b."* Foundry's own guard
 * is its `/v1/models` proof — it asks the server what it serves and refuses a
 * mismatch — but that proof happens INSIDE the engine, after the spawn, and only
 * when the request named a model at all: `vllmModel` is EMPTY by default and
 * means "whatever it is serving", which is exactly the case where a translation
 * pointed at a 9B server would run and be recorded as a translation.
 *
 * So the host asserts first. Given the model a request carries and the profile
 * the act resolved to, this answers with the model the request must be given —
 * and throws by name when the request asks for something else. Two belts: with
 * the wrong model in Settings it refuses here, and with the wrong server on the
 * port it refuses at Foundry's proof.
 */
export function servedModelForRequest(
  requested: unknown,
  profile: TextModelProfile,
  act: string,
): string {
  const said = typeof requested === 'string' ? requested.trim() : '';
  if (said.length === 0) return profile.servedName;
  if (said === profile.servedName) return said;
  throw new Error(
    `This ${act} asks for "${said}", but this machine's ${act} profile serves `
    + `${profile.servedName} (electron/text-server.ts, ${profile.id}). A ${act} recorded against a `
    + 'model that did not do it is worse than one that did not run, so nothing was started. Clear '
    + 'or correct the served-model field in Foundry\'s Settings → Language model, or change the '
    + 'profile.');
}

/**
 * The table's own invariants, checked once at import.
 *
 * Every one of these is a silent wrongness rather than a crash if it drifts —
 * a served name that stops matching Foundry's think-field test costs minutes of
 * GPU per block and nothing says why — so they are asserted where they are
 * written rather than left to a keeper alone.
 */
function assertProfileTable(): void {
  const qwen3 = /^qwen3(\.|:|-|$)/i;
  for (const [id, profile] of Object.entries(TEXT_MODEL_PROFILES)) {
    if (profile.id !== id) {
      throw new Error(`Text profile "${id}" carries the id "${profile.id}".`);
    }
    if (!qwen3.test(profile.servedName)) {
      throw new Error(
        `Text profile "${id}" serves "${profile.servedName}", which fails Foundry's `
        + '`takesThinkField` test (/^qwen3[.:-]/i). Foundry would not send '
        + 'chat_template_kwargs.enable_thinking=false, and the model would reason before every '
        + 'block of every book.');
    }
    if (!/^[0-9a-f]{40}$/.test(profile.hfRevision)) {
      throw new Error(
        `Text profile "${id}" pins revision "${profile.hfRevision}", which is not a commit sha. `
        + '`main` moves, and a repo that moved under a book is a records key that means two '
        + 'different models on two different days.');
    }
  }
}
assertProfileTable();

// ─────────────────────────────────────────────────────────────────────────────
// Which endpoints are ours to start
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this the local server this module manages?
 *
 * Foundry's `isLocalVllmEndpoint` (foundry-app/electron/vllm-server.ts), same
 * shape and same reason: a remote endpoint — a vLLM on another machine, a hosted
 * OpenAI-compatible service — is used EXACTLY AS GIVEN and never started, never
 * stopped. Starting twenty gigabytes of local server because a job named a remote
 * one is a card burned for nothing.
 *
 * The PATH is not compared, only the host and the port, because `/v1` and `/v1/`
 * name the same server and a settings field is typed by a person.
 */
export function isLocalTextServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return LOOPBACK.has(parsed.hostname) && port === String(TEXT_SERVER_PORT);
  } catch {
    return false;
  }
}

/**
 * What a caller should DO about the endpoint its settings named.
 *
 * Three answers, and the middle one catches this machine's most likely mistake:
 * Foundry's declared default `vllmUrl` is `http://localhost:8000/v1` (their
 * `DEFAULT_VLLM_TEXT_ENDPOINT`), and 8000 is FOUNDRY'S OWN READING SERVER, which
 * serves dots.ocr. A text pass pointed there would be handed a vision model.
 * Nothing here starts or stops it — that is the foreign-server rule — but the
 * caller gets a sentence it can put on the row instead of a 404 an hour later.
 */
export type TextServerRoute =
  /** Ours: start it, stop it, swap it. */
  | { manage: true; note: null }
  /** Somebody else's — and `note` says WHOSE, in a sentence fit for a queue row. */
  | { manage: false; note: string };

export function textServerRoute(url: string): TextServerRoute {
  if (isLocalTextServerUrl(url)) return { manage: true, note: null };
  let loopback = false;
  try {
    loopback = LOOPBACK.has(new URL(url.trim()).hostname);
  } catch {
    loopback = false;
  }
  if (!loopback) {
    return {
      manage: false,
      note: `${url} is not this machine's text server, so BookForge starts and stops nothing for `
        + 'this run — the endpoint is used exactly as it was given.',
    };
  }
  return {
    manage: false,
    note: `${url} is a local server on a port BookForge does not manage (its text server is `
      + `${TEXT_SERVER_URL}). It is used as given and never started or stopped. If this was meant `
      + `to be BookForge's own, set the vLLM URL to ${TEXT_SERVER_URL} in Foundry's Settings → `
      + 'Language model; port 8000 is the READING server and serves a vision model.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The fatal-line scan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log lines that mean this server is never going to be ready.
 *
 * Each is a thing vLLM (or the launcher) says and then SITS there for, which is
 * the whole reason the list exists: without it every one of them costs the full
 * start budget before the job is told anything.
 */
const FATAL_PATTERNS: readonly { pattern: RegExp; meaning: string }[] = [
  {
    pattern: /CUDA out of memory|torch\.OutOfMemoryError|No available memory for the cache blocks/i,
    meaning: 'the GPU does not have enough free memory for the model',
  },
  {
    // MEASURED on this PC's first start, 2026-09-08: the engine core died in the
    // sampler warm-up with "Could not find nvcc and default
    // cuda_home='/usr/local/cuda' doesn't exist" — the model had already loaded
    // (16.8 GiB) and the failure came ninety seconds later. The launcher now
    // exports CUDA_HOME at the wheel's own toolkit and refuses when nvcc is not
    // there, so this pattern is the backstop for a launcher somebody edited.
    pattern: /Could not find nvcc|No nvcc at /,
    meaning: "the environment's CUDA toolkit is missing, and vLLM's sampler warm-up needs nvcc",
  },
  { pattern: /ValidationError/, meaning: 'vLLM rejected the model configuration' },
  { pattern: /ModuleNotFoundError|No module named/, meaning: 'something is missing from the environment' },
  {
    pattern: /Address already in use|error while attempting to bind on address/i,
    meaning: `something else already holds port ${TEXT_SERVER_PORT}`,
  },
  {
    pattern: /does not appear to have a file named config\.json|Repository Not Found|401 Client Error/i,
    meaning: 'the weights directory is not a model vLLM can load',
  },
];

/**
 * vLLM's own INFO and WARNING lines, which are never a reason to give up.
 *
 * Load-bearing, not tidiness — Foundry's vllm-server.ts learned it the hard way:
 * a HEALTHY vLLM prints `WARNING … Failed to import from vllm._C with
 * ModuleNotFoundError(…)` during a start that goes on to succeed. Scanning it
 * would fail a working server in the first ten seconds and report a missing
 * module that is not missing.
 */
const CHATTER = /^(INFO|WARNING|DEBUG)\b/;

/** One log line -> why this server will never be ready, or null. Pure, so it is testable. */
export function textServerFatalReason(line: string): string | null {
  if (CHATTER.test(line.trim())) return null;
  for (const { pattern, meaning } of FATAL_PATTERNS) {
    if (pattern.test(line)) return meaning;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seams a keeper drives
// ─────────────────────────────────────────────────────────────────────────────

/** Bytes fetched so far and what the whole snapshot weighs (0 = the API would not say). */
export interface StageProgress {
  bytes: number;
  total: number;
}

/**
 * Everything this module reaches OUTSIDE itself, in one object.
 *
 * `queue-engine.ts`'s `setGpuHolderProbe` precedent: a lifetime manager whose
 * every branch needs a GPU, a WSL VM and twenty gigabytes of weights is a
 * lifetime manager nobody tests, and the branches that matter here — adopting,
 * refusing a foreign server, failing fast on a log line, swapping a profile,
 * staging weights — are exactly the ones no machine reproduces on demand. So they
 * are injected, and `tools/test-text-server.js` drives every one without a card.
 *
 * The defaults ARE the production implementations; nothing here is a stand-in
 * that could be left switched on.
 */
export interface TextServerDeps {
  spawn: typeof spawn;
  /** `GET <url>/models` -> did it answer, and with which ids. */
  askModelList: (url: string) => Promise<{ up: boolean; ids: string[] }>;
  /** The house's graceful in-guest kill. Never SIGKILL. */
  pkill: (pattern: string, opts?: WslPkillOptions) => Promise<WslPkillOutcome>;
  acquireGpu: typeof acquireGpu;
  releaseGpu: typeof releaseGpu;
  /** The external-GPU-job lock's description, or null. */
  gpuLock: () => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The distro the guest lives in. */
  distro: () => string | undefined;
  /** `<conda root>/envs/<name>` inside the guest — the env holding vllm. */
  condaEnvPrefix: () => string;
  /** The launcher's HOST path. Refuses by name when the checkout has none. */
  scriptPath: () => string;
  /** Are this profile's weights on the guest's disk? */
  isStaged: (profile: TextModelProfile) => Promise<boolean>;
  /** Download them. Throws with the real reason when it cannot. */
  stage: (profile: TextModelProfile, onProgress: (p: StageProgress) => void) => Promise<void>;
  /** Every line the guest says, for `<userData>/logs/text-server.log`. */
  record: (line: string) => void;
}

/** `GET <url>/models`, the real one. */
async function askModelListOverHttp(url: string): Promise<{ up: boolean; ids: string[] }> {
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { up: false, ids: [] };
    const body = await res.json() as { data?: { id?: string }[] };
    const ids = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return { up: true, ids };
  } catch {
    return { up: false, ids: [] };
  }
}

/**
 * A script beside the compiled main process, across dev and packaged layouts.
 * `denoise-bridge`'s three candidates exactly — the app path, the dist-relative
 * walk-up, and a co-located copy.
 */
function resolveVllmScript(name: string): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'vllm', name),
    path.join(__dirname, 'scripts', 'vllm', name),
  ];
  try {
    // `app` is absent in the CLI harness and in a keeper, and the two candidates
    // above already cover both. Required lazily so this module stays loadable
    // there.
    const { app } = require('electron') as typeof import('electron');
    candidates.unshift(path.join(app.getAppPath(), 'electron', 'scripts', 'vllm', name));
  } catch {
    /* no Electron here; the relative candidates are the answer */
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `The text server's ${name} is not in this build: none of ${candidates.join(', ')} exists. It `
    + 'is electron/scripts/vllm/ in the checkout, and build:electron must copy that folder beside '
    + 'the compiled main process.');
}

/** Single-quote for bash. Nothing below is user input, but the quoting is not optional. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * IS THIS MODEL ON THE GUEST'S DISK?
 *
 * `config.json` plus at least one `*.safetensors` shard, AND no `.incomplete`
 * blob left behind by an interrupted `snapshot_download`. That last clause is
 * what makes the answer honest: a stage killed halfway has a config and some
 * shards, and calling it staged would start a server against a model missing its
 * tail — an opaque vLLM failure ten minutes later instead of a download that
 * resumes.
 *
 * A DIRECTORY SOMEBODY STAGED BY HAND IS ACCEPTED, and that is a decision rather
 * than an oversight: `~/models/Qwen3.5-9B` on this PC was downloaded before this
 * file existed, and re-fetching nineteen gigabytes to earn a marker of our own
 * would be an act of bookkeeping. The pinned revision governs what WE fetch; a
 * hand-staged directory is the user's own statement about their machine.
 */
async function isStagedInGuest(profile: TextModelProfile): Promise<boolean> {
  const dir = `"$HOME/${profile.modelDir}"`;
  const condition = [
    `test -f ${dir}/config.json`,
    `ls ${dir}/*.safetensors >/dev/null 2>&1`,
    `[ -z "$(find ${dir}/.cache -name '*.incomplete' -print -quit 2>/dev/null)" ]`,
  ].join(' && ');
  const res = await execWsl(wslScriptArgs(getWslDistro(), condition), 20_000);
  return !res.timedOut && res.code === 0;
}

/**
 * Download a profile's weights into the guest's ext4, streaming the gigabytes
 * back as they land.
 *
 * INSIDE WSL, ON ext4, NEVER /mnt — `higgs-hf-install`'s rule for the same
 * reason: the 9p mount is slow and the server never reads the Windows side.
 * Through the conda env that holds vllm, which is also the env that holds
 * huggingface_hub.
 *
 * RESUMABLE by construction (`snapshot_download` continues from its own partial
 * blobs), so the honest response to a failure is to say what happened and let the
 * next attempt continue — nothing is deleted here.
 */
function stageInGuest(
  profile: TextModelProfile,
  onProgress: (p: StageProgress) => void,
): Promise<void> {
  const script = windowsToWslPath(resolveVllmScript('text_model_download.py'));
  const envPrefix = requireCondaEnvPrefix();
  /*
   * THE HOUSE'S ONE TOKEN READER, required LAZILY — and the laziness is
   * load-bearing rather than tidiness. `orpheus-hf-catalog` reaches
   * `update/managed-bins`, which resolves the userData directory AT MODULE SCOPE
   * and throws when there is no Electron app; importing it at the top of this file
   * made `tools/test-foundry-host-queue.js` — which drives the real queue step
   * under bare node — die on the import rather than on anything it tests.
   * Required here, it is only reached by a real stage inside a real app.
   */
  const { getHfToken } = require('./orpheus-hf-catalog') as typeof import('./orpheus-hf-catalog');
  const token = getHfToken();
  const bash = [
    // The token never appears on argv — higgs_download.py's rule. Both text repos
    // are public today; this is what makes a private mirror work without a change.
    ...(token === null ? [] : [`export HF_TOKEN=${quote(token)}`]),
    `mkdir -p "$HOME/${path.posix.dirname(profile.modelDir)}"`,
    `${quote(`${envPrefix}/bin/python`)} -u ${quote(script)} ${quote(profile.hfRepo)} `
      + `${quote(profile.hfRevision)} "$HOME/${profile.modelDir}"`,
  ].join(' && ');

  return new Promise<void>((resolve, reject) => {
    const args = wslScriptArgs(getWslDistro(), bash);
    const child = deps.spawn('wsl.exe', args, { windowsHide: true });
    let stderrTail = '';
    let settled = false;
    let failure: string | null = null;
    let succeeded = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(
        `Staging ${profile.hfRepo} did not finish within `
        + `${Math.round(STAGE_TIMEOUT_MS / 3_600_000)} hours. The partial download is kept, so `
        + 'running this again continues from where it stopped.'));
    }, STAGE_TIMEOUT_MS);

    let pending = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (text.length === 0) continue;
        let parsed: { progress?: StageProgress; ok?: boolean; error?: string };
        try {
          parsed = JSON.parse(text);
        } catch {
          deps.record(`[stage] ${text}`);
          continue;
        }
        if (parsed.progress !== undefined) { onProgress(parsed.progress); continue; }
        if (parsed.ok === true) { succeeded = true; continue; }
        if (parsed.ok === false) { failure = parsed.error ?? 'the download said nothing'; }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2_000);
      deps.record(`[stage] ${text.trimEnd()}`);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (succeeded && failure === null) { resolve(); return; }
      reject(new Error(
        `Downloading ${profile.hfRepo} (revision ${profile.hfRevision}) into `
        + `~/${profile.modelDir} failed: `
        + `${failure ?? (stderrTail.trim().slice(-600) || 'it said nothing')}. `
        + 'Whatever landed is kept, so running this again continues from where it stopped.'));
    });
  });
}

/**
 * `<conda root>/envs/<higgs env>` in the guest, refusing the unconfigured
 * placeholder by name.
 *
 * `getWslCondaPath()`'s standing default is the literal
 * `/home/$USER/miniconda3/bin/conda`. Expanding it here would be inventing a path
 * for a machine nobody configured; refusing names the setting instead.
 */
function requireCondaEnvPrefix(): string {
  const prefix = deps.condaEnvPrefix();
  if (prefix.includes('$')) {
    throw new Error(
      `The WSL conda path is not configured — it is still the placeholder ${getWslCondaPath()}. `
      + 'Set it in Settings → Add-ons so BookForge knows where the environment holding vllm lives. '
      + 'Nothing was started.');
  }
  return prefix;
}

/**
 * `<userData>/logs/text-server.log`, through the house's own rolling logger
 * rather than a second write stream — it rotates at 2 MB, and a serving vLLM
 * logs every request.
 *
 * Lazy, because constructing it reads APPDATA and a keeper must be able to inject
 * past it before anything touches the machine's real log folder.
 */
let fileLog: RollingLogger | null = null;
function recordToFile(line: string): void {
  if (fileLog === null) fileLog = new RollingLogger({ name: 'text-server', consoleOutput: false });
  fileLog.info(line);
}

const REAL_DEPS: TextServerDeps = {
  spawn,
  askModelList: askModelListOverHttp,
  pkill: wslPkillGraceful,
  acquireGpu,
  releaseGpu,
  gpuLock: externalGpuJobLock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  distro: getWslDistro,
  condaEnvPrefix: () => wslCondaEnvPrefix(getWslCondaPath(), getWslHiggsCondaEnv()),
  scriptPath: () => resolveVllmScript('serve_text_vllm.sh'),
  isStaged: isStagedInGuest,
  stage: stageInGuest,
  record: recordToFile,
};

let deps: TextServerDeps = { ...REAL_DEPS };

/** For the keeper suite: replace some of what this module reaches for. */
export function setTextServerDeps(patch: Partial<TextServerDeps>): void {
  deps = { ...deps, ...patch };
}

/** For the keeper suite: put the real world back, and forget any running server. */
export function resetTextServerState(): void {
  deps = { ...REAL_DEPS };
  server = null;
  starting = null;
  pending = null;
  stopping = null;
  if (idleStop !== null) {
    clearTimeout(idleStop);
    idleStop = null;
  }
  adopted = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface RunningTextServer {
  proc: ChildProcess;
  profile: TextModelProfile;
  log: string[];
  /** Set by the log scan the moment the guest says something unrecoverable. */
  fatal: string | null;
  exited: { code: number | null; signal: string | null } | null;
  ready: boolean;
}

let server: RunningTextServer | null = null;
/** In-flight spawn. Reported by `textServerStatus`; the SHARING is `pending`. */
let starting: Promise<RunningTextServer> | null = null;
/**
 * The in-flight `ensureTextServer`, and the profile it is for.
 *
 * Assigned SYNCHRONOUSLY, before anything awaits — see `ensureTextServer`. This
 * is what makes two passes beginning in the same tick share one spawn instead of
 * putting two vLLMs on one port.
 */
let pending: { profileId: string; promise: Promise<TextServerHandle> } | null = null;
/**
 * In-flight shutdown, so a pass arriving mid-teardown waits for the VRAM, the
 * arbiter and the port to come back instead of racing them.
 */
let stopping: Promise<void> | null = null;
/**
 * A server on our port that we did NOT start, and the name it serves. Used,
 * never owned: not stopped on drain, not stopped by a yield, not restarted.
 */
let adopted: { servedName: string } | null = null;

/** The pending stop, while a drained queue's keep-warm window runs out. */
let idleStop: NodeJS.Timeout | null = null;

function logTail(entry: RunningTextServer, lines = 14): string {
  return entry.log.slice(-lines).join('\n').trim();
}

/**
 * The server's recent lines, for a pass that failed AFTER it came up.
 *
 * `vlm-page-server.recentServerLog`'s reason, unchanged: a mid-run engine-core
 * death prints its stack trace into this stream and nowhere else — the API stays
 * up answering 500s whose body says "see stack trace (above)" — so without this
 * the actual cause dies with the process and the failure reads as an exit code.
 */
export function recentTextServerLog(lines = 60): string {
  return server === null ? '' : logTail(server, lines);
}

/** What is up, if anything. For the log line on a row and for the settings UI. */
export function textServerStatus(): {
  running: boolean;
  starting: boolean;
  adopted: boolean;
  url: string;
  profileId: string | null;
  servedName: string | null;
} {
  return {
    running: (server !== null && server.ready) || adopted !== null,
    starting: starting !== null,
    adopted: adopted !== null,
    url: TEXT_SERVER_URL,
    profileId: server?.profile.id ?? null,
    servedName: server?.profile.servedName ?? adopted?.servedName ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The launch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `wsl.exe` argv for one profile — the ONE place it is composed, so a start
 * and its log line can never describe different commands.
 *
 * `wslScriptArgs` (tool-paths.ts) builds it, and its `--exec` is the whole reason
 * it exists: MEASURED on owens-pc 2026-09-05, without `--exec` wsl.exe hands the
 * string to the distro's DEFAULT SHELL first, which expands every `$` before bash
 * ever sees it. This command line deliberately contains `"$HOME/<modelDir>"` for
 * the guest's bash to expand, and an outer shell would expand it to nothing and
 * start the server against a directory called `/models/Qwen3.5-9B`.
 */
export function buildTextServerCommand(profile: TextModelProfile): {
  file: string;
  args: string[];
  describe: string;
} {
  const envPrefix = requireCondaEnvPrefix();
  const script = windowsToWslPath(deps.scriptPath());
  const env: Array<[string, string]> = [
    ['VLLM_TEXT_ENV', quote(envPrefix)],
    // Double-quoted so the GUEST's bash expands $HOME; the profile stores the
    // path relative to the guest home for exactly this.
    ['VLLM_TEXT_MODEL_DIR', `"$HOME/${profile.modelDir}"`],
    ['VLLM_TEXT_MODEL_NAME', quote(profile.servedName)],
    ['VLLM_TEXT_PORT', quote(String(TEXT_SERVER_PORT))],
    ['VLLM_TEXT_DTYPE', quote(profile.dtype)],
    ['VLLM_TEXT_MAX_NUM_SEQS', quote(String(profile.maxNumSeqs))],
    ['VLLM_TEXT_MAX_MODEL_LEN', quote(String(profile.maxModelLen))],
    ['VLLM_TEXT_GPU_MEM_UTIL', quote(String(profile.gpuMemUtil))],
    ['VLLM_TEXT_MAMBA_CACHE_DTYPE', quote(profile.mambaCacheDtype)],
    ['VLLM_TEXT_KV_CACHE_DTYPE', quote(profile.kvCacheDtype)],
  ];
  const command = `${env.map(([k, v]) => `${k}=${v}`).join(' ')} bash ${quote(script)}`;
  const args = wslScriptArgs(deps.distro(), command);
  return { file: 'wsl.exe', args, describe: `wsl.exe ${args.slice(0, -1).join(' ')} ${quote(command)}` };
}

/** "4.2 / 21.0 GB", or "4.2 GB" when the repo would not say what it weighs. */
function stageLine(profile: TextModelProfile, p: StageProgress): string {
  const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);
  return p.total > 0
    ? `Downloading ${profile.servedName} (${gb(p.bytes)} / ${gb(p.total)} GB)…`
    : `Downloading ${profile.servedName} (${gb(p.bytes)} GB so far)…`;
}

/**
 * Stage the weights if they are not there. Owen's ruling of 2026-09-08: an
 * absent profile SWITCHES ITSELF ON rather than failing.
 *
 * It happens BEFORE the GPU is taken, deliberately: a 21 GB download is minutes
 * to hours, and holding the card through it would block every render for a
 * network transfer that does not touch the GPU at all.
 */
async function ensureStaged(profile: TextModelProfile, say: (line: string) => void): Promise<void> {
  if (await deps.isStaged(profile)) return;
  say(
    `Downloading ${profile.servedName} (about ${profile.approxGB} GB) — ${profile.hfRepo} at `
    + `${profile.hfRevision.slice(0, 12)}. This runs once.`);
  console.log(`[text-server] staging ${profile.hfRepo}@${profile.hfRevision} -> ~/${profile.modelDir}`);
  let lastSaid = 0;
  await deps.stage(profile, (p) => {
    // One line every few seconds, not one per tick: the row is a progress note,
    // not a transcript.
    const now = deps.now();
    if (now - lastSaid < 3_000) return;
    lastSaid = now;
    say(stageLine(profile, p));
  });
  if (!await deps.isStaged(profile)) {
    throw new Error(
      `${profile.hfRepo} reported a finished download into ~/${profile.modelDir}, and that `
      + 'directory still has no config.json with *.safetensors beside it. Nothing was started.');
  }
  say(`${profile.servedName} is staged.`);
}

/**
 * Spawn the server for `profile` and wait until it answers with that profile's
 * served name, or throw naming what went wrong with the guest's own tail.
 *
 * The GPU is acquired BEFORE the spawn and released only when the server stops,
 * so a render cannot arrive between the reservation and the first block.
 */
async function startServer(
  profile: TextModelProfile,
  say: (line: string) => void,
): Promise<RunningTextServer> {
  const lock = deps.gpuLock();
  if (lock !== null) {
    throw new Error(
      `Another GPU job owns the card — ${lock}. The text server reserves most of the card's VRAM, `
      + 'so it is not started while that lock exists. Remove the lock (or wait for that job to '
      + 'finish) and run this again.');
  }

  const { file, args, describe } = buildTextServerCommand(profile);

  // THE LOW-PRIORITY HOLD. `GPU_OWNER_LLAMA`'s posture in gpu-arbiter.ts: the
  // text server registers a yield and steps off the card when a render asks for
  // it. A text pass is minutes; a narration is hours and is what the card is for.
  await deps.acquireGpu(GPU_OWNER_TEXT, {
    onYield: () => { void stopTextServer('a render asked for the card'); },
    timeoutMs: 10 * 60_000,
  });

  let entry: RunningTextServer | null = null;
  try {
    say(`Starting the text server (${profile.servedName})…`);
    deps.record(`[text-server] ${describe}`);

    const proc = deps.spawn(file, args, { windowsHide: true });
    const record: RunningTextServer = { proc, profile, log: [], fatal: null, exited: null, ready: false };
    entry = record;

    const collect = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim().length === 0) continue;
        record.log.push(line);
        deps.record(line);
        if (record.fatal === null) record.fatal = textServerFatalReason(line);
      }
      // Bounded: this is a diagnostic tail, not a transcript.
      if (record.log.length > LOG_CAP) record.log.splice(0, record.log.length - LOG_CAP);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    proc.on('exit', (code, signal) => {
      record.exited = { code, signal };
      if (server === record) {
        console.warn(`[text-server] exited (code ${code}, signal ${signal})`);
        server = null;
        deps.releaseGpu(GPU_OWNER_TEXT);
      }
    });

    const deadline = deps.now() + STARTUP_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (record.exited !== null) {
        throw new Error(
          `The text server in WSL stopped before it was ready (exit ${record.exited.code}).\n`
          + logTail(record));
      }
      if (record.fatal !== null) {
        throw new Error(`The text server in WSL cannot start: ${record.fatal}.\n${logTail(record)}`);
      }
      const probe = await deps.askModelList(TEXT_SERVER_URL);
      if (probe.up) {
        // IT MUST BE OURS. The port answering is not the question — the question
        // is whether what answers is serving the name every Foundry record will
        // claim it was.
        if (!probe.ids.includes(profile.servedName)) {
          throw new Error(
            `A server answered on ${TEXT_SERVER_URL} while ours was starting, and it is serving `
            + `${probe.ids.join(', ') || 'nothing it will name'} rather than ${profile.servedName}. `
            + 'That server is somebody else\'s and was not touched.');
        }
        record.ready = true;
        say(`The text server is up (${profile.servedName}).`);
        console.log(`[text-server] ready — ${profile.servedName} on ${TEXT_SERVER_URL}`);
        return record;
      }
      await deps.sleep(2_000);
    }
    throw new Error(
      `The text server in WSL did not answer on ${TEXT_SERVER_URL} within `
      + `${Math.round(STARTUP_TIMEOUT_MS / 60_000)} minutes.\n${logTail(record)}`);
  } catch (err) {
    // Whatever failed, the reservation must not outlive it.
    if (entry !== null) await terminate(entry, 'the start failed');
    deps.releaseGpu(GPU_OWNER_TEXT);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stopping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bring the guest's server down the only way that is safe.
 *
 * `wslPkillGraceful` — the house's ONE graceful in-guest kill (wsl-lifecycle.ts).
 * It SIGTERMs and then VERIFIES the exit by polling, and it never escalates to
 * SIGKILL, because force-killing a process in a dxg GPU wait is what wedges the
 * WSL VM until a reboot. Measured 2026-09-08: this server exits within a few
 * seconds of SIGTERM.
 *
 * An 'alive' outcome is LOGGED AND LEFT, never escalated: `destroyWslGuestProcesses`
 * would terminate the whole distro, and a text pass is not worth taking a running
 * narration's VM with it.
 */
async function terminate(entry: RunningTextServer, reason: string): Promise<void> {
  console.log(`[text-server] stopping — ${reason}`);
  const outcome = await deps.pkill(textServerProcessPattern(entry.profile.servedName), {
    graceMs: SHUTDOWN_GRACE_MS,
    label: `text-server ${entry.profile.servedName}`,
  });
  if (outcome === 'alive' || outcome === 'unresponsive') {
    console.warn(
      `[text-server] ${outcome} after SIGTERM (${reason}) — leaving it rather than SIGKILLing a `
      + 'process that holds the CUDA device, and rather than terminating a VM that may be '
      + 'rendering. The next start refuses on the port instead of racing it.');
  }
}

function cancelIdleStop(): void {
  if (idleStop !== null) {
    clearTimeout(idleStop);
    idleStop = null;
  }
}

/**
 * Bring this server down now, and REMEMBER the teardown so a pass that arrives
 * mid-shutdown waits for the card instead of racing it.
 *
 * `vlm-page-server.stopNow`'s reason: without `stopping`, the next
 * `ensureTextServer` sees `server === null` and spawns immediately — a second
 * vLLM reserving the same VRAM while the first still holds it, on a port the
 * first has not let go of.
 */
function stopNow(entry: RunningTextServer, reason: string): void {
  // Not ours any more: a stop already ran, or the entry was replaced. Either way
  // whatever replaced it owns the shutdown.
  if (server !== entry) return;
  server = null;
  stopping = terminate(entry, reason).finally(() => {
    deps.releaseGpu(GPU_OWNER_TEXT);
    stopping = null;
  });
}

/**
 * Stop the text server, if one is ours. For a drain, for a yield, for app quit
 * and for the settings UI.
 *
 * A server this process merely FOUND on the port is left exactly alone and said
 * so — Foundry's rule for its reading server, and the reason is the same: killing
 * a thing this app did not start is how you lose someone else's work.
 */
export async function stopTextServer(reason = 'asked to stop'): Promise<void> {
  cancelIdleStop();
  if (adopted !== null) {
    console.log(
      `[text-server] ${reason}: the server on ${TEXT_SERVER_URL} was already running before `
      + 'BookForge wanted one, so it is left alone.');
    adopted = null;
    return;
  }
  const entry = server;
  if (entry === null) {
    // A teardown already in flight is still this call's answer: the caller asked
    // for the server to be down, and it is not down until that has finished.
    if (stopping !== null) await stopping;
    return;
  }
  stopNow(entry, reason);
  if (stopping !== null) await stopping;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drain semantics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A language act is about to need the server: whatever idle countdown was
 * running is over.
 *
 * Called BEFORE `ensureTextServer`, so a pass that arrives inside the keep-warm
 * window keeps the warm server instead of racing its stop.
 */
export function noteTextQueueBusy(): void {
  cancelIdleStop();
}

/**
 * The text work drained: stop the server BookForge started — immediately when
 * `keepWarmMinutes` is 0 (the default), otherwise once the window runs out.
 *
 * Foundry's own words for its reading server, and the same policy: *"an optional
 * keep-warm window delays the stop for someone feeding jobs one at a time by
 * hand; it is a window with a number on it, never 'stay up indefinitely'."*
 * The number comes from the CALLER, which reads `keepServerWarmMinutes` out of
 * app-settings.json — the same key, with the same meaning, as Foundry's
 * (foundry-app/electron/app-settings.ts: "minutes an app-started vLLM server
 * stays up after the queue drains", 0 = stop on drain, ceiling 240).
 *
 * The trade is measured on this machine: the server holds ~22 GB of a 24.5 GB
 * card, so every idle minute is a minute a queued narration cannot start, and
 * bringing it back costs ~110 s. Zero is the right default, and the window is for
 * a person doing several passes by hand.
 */
export function noteTextQueueIdle(keepWarmMinutes: number): void {
  cancelIdleStop();
  if (server === null) return;
  if (keepWarmMinutes <= 0) {
    void stopTextServer('the text queue is empty');
    return;
  }
  const entry = server;
  console.log(
    `[text-server] the text queue is empty — stopping in ${keepWarmMinutes} min unless another `
    + 'pass arrives.');
  idleStop = setTimeout(() => {
    idleStop = null;
    if (server === entry) {
      void stopTextServer(`the text queue has been empty for ${keepWarmMinutes} min`);
    }
  }, keepWarmMinutes * 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// The door
// ─────────────────────────────────────────────────────────────────────────────

export interface TextServerHandle {
  /** What Foundry is handed as `--endpoint`. */
  url: string;
  /** What it will record — the profile's served id. */
  servedName: string;
}

/**
 * The text server a language act should send its blocks to: staged if the weights
 * are missing, started if it is not up, swapped if the one that is up is the
 * wrong model.
 *
 * The order matters and each step is a refusal or a decision, never a guess:
 *
 *  1. an unknown profile id is a named throw;
 *  2. an in-flight start is JOINED (one spawn for two passes beginning together);
 *  3. a running server of ANOTHER profile is stopped first — the swap, ~95 s on
 *     this machine. Foundry's suggestion of draining by profile so a mixed queue
 *     swaps once rather than per row is a real optimisation and is NOT built:
 *     it belongs in the scheduler, not here (docs/TEXT-SERVER.md, "Open items");
 *  4. a server already answering with THIS profile's served name is ADOPTED —
 *     used exactly as it is, and never stopped by us;
 *  5. a server answering with any OTHER name is refused by name;
 *  6. weights that are not on disk are DOWNLOADED (Owen: "id rather it just
 *     switch to the correct profile rather than failing");
 *  7. and then it is started, under the GPU arbiter, with the log watched.
 */
export function ensureTextServer(
  profileId: string,
  say: (line: string) => void = () => { /* nothing is watching */ },
): Promise<TextServerHandle> {
  const profile = TEXT_MODEL_PROFILES[profileId];
  if (profile === undefined) {
    return Promise.reject(new Error(
      `"${profileId}" is not a text-model profile. This build declares `
      + `${Object.keys(TEXT_MODEL_PROFILES).join(', ')} (electron/text-server.ts).`));
  }

  // Demand cancels any pending idle stop, even when the caller forgot to say
  // noteTextQueueBusy first.
  cancelIdleStop();

  /*
   * ── THE IN-FLIGHT GUARD IS ESTABLISHED BEFORE THE FIRST await ─────────────
   *
   * This function is NOT async, and that is the whole of it. It used to be, with
   * the sharing done further down around `starting` — and the keeper caught what
   * that costs: `startServer` is only reached after `askModelList` has been
   * awaited, so two passes beginning in the same tick BOTH saw `starting === null`
   * and BOTH spawned a vLLM onto the same port, each reserving 90% of the card.
   * The guard has to be a synchronous assignment, before anything yields.
   *
   * Two callers wanting the SAME profile get one promise. A caller wanting the
   * other one CHAINS behind, because a swap is a stop and a start and must not
   * interleave with the run it is replacing.
   */
  if (pending !== null && pending.profileId === profile.id) return pending.promise;
  const previous = pending === null ? Promise.resolve() : pending.promise;
  const promise = (async () => {
    // A previous ensure's FAILURE is its caller's, not ours; what this needs from
    // it is only that it has finished touching the port and the card.
    await previous.catch(() => { /* owned by the caller that asked for it */ });
    return ensureOnce(profile, say);
  })();
  pending = { profileId: profile.id, promise };
  return promise.finally(() => {
    if (pending !== null && pending.promise === promise) pending = null;
  });
}

/** One ensure, with nothing else in flight. See {@link ensureTextServer}. */
async function ensureOnce(
  profile: TextModelProfile,
  say: (line: string) => void,
): Promise<TextServerHandle> {
  // A shutdown in flight still holds the VRAM, the arbiter and the port. Starting
  // into all three is how you get an out-of-memory failure that names the wrong
  // cause.
  if (stopping !== null) await stopping;

  if (server !== null && server.ready) {
    if (server.profile.id === profile.id) {
      return { url: TEXT_SERVER_URL, servedName: server.profile.servedName };
    }
    say(
      `Swapping the text server from ${server.profile.servedName} to ${profile.servedName} `
      + '(about 95 seconds)…');
    await stopTextServer(`this run needs ${profile.servedName}, not ${server.profile.servedName}`);
  }

  /*
   * Whoever is on the port RIGHT NOW, before anything is spawned or downloaded —
   * and an already-adopted server is re-asked rather than remembered. A server we
   * do not own can be stopped by the person who started it between one pass and
   * the next, and a remembered adoption would hand the next pass an endpoint that
   * answers nothing.
   */
  const existing = await deps.askModelList(TEXT_SERVER_URL);
  if (existing.up) {
    if (existing.ids.includes(profile.servedName)) {
      if (adopted !== null) return { url: TEXT_SERVER_URL, servedName: profile.servedName };
      adopted = { servedName: profile.servedName };
      say(
        `A server on port ${TEXT_SERVER_PORT} is already serving ${profile.servedName}. Using it as `
        + 'it is; BookForge will not stop it.');
      console.log(`[text-server] adopted an existing ${profile.servedName} on ${TEXT_SERVER_URL}`);
      return { url: TEXT_SERVER_URL, servedName: profile.servedName };
    }
    throw new Error(
      `Something is already answering on ${TEXT_SERVER_URL} and it is serving `
      + `${existing.ids.join(', ') || 'a model it will not name'}, not ${profile.servedName}. That `
      + 'is somebody else\'s server: BookForge will not use it (every record this run writes would '
      + 'name the wrong model) and will not stop it. Stop it yourself, or point the vLLM URL at '
      + 'the server you meant.');
  }

  /*
   * The port went quiet. If what was on it was somebody else's, that claim has to
   * be dropped — Foundry's vllm-server says the same, for the same reason: a
   * server we then start OURSELVES would otherwise be treated as unownable and
   * never stopped.
   */
  adopted = null;

  await ensureStaged(profile, say);

  starting = startServer(profile, say);
  try {
    server = await starting;
  } finally {
    starting = null;
  }
  return { url: TEXT_SERVER_URL, servedName: server.profile.servedName };
}
