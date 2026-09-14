/**
 * page-reader — the LOCAL page reader: a llama-server holding dots.ocr, on this
 * machine, downloaded by this app.
 *
 * ── Why this file exists at all, and what it replaced ────────────────────────
 *
 * Reading a page is the ONE act in foundry with no Ollama path. Ollama does not
 * serve dots.ocr (ollama/ollama#11653 is an open request and nothing more), so
 * while every text act — translate, simplify, clean, analyse — can speak to an
 * Ollama a person already has, page reading had exactly one local answer: a
 * vLLM the app built inside WSL and launched. `vllm-server.ts` did that, and
 * `backend-setup.ts` built the environment for it, and between them they made
 * "convert a PDF" depend on the user installing WSL, a CUDA toolchain and five
 * gigabytes of wheels.
 *
 * Owen killed that on 2026-09-13: *"foundry should work if they have no idea
 * what theyre doing and they just want to convert PDFs to EPUB"*, and *"the plan
 * is to leave VLLM to crucible only"*. All WSL complexity moved to Crucible, a
 * separate product this app will later offer to connect to. What is left here
 * is llama.cpp, which merged dots.ocr support on 2026-04-09 (ggml-org/llama.cpp
 * PR #17575) and serves it from two GGUF files behind the SAME OpenAI-compatible
 * door — `/v1/models`, `/v1/chat/completions` with an image part — that the
 * engine's endpoint reader (`src/vlm/endpoint.ts`) already spoke against vLLM.
 * Nothing in the engine changed. The server on the other end did.
 *
 * ── What it does NOT do: start anybody else's server ─────────────────────────
 *
 * A user who points the reading endpoint somewhere else — a Crucible, a vLLM
 * they run themselves, a box down the hall — keeps working, and nothing in this
 * file is consulted. `isLocalPageReader` is the whole of the test, and it is
 * narrow on purpose: this loopback address and this port. Anything else is
 * USED, exactly as given.
 *
 * And on the port itself: if something is ALREADY answering there, it is used
 * and never owned — not stopped on quit, not stopped by the Stop button, not
 * restarted. That rule is inherited verbatim from `vllm-server.ts`, where it
 * was learned: killing a thing this app did not start is how you lose somebody
 * else's work. It also has a second job now. Owen's own machine has a vLLM on
 * 8000 serving `rednote-hilab/dots.ocr` by hand, and adopting it means a reading
 * still goes through it rather than through a second server loading a second
 * copy of the same weights onto the same card.
 *
 * ── The lifetime: up while the queue has work, down when it drains ───────────
 *
 * Unchanged from the launcher this replaces, and for a smaller version of the
 * same reason. The weights are ~3.2 GB rather than ~20, but a card that is
 * holding them is a card the user's other work is not, and Owen's standing rule
 * for local compute is that a job takes the GPU and gives it back: *"ollama
 * should always, always bring down the model as soon as the job is done. they
 * arent chatting with it, theyre using it for a job."* The queue signals
 * through `noteQueueBusy`/`noteQueueIdle`; `keepServerWarmMinutes` (0 by
 * default) delays the stop for somebody feeding jobs in one at a time by hand.
 * A server this app merely FOUND is exempt: it was not ours to start and it is
 * not ours to stop.
 *
 * ── The two things nobody has measured ───────────────────────────────────────
 *
 * Written here as well as in docs/SETUP.md because this is where somebody will
 * be standing when it matters:
 *
 *   1. WHETHER THE GGUF ANSWERS IN THE DIALECT THE PARSER EXPECTS. `src/vlm/
 *      dots.ts` (`parseDotsPage`) reads one JSON array of `{bbox, category,
 *      text}` per page — that is dots.ocr's `layout-all` answer, and the whole
 *      book depends on it. The Q8_0 quantisation and llama.cpp's own vision
 *      stack are not the bf16 weights under vLLM, and a quantised model that
 *      answers in prose, or with a truncated array, or with boxes in a
 *      different frame, would produce a book rather than an error. NOBODY HAS
 *      RUN A PAGE THROUGH THIS. The first person to should read one page and
 *      look at the JSON before reading three hundred.
 *   2. SECONDS PER PAGE. Unmeasured on CPU and unmeasured on a small card. The
 *      MLX 4-bit path is ~27 s a page on an M1 Ultra (src/vlm/models.ts) and
 *      vLLM on a 3090 is far faster; where a Q8 GGUF lands between them, and
 *      whether the CPU build is usable at all or merely possible, are numbers
 *      this file cannot invent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AbortedError,
  fetchResumable,
  gib,
  isAborted,
  makeTempDir,
  removeTempDir,
  sha256File,
  unpackArchive,
} from './env-downloader';
import { CRUCIBLE_READS } from './crucible-dispatch';
import {
  localCrucibleServes,
  localCrucibleTakeover,
  refreshCrucibleFacts,
} from './crucible-provider';
import { pagesForm, type GgufForm } from './llm-catalog';
import { probeSystem } from './system-probe';
import type {
  MachineModelItem,
  PageReaderFile,
  PageReaderProgress,
  PageReaderState,
  RemovalOutcome,
  ServerState,
  ServerStatus,
} from '../shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// Addresses and names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The port, fixed, and STILL 8000 — which is llama-server's default of 8080
 * being deliberately ignored.
 *
 * 8000 is where the retired launcher served, where `backend.endpointUrl` on
 * every machine this app has ever configured already points, and where a vLLM
 * somebody started by hand lives. Moving it would have silently orphaned every
 * existing settings.json: the endpoint would still name 8000, nothing would be
 * there, and the reading would fail with "could not be reached" while a settings
 * row cheerfully reported the page reader installed and serving on some other
 * number. Keeping the address is the cheaper truth.
 */
const PORT = 8000;

/** The base URL the engine is handed. `/v1` is the OpenAI-compatible prefix. */
export const PAGE_READER_URL = `http://localhost:${PORT}/v1`;

/**
 * The name llama-server is told to answer to, and therefore the name the engine
 * is told to prove.
 *
 * llama-server names a model after the file it loaded unless `--alias` says
 * otherwise, so without this the served id would be `dots.ocr-Q8_0.gguf` — a
 * file name, leaking into a chat request, into `confirmServedModel`'s refusal
 * message, and (worse) into the bank and the EPUB's provenance stamp as the
 * name of the model that read the book. `dots.ocr` is what the weights are
 * called. `isPageReadingModel` in src/vlm/models.ts matches the last path
 * segment, so this spelling also satisfies the text door's "you have pointed a
 * cleanup at a page reader" refusal, which is the point of that check.
 */
export const PAGE_READER_MODEL = 'dots.ocr';

// ─────────────────────────────────────────────────────────────────────────────
// What gets downloaded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The GGUF pair — AND IT IS NO LONGER THIS FILE'S TO NAME.
 *
 * TWO FILES, NOT ONE, and that is how llama.cpp serves a vision model: the text
 * tower is the model and the vision tower is a separate `mmproj` projector
 * passed with `--mmproj`. A server started with only the first loads, answers
 * `/v1/models`, and then refuses every request that carries an image — which
 * would look exactly like a broken page rather than a missing file.
 *
 * ── WHY THE FOUR CONSTANTS THAT USED TO BE HERE ARE GONE ────────────────────
 *
 * `HF_REPO`, `MODEL_FILE`, `MMPROJ_FILE` and an implied `main` revision were
 * written down here, and the catalog (`app/shared/model-lineup.json`) wrote the
 * same four facts down again in its `pages` row. Two owners of "which weights is
 * the page reader" is a re-vendored catalog quietly disagreeing with what the
 * installer actually fetches — the settings row would price one pair and the
 * download would take another. Wave 61 package E made the catalog the owner
 * (docs/SLOTS.md §4: *"Crucible's manifests are the catalog of record"*) and
 * this file READS it, through `pagesForm()`.
 *
 * WHAT THE CATALOG NAMES TODAY is `anthonym21/dots.ocr-GGUF` at a pinned
 * COMMIT, `Dots.Ocr-1.8B-Q8_0.gguf` with an **F16** projector — llama.cpp's own
 * guidance is that the mmproj is small and quantising it costs more than it
 * saves. That is a different pair from the `ggml-org` Q8/Q8 one this file used
 * to name, so a machine that installed the reader before this change holds two
 * superseded files; they are LISTED by `pageReaderFootprint` (which walks the
 * directory rather than the current pair, precisely so they cannot go
 * unaccounted) and the Remove button takes the whole directory.
 *
 * A REVISION THAT IS A COMMIT, not a branch, and both the index read and the
 * download URL use it — so a repository re-cut upstream cannot change what a
 * machine fetches under a checksum recorded against something else.
 *
 * NULL IS A REAL ANSWER. A catalog with no `pages` row means this build cannot
 * install a reader, and every function below refuses by name rather than falling
 * back to a repository nothing named.
 */
function pagesPair(): GgufForm | null {
  return pagesForm();
}

/** The two file names, in the order the installer fetches them. Empty when there is no row. */
function modelFiles(): readonly string[] {
  const form = pagesPair();
  return form === null ? [] : [form.file, form.mmproj];
}

/**
 * The sentence every refusal about a missing `pages` row shares.
 *
 * One spelling, because the three places that hit it — the health read, the
 * install and the spawn — are three surfaces showing one fact, and three
 * paraphrases of "the catalog has no page reader in it" would read as three
 * different faults.
 */
const NO_PAGES_ROW =
  'The model catalog shipped with this build has no page-reader row, so there is nothing to '
  + 'install or serve. That is app/shared/model-lineup.json, vendored from Crucible — a build '
  + 'whose catalog lost its dots.ocr entry needs a re-vendor, not a setting.';

/** llama.cpp's own repository. The binaries are its release assets. */
const LLAMA_REPO = 'ggml-org/llama.cpp';

/**
 * The build to fall back to when the releases API cannot be reached.
 *
 * llama.cpp publishes a build per merge, tagged `b<number>`, and every one of
 * them is marked PRERELEASE — so `/releases/latest` answers with something else
 * entirely (a `v0.4.0` carrying one text file, at the time of writing) and is
 * useless here. The listing is read and the newest `b<number>` taken instead.
 * This pin is what a machine with no GitHub gets, and it is a build known to
 * postdate the dots.ocr merge (PR #17575, 2026-04-09) rather than a build
 * anybody has run.
 */
const PINNED_RELEASE = 'b10950';

/** Only `b<digits>` is a llama.cpp build. Anything else on that page is not. */
const BUILD_TAG = /^b\d+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Serving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The context window one page needs, with the arithmetic shown.
 *
 * A page is rendered at 200 dpi — 1300x2112 for a 468x760 pt page
 * (`VLM_DPI`, src/vlm/read.ts). dots.ocr's vision tower is a Qwen-family one:
 * 28x28 patches with a 2x2 merge, so 1300x2112 is about (47 x 76) / 4 = 893
 * image tokens. The `layout-all` prompt is another ~300. The answer is capped at
 * 8,192 (`VLM_MODELS`, src/vlm/models.ts), which is not a budget but a stop for
 * a model that has started repeating itself — and the longest page ever ACCEPTED
 * across 18,202 measured pages was 7,677 tokens, so the cap is reachable by real
 * pages and cannot be shaved.
 *
 * That is ~9,400. 16,384 is the next power of two above it, and the headroom is
 * for the thing this arithmetic cannot see: llama.cpp's own image tokeniser may
 * not merge exactly as the Python processor does, and a context one token short
 * fails a page rather than shortening it.
 *
 * ONE SLOT, which is `--parallel`'s default and is left alone. Twelve slots
 * would be twelve times this KV cache for a card that is already holding the
 * weights.
 */
const CTX_SIZE = 16_384;

/**
 * Pages in flight the engine is told to use against THIS server — one.
 *
 * The engine's default is twelve, measured against a vLLM that genuinely runs
 * twelve at once (`DEFAULT_VLM_CONCURRENCY`, src/vlm/endpoint.ts). llama-server
 * with one slot does not: eleven of the twelve would sit in its queue, and every
 * page's recorded `seconds` — which is banked, and which is what anybody
 * measuring this server will read — would be its wait rather than its work.
 * Sending one at a time makes the number honest. It also makes the adaptive
 * token band STRICTLY safer: `band.ts`'s margin absorbs a lag of twelve, and a
 * lag of one is fresher than that, never staler.
 */
const PAGE_READER_CONCURRENCY = 1;

/**
 * How long the server gets to load ~3.2 GB and answer. Generous for a cold
 * page cache on a slow disk; the fatal-pattern scan below is what keeps a
 * genuinely broken start from actually costing this long.
 */
const STARTUP_TIMEOUT_MS = 5 * 60_000;

/** How long it gets to exit after SIGTERM before the handle is killed. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Lines kept for a failure that has to explain itself. */
const LOG_CAP = 400;

/**
 * Log lines that mean this server is never going to be ready.
 *
 * Same idea as the launcher's, and it exists for the same measured reason:
 * polling `/v1/models` alone turns every failure into the full timeout. A CUDA
 * OOM says so in the first few seconds and then sits there forever.
 */
const FATAL_PATTERNS: readonly { pattern: RegExp; meaning: string }[] = [
  {
    pattern: /out of memory|failed to allocate|cudaMalloc failed|ggml_backend_cuda_buffer_type_alloc_buffer/i,
    meaning: 'the GPU does not have enough free memory for the model',
  },
  {
    pattern: /failed to load model|unable to load model|error loading model/i,
    meaning: 'llama-server could not load the model file',
  },
  {
    pattern: /failed to load mmproj|mtmd_init.*failed|error loading multimodal/i,
    meaning: 'llama-server could not load the vision projector, so it cannot read a page',
  },
  {
    pattern: /bind.*address already in use|couldn't bind to server socket/i,
    meaning: `something else already holds port ${PORT}`,
  },
  {
    pattern: /unknown model architecture|unsupported model architecture/i,
    meaning: 'this llama-server build does not know this model — it predates the dots.ocr merge',
  },
];

/**
 * llama.cpp's own routine chatter, which is never a reason to give up.
 *
 * This exclusion is load-bearing rather than tidy, exactly as it was in the
 * launcher: a healthy llama-server prints lines containing the word "failed"
 * while probing backends it does not have, and scanning them would fail a
 * working server in its first second and report a problem that is not one.
 */
const CHATTER = /^(ggml_|llama_|build:|main:|srv |load_backend:|register_backend)/;

/**
 * One log line -> why this server will never be ready, or null.
 *
 * Pure and exported so the patterns can be checked against real llama-server
 * output without a GPU.
 */
export function fatalReason(line: string): string | null {
  const text = line.trim();
  if (CHATTER.test(text)) return null;
  for (const { pattern, meaning } of FATAL_PATTERNS) {
    if (pattern.test(text)) return meaning;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which endpoints are ours to start
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this URL the local page reader this module manages?
 *
 * A remote endpoint — a Crucible, a vLLM on another machine, a hosted service —
 * is used exactly as given and never started, never stopped, never probed for
 * readiness beyond the request the engine itself makes. Starting a local server
 * because a job named a REMOTE one would load three gigabytes for nothing.
 */
export function isLocalPageReader(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return LOOPBACK.has(parsed.hostname) && port === String(PORT);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Where the files live
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The directory holding the binary and the weights.
 *
 * Under the platform's own per-user application data and NOT beside the app, for
 * `env-catalog.ts`'s reason restated: a packaged install lives in Program Files,
 * and three gigabytes under a directory an update replaces wholesale is three
 * gigabytes downloaded twice. On Windows that is LOCALAPPDATA (Local, not
 * Roaming) — a roaming profile is not the place for a multi-gigabyte blob.
 */
export function pageReaderDir(): string {
  switch (process.platform) {
    case 'win32': {
      const local = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'foundry', 'page-reader');
    }
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'foundry', 'page-reader');
    default: {
      const share = process.env['XDG_DATA_HOME'];
      return path.join(share ?? path.join(os.homedir(), '.local', 'share'), 'foundry', 'page-reader');
    }
  }
}

const binDir = (): string => path.join(pageReaderDir(), 'bin');
const modelsDir = (): string => path.join(pageReaderDir(), 'models');

/**
 * The record of WHAT was installed, written beside it.
 *
 * The release tag is the only thing on disk that says which llama.cpp build
 * this is — the binary itself will print one, but only by being run, and the
 * settings row has to be able to say it without spawning anything. The model
 * hashes are recorded so the health read does not have to re-hash 3.2 GB every
 * time somebody opens Settings; the hashes are VERIFIED at install, and after
 * that presence plus size is what is checked.
 */
interface InstallRecord {
  release: string;
  asset: string;
  accel: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

function recordPath(): string {
  return path.join(pageReaderDir(), 'installed.json');
}

function readRecord(): InstallRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recordPath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<InstallRecord>;
    if (typeof record.release !== 'string') return null;
    return {
      release: record.release,
      asset: typeof record.asset === 'string' ? record.asset : '',
      accel: typeof record.accel === 'string' ? record.accel : 'CPU',
      files: typeof record.files === 'object' && record.files !== null ? record.files : {},
    };
  } catch {
    return null;
  }
}

/** The server executable, wherever the archive put it. Null when it is not there. */
export function serverBinary(): string | null {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const root = binDir();
  // The Windows zips lay the binaries out flat; the macOS tarballs put them in
  // `build/bin/`. Both are looked for rather than one being assumed, because the
  // layout is llama.cpp's to change and a wrong guess reads as "not installed"
  // immediately after a successful download.
  const candidates = [
    path.join(root, name),
    path.join(root, 'build', 'bin', name),
    path.join(root, 'bin', name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function modelPath(name: string): string {
  return path.join(modelsDir(), name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Which build this machine wants
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildChoice {
  /** The release asset's name, with `<tag>` where the build number goes. */
  assetTemplate: string;
  /**
   * A second asset that must be unpacked beside it, or null.
   *
   * This is the CUDA runtime, and it is not optional on Windows. llama.cpp's
   * `win-cuda` zip carries the CUDA-aware ggml backend but NOT the CUDA runtime
   * DLLs, so on a machine with an NVIDIA driver and no CUDA toolkit installed —
   * which is most machines — the server fails to start with a missing-DLL box
   * and no log line. 391 MB is a large thing to download without saying so, and
   * the settings row says so.
   */
  runtimeTemplate: string | null;
  /** `CUDA`, `Metal`, `CPU`. What the row prints and what decides `-ngl`. */
  accel: string;
}

/**
 * The llama.cpp build for this machine, or null when there is none.
 *
 * CUDA 12.4 RATHER THAN 13.x on NVIDIA, and the reason is driver floors: a
 * CUDA 13 build needs a 580-series driver or newer, where 12.4 runs on 550 and
 * on everything above it through minor-version compatibility. The point of this
 * whole package is a machine nobody has prepared, so the build that asks least
 * of the driver wins.
 */
export function buildFor(platform: NodeJS.Platform, arch: string, nvidia: boolean): BuildChoice | null {
  if (platform === 'win32') {
    if (arch === 'x64') {
      return nvidia
        ? {
          assetTemplate: 'llama-<tag>-bin-win-cuda-12.4-x64.zip',
          runtimeTemplate: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
          accel: 'CUDA',
        }
        : { assetTemplate: 'llama-<tag>-bin-win-cpu-x64.zip', runtimeTemplate: null, accel: 'CPU' };
    }
    if (arch === 'arm64') {
      return { assetTemplate: 'llama-<tag>-bin-win-cpu-arm64.zip', runtimeTemplate: null, accel: 'CPU' };
    }
    return null;
  }
  if (platform === 'darwin') {
    // Metal is compiled into both macOS builds; there is no CPU-only variant to
    // choose and no flag that would ask for one.
    return arch === 'arm64'
      ? { assetTemplate: 'llama-<tag>-bin-macos-arm64.tar.gz', runtimeTemplate: null, accel: 'Metal' }
      : { assetTemplate: 'llama-<tag>-bin-macos-x64.tar.gz', runtimeTemplate: null, accel: 'Metal' };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { assetTemplate: 'llama-<tag>-bin-ubuntu-x64.tar.gz', runtimeTemplate: null, accel: 'CPU' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Asking the two indexes what is published
// ─────────────────────────────────────────────────────────────────────────────

interface RemoteAsset {
  name: string;
  url: string;
  bytes: number | null;
  /** Lowercase hex, or null when the index publishes none. */
  sha256: string | null;
}

interface RemoteBuild {
  release: string;
  server: RemoteAsset;
  runtime: RemoteAsset | null;
  accel: string;
}

async function askJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'foundry-app', accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
  return response.json();
}

/**
 * The newest llama.cpp build with an asset for this machine.
 *
 * Reads the LISTING, not `/releases/latest` — see `PINNED_RELEASE` for why that
 * endpoint answers with the wrong thing. Fifteen entries is several days of
 * merges, which is enough to step over a build whose asset for one platform
 * failed to upload.
 */
export async function findBuild(choice: BuildChoice): Promise<RemoteBuild> {
  let releases: unknown;
  try {
    releases = await askJson(`https://api.github.com/repos/${LLAMA_REPO}/releases?per_page=15`);
  } catch (err) {
    // No network, or a rate limit. The pin is a real answer rather than a
    // failure: the URL is derivable without the API, only the checksum is not.
    return pinnedBuild(choice, (err as Error).message);
  }

  const list = Array.isArray(releases) ? releases : [];
  for (const entry of list) {
    const release = entry as { tag_name?: unknown; assets?: unknown };
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    if (!BUILD_TAG.test(tag)) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const wantServer = choice.assetTemplate.replace('<tag>', tag);
    const wantRuntime = choice.runtimeTemplate;

    const find = (name: string): RemoteAsset | null => {
      for (const raw of assets) {
        const asset = raw as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown };
        if (asset.name !== name) continue;
        const digest = typeof asset.digest === 'string' ? asset.digest : '';
        return {
          name,
          url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : releaseUrl(tag, name),
          bytes: typeof asset.size === 'number' ? asset.size : null,
          sha256: digest.startsWith('sha256:') ? digest.slice('sha256:'.length).toLowerCase() : null,
        };
      }
      return null;
    };

    const server = find(wantServer);
    if (server === null) continue;
    const runtime = wantRuntime === null ? null : find(wantRuntime);
    // A CUDA build whose runtime asset is missing from THIS release would
    // install and then fail to start on a missing DLL. Skip to the next build
    // rather than ship half of a pair.
    if (wantRuntime !== null && runtime === null) continue;
    return { release: tag, server, runtime, accel: choice.accel };
  }

  return pinnedBuild(choice, `no recent ${LLAMA_REPO} release carries ${choice.assetTemplate}`);
}

function releaseUrl(tag: string, name: string): string {
  return `https://github.com/${LLAMA_REPO}/releases/download/${tag}/${name}`;
}

/**
 * The pinned build, with no checksums — which is a statement, not a silence.
 *
 * `installBuild` says out loud that it could not verify these bytes. The
 * alternative was refusing to install at all when GitHub's API is unreachable,
 * and that would make a rate limit (sixty anonymous calls an hour, shared by
 * everyone behind one address) into "the page reader cannot be installed".
 */
function pinnedBuild(choice: BuildChoice, why: string): RemoteBuild {
  console.warn(`[page-reader] falling back to the pinned build ${PINNED_RELEASE}: ${why}`);
  const serverName = choice.assetTemplate.replace('<tag>', PINNED_RELEASE);
  return {
    release: PINNED_RELEASE,
    accel: choice.accel,
    server: { name: serverName, url: releaseUrl(PINNED_RELEASE, serverName), bytes: null, sha256: null },
    runtime: choice.runtimeTemplate === null
      ? null
      : {
        name: choice.runtimeTemplate,
        url: releaseUrl(PINNED_RELEASE, choice.runtimeTemplate),
        bytes: null,
        sha256: null,
      },
  };
}

/**
 * The two GGUF files, from the Hugging Face model index AT THE PINNED REVISION.
 *
 * `?blobs=true` is what makes the index carry each file's LFS sha256, which is
 * the only published checksum these weights have. Without it the response lists
 * names and nothing to verify them against.
 *
 * THE REVISION IS IN BOTH THE INDEX READ AND THE DOWNLOAD URL, and it has to be
 * in both or it is in neither: reading `main`'s hashes and then fetching a
 * pinned commit's bytes would compare a file against a checksum for a different
 * file and delete it as corrupt. The catalog's `revision` is a commit for the
 * dots row; a repository that names a branch there is used as written, and the
 * pin is then whatever that branch is at the moment of the read.
 */
export async function findModels(): Promise<RemoteAsset[]> {
  const form = pagesPair();
  if (form === null) throw new Error(NO_PAGES_ROW);
  const revision = encodeURIComponent(form.revision);
  const body = await askJson(
    `https://huggingface.co/api/models/${form.hf_repo}/revision/${revision}?blobs=true`,
    20_000,
  );
  const siblings = (body as { siblings?: unknown }).siblings;
  const list = Array.isArray(siblings) ? siblings : [];
  const found: RemoteAsset[] = [];
  for (const name of modelFiles()) {
    const entry = list.find((raw) => (raw as { rfilename?: unknown }).rfilename === name) as
      { rfilename?: string; size?: unknown; lfs?: { sha256?: unknown; size?: unknown } } | undefined;
    if (entry === undefined) {
      throw new Error(
        `${form.hf_repo} at ${form.revision} does not carry ${name}. The catalog's page-reader row `
        + 'names a file that is not in that revision; app/shared/model-lineup.json needs a '
        + 're-vendor from Crucible.',
      );
    }
    const lfs = entry.lfs ?? {};
    found.push({
      name,
      url: `https://huggingface.co/${form.hf_repo}/resolve/${revision}/${encodeURIComponent(name)}`,
      bytes: typeof lfs.size === 'number' ? lfs.size : (typeof entry.size === 'number' ? entry.size : null),
      sha256: typeof lfs.sha256 === 'string' ? lfs.sha256.toLowerCase() : null,
    });
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// The health read — one answer for the settings row and the setup step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this machine has, measured rather than remembered.
 *
 * Nothing is cached: somebody who deleted the directory by hand should see the
 * row say so the next time the page loads. The remote sizes ARE asked for, but
 * only when something is missing — an installed reader needs no network to
 * describe itself, which is what makes this read cheap enough to call on every
 * render of the settings page.
 */
/**
 * THE CRUCIBLE ON THIS MACHINE THAT HAS TAKEN PAGE READING OVER, or null.
 *
 * docs/SLOTS.md §5b. When this is set, Foundry's own reader is not needed here:
 * the settings card says so and its Install button is off (off rather than gone
 * — a button that vanishes teaches somebody the app is broken), and the §5b
 * removal is what takes the files. LOCAL ONLY: a remote Crucible deliberately
 * answers null, because *"the local reader is what works when the Mac is
 * asleep."*
 */
export function pageReaderSuperseded(): string | null {
  /*
   * SERVING THE CLASS IS HALF OF TAKING IT OVER. The other half is this app
   * SENDING page reads there, and while `CRUCIBLE_READS` is false it does not: a
   * `read` job takes the local path and `job-queue.ts` starts this server before
   * it resolves a placement at all. Saying "not needed" on the strength of the
   * capability record alone would dark the Install button on a machine whose
   * reading still depends on the thing behind it — see the long note in
   * machine-models.ts, which is the same condition and the same one-constant
   * reversal.
   */
  if (!CRUCIBLE_READS) return null;
  if (localCrucibleServes('pages') !== 'yes') return null;
  return localCrucibleTakeover()?.server ?? null;
}

export async function pageReaderState(keepWarmMinutes: number): Promise<PageReaderState> {
  const profile = await probeSystem();
  /*
   * ── IS SOMETHING ON THIS MACHINE ALREADY READING PAGES? ───────────────────
   *
   * docs/SLOTS.md §5b. A LOCAL Crucible serving the `pages` class owns the
   * weights for it here, and Foundry's own copy is a duplicate that has been (or
   * is about to be) removed — so every surface built from this answer says why
   * installing is not needed rather than offering a download of four gigabytes
   * the machine already has in another store.
   *
   * The facts are refreshed here rather than read cold because this function is
   * a settings card being opened, which is exactly when a person deserves a
   * measurement instead of whatever a tooltip left in the cache.
   */
  await refreshCrucibleFacts();
  const supersededBy = pageReaderSuperseded();
  const choice = buildFor(process.platform, process.arch, profile.cuda.present);
  const record = readRecord();
  const binary = serverBinary();

  const models: PageReaderFile[] = modelFiles().map((name) => {
    const file = modelPath(name);
    let bytes: number | null = record?.files[name]?.bytes ?? null;
    let present = false;
    try {
      const stat = fs.statSync(file);
      present = stat.size > 0;
      bytes = stat.size;
    } catch { /* not there */ }
    return { name, bytes, present };
  });

  /*
   * `models.every` ON AN EMPTY LIST IS TRUE, which is why the pair is asked for
   * by name here rather than inferred from the list's length being right. A
   * catalog with no `pages` row produces no files to check and would otherwise
   * report a reader installed on the strength of a llama-server binary with
   * nothing to serve.
   */
  const installed = pagesPair() !== null && binary !== null && models.every((file) => file.present);

  if (pagesPair() === null) {
    return {
      supported: false,
      platformNote: NO_PAGES_ROW,
      installed: false,
      binary: { release: null, asset: null, path: null, accel: 'none' },
      models,
      downloadBytes: null,
      detail: 'There is no page reader in this build\'s catalog.',
      server: serverStatus(),
      keepWarmMinutes,
      supersededBy,
    };
  }

  if (choice === null) {
    return {
      supported: false,
      platformNote:
        `There is no llama.cpp build for ${process.platform}/${process.arch} on the release, so this app `
        + 'cannot install a page reader here. Point the reading endpoint at a server elsewhere instead.',
      installed: false,
      binary: { release: null, asset: null, path: null, accel: 'none' },
      models,
      downloadBytes: null,
      detail: 'Not available on this machine.',
      server: serverStatus(),
      keepWarmMinutes,
      supersededBy,
    };
  }

  const platformNote = choice.accel === 'CUDA'
    ? `An NVIDIA card was found (${profile.cuda.name ?? 'unnamed'}), so this machine gets the CUDA build `
      + 'plus the CUDA runtime it needs.'
    : choice.accel === 'Metal'
      ? 'This Mac gets the Metal build, which runs the model on the GPU without anything else installed.'
      : 'No supported GPU was found, so this machine gets the CPU build. It will work and it will be slow.';

  if (installed) {
    return {
      supported: true,
      platformNote,
      installed: true,
      binary: {
        release: record?.release ?? null,
        asset: record?.asset ?? null,
        path: binary,
        accel: record?.accel ?? choice.accel,
      },
      models,
      downloadBytes: 0,
      detail: record === null || record.release.length === 0
        ? `Installed, but the record of which llama.cpp build this is was lost. It will still serve `
          + `${PAGE_READER_MODEL}; reinstalling would restore the record.`
        : `llama.cpp ${record.release} (${record.accel}), serving ${PAGE_READER_MODEL} from `
          + `${modelFiles().length} files in ${modelsDir()}.`,
      server: serverStatus(),
      keepWarmMinutes,
      supersededBy,
    };
  }

  // Something is missing, so the sizes matter. Both indexes, and a failure to
  // reach either is a null rather than a throw: "not installed, and I could not
  // find out how big the download is" is a true sentence and a usable screen.
  let downloadBytes: number | null = 0;
  let detail: string;
  try {
    const [build, remote] = await Promise.all([findBuild(choice), findModels()]);
    let total = binary === null ? (build.server.bytes ?? 0) + (build.runtime?.bytes ?? 0) : 0;
    for (const file of remote) {
      const here = models.find((one) => one.name === file.name);
      if (here && !here.present) total += file.bytes ?? 0;
      if (here && here.bytes === null) here.bytes = file.bytes;
    }
    downloadBytes = total;
    detail = `Not installed. Downloading it fetches ${gib(total)}: llama.cpp ${build.release} `
      + `(${build.accel}) and the ${PAGE_READER_MODEL} weights.`;
  } catch (err) {
    downloadBytes = null;
    detail = `Not installed, and the download sizes could not be read: ${(err as Error).message}`;
  }

  return {
    supported: true,
    platformNote,
    installed: false,
    binary: {
      release: record?.release ?? null,
      asset: record?.asset ?? null,
      path: binary,
      accel: choice.accel,
    },
    models,
    downloadBytes,
    detail,
    server: serverStatus(),
    keepWarmMinutes,
    supersededBy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Installing
// ─────────────────────────────────────────────────────────────────────────────

/** The one install in flight. A second caller is told, not queued. */
let installing: AbortController | null = null;

export function cancelPageReaderInstall(): void {
  installing?.abort();
}

export interface InstallOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Fetch whatever is missing, verify it, and put it where `ensurePageReader`
 * will look.
 *
 * SKIP WHAT IS ALREADY THERE. A GGUF whose size matches the index and whose
 * recorded sha256 matches what the index says now is not downloaded again — an
 * interrupted install that got one of the two files must not pay for both, and
 * this is the whole reason the record on disk carries hashes.
 *
 * NEVER THROWS. Every failure is a terminal `error` progress event AND the same
 * sentence in the returned `detail`, which is `ollama.ts`'s contract and is
 * what lets the renderer draw a failure without a try/catch.
 */
export async function installPageReader(
  onProgress: (progress: PageReaderProgress) => void,
): Promise<InstallOutcome> {
  if (installing) {
    return { ok: false, detail: 'The page reader is already being installed. Wait for it, or cancel it first.' };
  }
  const controller = new AbortController();
  installing = controller;
  const signal = controller.signal;

  const say = (
    item: string,
    phase: PageReaderProgress['phase'],
    percent: number,
    detail: string,
  ): void => onProgress({ item, phase, percent, detail });

  try {
    // Inside the try, so that anything it throws still reaches the `finally`
    // that clears the in-flight guard. A module-level lock released on only
    // some paths is a feature that works until the first bad day and then
    // refuses every install until the app is restarted.
    const profile = await probeSystem();
    const choice = buildFor(process.platform, process.arch, profile.cuda.present);
    if (choice === null) {
      const detail = `There is no llama.cpp build for ${process.platform}/${process.arch}, so there is `
        + 'nothing to install. Point the reading endpoint at a server on another machine instead.';
      say('all', 'error', 0, detail);
      return { ok: false, detail };
    }

    fs.mkdirSync(modelsDir(), { recursive: true });

    // ── the binary ──────────────────────────────────────────────────────────
    let record = readRecord();
    if (serverBinary() === null) {
      const build = await findBuild(choice);
      const temp = makeTempDir();
      try {
        for (const asset of [build.server, build.runtime]) {
          if (asset === null) continue;
          const archive = path.join(temp, asset.name);
          say(asset.name, 'download', 0, `Fetching ${asset.name}…`);
          await fetchResumable(asset.url, archive, (received, total) => {
            const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
            say(asset.name, 'download', percent, total && total > 0
              ? `${gib(received)} of ${gib(total)}`
              : gib(received));
          }, signal);

          if (asset.sha256 === null) {
            // Said out loud, never skipped silently. A release whose API entry
            // could not be read has no digest to compare against, and pretending
            // otherwise is the failure mode `verifyHash` exists to prevent.
            say(asset.name, 'verify', 100,
              `${asset.name} carries no published checksum, so it could not be verified.`);
          } else {
            say(asset.name, 'verify', 0, `Checking sha256 of ${asset.name}…`);
            const actual = await sha256File(archive);
            if (actual.toLowerCase() !== asset.sha256) {
              fs.rmSync(archive, { force: true });
              throw new Error(
                `${asset.name} does not match the release and has been deleted.\n`
                + `  expected sha256 ${asset.sha256}\n  got      sha256 ${actual.toLowerCase()}`,
              );
            }
            say(asset.name, 'verify', 100, 'sha256 matches the release.');
          }
          if (signal.aborted) throw new AbortedError();

          say(asset.name, 'unpack', 0, `Unpacking ${asset.name}…`);
          // BOTH archives unpack into the SAME directory, on purpose: the CUDA
          // runtime's DLLs have to sit beside llama-server.exe for Windows to
          // find them, and a subdirectory would need a PATH edit at spawn.
          await unpackArchive(archive, binDir(), (count) => {
            say(asset.name, 'unpack', 0, `Unpacked ${count.toLocaleString()} files…`);
          }, signal);
        }
      } finally {
        await removeTempDir(temp);
      }

      if (serverBinary() === null) {
        throw new Error(
          `${build.server.name} unpacked into ${binDir()}, but no llama-server executable is in it. `
          + 'The release asset\'s layout is not what this app expects.',
        );
      }
      record = {
        release: build.release,
        asset: build.server.name,
        accel: build.accel,
        files: record?.files ?? {},
      };
      writeRecord(record);
    }

    // ── the weights ─────────────────────────────────────────────────────────
    const remote = await findModels();
    for (const file of remote) {
      const dest = modelPath(file.name);
      const known = record?.files[file.name];
      let here: fs.Stats | null = null;
      try { here = fs.statSync(dest); } catch { /* not there */ }

      // Present, the right size, and hashed to the same thing the index says
      // today. That is as much as can be claimed without re-reading gigabytes,
      // and it is enough: a file that lost bytes lost its size with them.
      if (here !== null && here.size > 0
        && (file.bytes === null || here.size === file.bytes)
        && (file.sha256 === null || known?.sha256 === file.sha256)) {
        say(file.name, 'verify', 100, `${file.name} is already here.`);
        continue;
      }

      say(file.name, 'download', 0, `Fetching ${file.name}…`);
      await fetchResumable(file.url, dest, (received, total) => {
        const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        say(file.name, 'download', percent, total && total > 0
          ? `${gib(received)} of ${gib(total)}`
          : gib(received));
      }, signal);

      say(file.name, 'verify', 0, `Checking sha256 of ${file.name} — this reads the whole file…`);
      const actual = await sha256File(dest);
      if (file.sha256 !== null && actual !== file.sha256) {
        fs.rmSync(dest, { force: true });
        throw new Error(
          `${file.name} does not match the checksum the catalog's revision publishes, and has been deleted.\n`
          + `  expected sha256 ${file.sha256}\n  got      sha256 ${actual}`,
        );
      }
      say(file.name, 'verify', 100, file.sha256 === null
        ? `${file.name} carries no published checksum, so it could not be verified.`
        : 'sha256 matches Hugging Face.');

      record = {
        // EMPTY RATHER THAN PINNED when there is no record: reaching here with
        // a binary already on disk and nothing describing it means somebody's
        // record was lost, and writing `PINNED_RELEASE` into it would turn "we
        // do not know which build this is" into a specific claim that is
        // probably false. The row says the build is unrecorded instead.
        release: record?.release ?? '',
        asset: record?.asset ?? '',
        accel: record?.accel ?? choice.accel,
        files: { ...(record?.files ?? {}), [file.name]: { bytes: fs.statSync(dest).size, sha256: actual } },
      };
      writeRecord(record);
      if (signal.aborted) throw new AbortedError();
    }

    const detail = `The page reader is installed: llama.cpp `
      + `${record?.release || 'an unrecorded build'} (${record?.accel ?? choice.accel}) `
      + `with the ${PAGE_READER_MODEL} weights in ${modelsDir()}.`;
    say('all', 'done', 100, detail);
    return { ok: true, detail };
  } catch (err) {
    const detail = isAborted(err)
      ? 'Cancelled. What had already been fetched is kept, so starting again continues from there.'
      : `The page reader could not be installed: ${err instanceof Error ? err.message : String(err)}`;
    say('all', 'error', 0, detail);
    return { ok: false, detail };
  } finally {
    installing = null;
  }
}

function writeRecord(record: InstallRecord): void {
  fs.mkdirSync(pageReaderDir(), { recursive: true });
  fs.writeFileSync(recordPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// The running server
// ─────────────────────────────────────────────────────────────────────────────

interface RunningServer {
  proc: ChildProcess;
  log: string[];
  /** Set by the log scan the moment the server says something unrecoverable. */
  fatal: string | null;
  exited: { code: number | null; signal: string | null } | null;
}

let server: RunningServer | null = null;
/** In-flight start, so two jobs beginning together share one spawn. */
let starting: Promise<ServerStatus> | null = null;
/** A server on the port that we did not start. Used, never owned. */
let external = false;
let state: ServerState = 'stopped';
let detail = 'Not started.';
let listener: (status: ServerStatus) => void = () => { /* set by main */ };

export function onPageReaderStatus(fn: (status: ServerStatus) => void): void {
  listener = fn;
}

export function serverStatus(): ServerStatus {
  return { state, detail, url: PAGE_READER_URL, model: PAGE_READER_MODEL, external };
}

/** True only when this process spawned the thing that is up. */
export function ownsServer(): boolean {
  return server !== null && !external;
}

function publish(next: ServerState, why: string): void {
  state = next;
  detail = why;
  listener(serverStatus());
}

function logTail(lines = 14): string {
  return server === null ? '' : server.log.slice(-lines).join('\n').trim();
}

/** Does the port answer its model list, and with what? */
async function askModelList(): Promise<{ up: boolean; models: string[] }> {
  try {
    const res = await fetch(`${PAGE_READER_URL}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { up: false, models: [] };
    const body = await res.json() as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => !!id);
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}

/**
 * WHICH OF THE SERVED NAMES THE ENGINE SHOULD BE TOLD TO PROVE.
 *
 * `confirmServedModel` (src/vlm/read.ts) refuses a run whose `--vlm-endpoint-
 * model` is absent from the server's listing, which is a check worth having and
 * a check that is easy to get backwards. Our own llama-server answers
 * `dots.ocr` because `--alias` said so. An ADOPTED server answers whatever it
 * was started with — Owen's hand-run vLLM says `rednote-hilab/dots.ocr` — and
 * naming our alias at it would refuse a perfectly good server by name.
 *
 * So the answer comes from the listing rather than from a constant: one entry
 * is the one; several means prefer the one that looks like a dots model; and
 * anything else returns null, which leaves the flag off and lets the engine's
 * own registry default decide. Null is not a failure here. It is the absence of
 * an override, which is exactly what a server we cannot read has earned.
 */
export function servedModelFrom(models: readonly string[]): string | null {
  if (models.length === 1) return models[0] ?? null;
  const dots = models.find((id) => (id.split('/').pop() ?? '').toLowerCase().includes('dots'));
  return dots ?? null;
}

export interface ReadyServer {
  status: ServerStatus;
  /** The name to prove, or null when the listing did not settle it. */
  servedModel: string | null;
  /** What to tell the engine about pages in flight. */
  concurrency: number;
}

/**
 * The server a reading should send its pages to, started if it is not up.
 *
 * Throws with the server's own log tail when it cannot be. The caller (the job
 * queue) puts that on the job, because "the reading server did not start" with
 * no further word is the least useful failure a conversion can have.
 *
 * IT NEVER DOWNLOADS. A machine whose files are missing is told to go and press
 * the button in Settings, by name. Fetching three gigabytes from inside a job
 * somebody started to convert a PDF would be an hour of silence where a
 * sentence belongs, and the row would be "running" throughout it.
 */
export async function ensurePageReader(): Promise<ReadyServer> {
  cancelIdleStop();

  // Somebody else's, or our own from a moment ago. Either way the port answers
  // and there is nothing to start.
  const existing = await askModelList();
  if (existing.up) {
    if (server === null) {
      external = true;
      publish('ready', existing.models.length > 0
        ? `A server on port ${PORT} was already answering (${existing.models.join(', ')}). `
          + 'Using it as it is; this app will not stop it.'
        : `A server on port ${PORT} was already answering. Using it as it is; this app will not stop it.`);
    } else {
      publish('ready', detail);
    }
    return {
      status: serverStatus(),
      servedModel: servedModelFrom(existing.models),
      // An adopted server may well be a vLLM that really does run twelve pages
      // at once, and slowing it to ours would be this app second-guessing a
      // server it did not start. The engine's own default stands: passing no
      // concurrency at all is what `0` means to the caller.
      concurrency: server === null ? 0 : PAGE_READER_CONCURRENCY,
    };
  }

  // The port went quiet. If what was on it was somebody else's, it is not there
  // any more and the claim has to be dropped — otherwise a server we then start
  // ourselves would be treated as unownable and never stopped.
  external = false;

  if (starting === null) {
    starting = startServer().finally(() => { starting = null; });
  }
  const status = await starting;
  return { status, servedModel: PAGE_READER_MODEL, concurrency: PAGE_READER_CONCURRENCY };
}

async function startServer(): Promise<ServerStatus> {
  const form = pagesPair();
  /*
   * NO ROW, NO SERVER, and it refuses before it looks at the disk. A catalog
   * with no `pages` entry has nothing to spell into `-m`, and falling through to
   * the "not installed yet" sentence below would send somebody to a Settings
   * button that cannot help them either.
   */
  if (form === null) {
    publish('failed', NO_PAGES_ROW);
    throw new Error(NO_PAGES_ROW);
  }
  const binary = serverBinary();
  const missing = modelFiles().filter((name) => !fs.existsSync(modelPath(name)));

  // Named settings rather than symptoms. "llama-server is not on this machine"
  // is a true sentence that tells somebody nothing about what to do; the row in
  // Settings is what they can act on, so that is what the message names.
  if (binary === null || missing.length > 0) {
    const why = 'The local page reader is not installed yet, so there is nothing to read the pages with. '
      + 'Open Settings and use "Page reader (local)" to download it — or point the reading endpoint at a '
      + 'server on another machine.';
    publish('failed', why);
    throw new Error(why);
  }

  const record = readRecord();
  const gpu = record?.accel === 'CUDA' || record?.accel === 'Metal';
  const args = [
    '-m', modelPath(form.file),
    '--mmproj', modelPath(form.mmproj),
    '--alias', PAGE_READER_MODEL,
    // 127.0.0.1 rather than 0.0.0.0. The launcher this replaces bound to all
    // interfaces because it was inside WSL and had to cross that boundary;
    // this process is on the same machine as its client, and a reading server
    // on the network is a thing nobody asked for.
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--ctx-size', String(CTX_SIZE),
  ];
  // Every layer on the GPU when there is one. llama.cpp's own idiom, and 99 is
  // simply "more layers than any model has" — it clamps.
  if (gpu) args.push('-ngl', '99');

  publish('starting', `Starting the page reader (llama.cpp ${record?.release || 'unrecorded build'}, `
    + `${record?.accel ?? 'CPU'})…`);

  const proc = spawn(binary, args, { windowsHide: true });
  const entry: RunningServer = { proc, log: [], fatal: null, exited: null };
  server = entry;
  external = false;

  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      entry.log.push(line);
      if (entry.fatal === null) entry.fatal = fatalReason(line);
    }
    // Bounded: a serving llama.cpp logs every request, and this is a diagnostic
    // tail, not a transcript.
    if (entry.log.length > LOG_CAP) entry.log.splice(0, entry.log.length - LOG_CAP);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  proc.on('exit', (code, signal) => {
    entry.exited = { code, signal };
    if (server === entry) {
      server = null;
      if (state !== 'starting') publish('stopped', `The page reader exited (code ${code}).`);
    }
  });

  const fail = async (why: string): Promise<never> => {
    const tail = logTail();
    await terminate(entry, 'the start failed');
    if (server === entry) server = null;
    const message = tail ? `${why}\n\n${tail}` : why;
    publish('failed', message);
    throw new Error(message);
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (entry.exited !== null) {
      return fail(`The page reader stopped before it was ready (exit ${entry.exited.code}).`);
    }
    if (entry.fatal !== null) {
      return fail(`The page reader cannot start: ${entry.fatal}.`);
    }
    const probe = await askModelList();
    if (probe.up) {
      publish('ready', `Serving ${PAGE_READER_MODEL} on ${PAGE_READER_URL} `
        + `(llama.cpp ${record?.release || 'unrecorded build'}, ${record?.accel ?? 'CPU'}).`);
      return serverStatus();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return fail(
    `The page reader did not answer on ${PAGE_READER_URL} within `
    + `${Math.round(STARTUP_TIMEOUT_MS / 60_000)} minutes.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle teardown
// ─────────────────────────────────────────────────────────────────────────────

/** The pending stop, while a drained queue's keep-warm window runs out. */
let idleStop: NodeJS.Timeout | null = null;

function cancelIdleStop(): void {
  if (idleStop !== null) {
    clearTimeout(idleStop);
    idleStop = null;
  }
}

/**
 * A job is about to need the server: whatever idle countdown was running is
 * over. The queue calls this BEFORE ensurePageReader, so a job that arrives
 * inside the keep-warm window keeps the warm server instead of racing its stop.
 */
export function noteQueueBusy(): void {
  cancelIdleStop();
}

/**
 * The queue just drained: stop the server this app started — immediately when
 * `keepWarmMinutes` is 0 (the default), otherwise once the window runs out.
 *
 * The policy number comes from the CALLER (the queue reads the app's own
 * settings); this module only executes it, which keeps it free of Electron
 * imports. A server this app merely found on the port is not ours and is left
 * exactly alone, whatever the setting says. A stop is never mid-job by
 * construction: the queue only reports idle when nothing is running, and
 * anything that starts afterwards cancels the countdown.
 */
export function noteQueueIdle(keepWarmMinutes: number): void {
  cancelIdleStop();
  if (!ownsServer()) return;
  if (keepWarmMinutes <= 0) {
    void stopPageReader('the queue is empty');
    return;
  }
  publish('ready',
    `Serving ${PAGE_READER_MODEL} on ${PAGE_READER_URL}. The queue is empty — stopping in `
    + `${keepWarmMinutes} min unless another job arrives.`);
  idleStop = setTimeout(() => {
    idleStop = null;
    void stopPageReader(`the queue has been empty for ${keepWarmMinutes} min`);
  }, keepWarmMinutes * 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stopping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SIGTERM, then the handle, and the wait between them is not a formality: the
 * process holds the GPU, and killing one that does is how a driver ends up in a
 * state only a reboot clears. On Windows `kill()` is a TerminateProcess either
 * way, which is why the graceful window is given first regardless of platform.
 */
async function terminate(entry: RunningServer, reason: string): Promise<void> {
  try { entry.proc.kill('SIGTERM'); } catch { /* already gone */ }

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (entry.proc.exitCode === null && entry.proc.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
    try { entry.proc.kill('SIGKILL'); } catch { /* already gone */ }
    console.warn(`[page-reader] ${reason}: still running after SIGTERM; killed it`);
  }
}

/**
 * Stop the server, if it is ours.
 *
 * A server this app found already running is left alone and said so — the Stop
 * button on the settings row is disabled for it, and app quit does not touch it
 * either.
 */
export async function stopPageReader(reason = 'asked to stop'): Promise<ServerStatus> {
  // A manual stop supersedes a scheduled one; a timer left armed would fire
  // later and re-announce a stop that already happened.
  cancelIdleStop();
  if (external) {
    publish('ready', 'That server was already running before this app started it, so it is left alone.');
    return serverStatus();
  }
  const entry = server;
  if (entry === null) {
    publish('stopped', 'Not started.');
    return serverStatus();
  }
  server = null;
  publish('stopped', `Stopping — ${reason}…`);
  await terminate(entry, reason);
  publish('stopped', `Stopped — ${reason}.`);
  return serverStatus();
}

// ─────────────────────────────────────────────────────────────────────────────
// What this costs on disk, and taking it back — SLOTS.md §5b
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is the local reader ready to be used, asked WITHOUT touching the network.
 *
 * `pageReaderState` answers the same question and more, and it reaches Hugging
 * Face and GitHub to price the download whenever something is missing — which is
 * exactly right for a settings card being looked at, and exactly wrong for the
 * tile gate (act-gates.ts), which is asked whenever the dock reloads its gates
 * and must not put two HTTP round trips behind a tooltip. So the cheap half is
 * its own function: three `statSync` calls against a directory this app owns.
 *
 * THE SAME THREE FILES `pageReaderState` CALLS INSTALLED, and deliberately
 * spelled once more rather than shared through a helper that returns both — the
 * two callers want different work done, and a helper doing the expensive half
 * for the cheap caller is the defect this function exists to avoid.
 */
export function pageReaderInstalled(): boolean {
  if (serverBinary() === null) return false;
  const wanted = modelFiles();
  if (wanted.length === 0) return false;
  return wanted.every((name) => {
    try {
      return fs.statSync(modelPath(name)).size > 0;
    } catch {
      return false;
    }
  });
}

/**
 * Bytes under a directory, walked. Null when anything in it could not be read.
 *
 * NULL RATHER THAN A PARTIAL SUM, because the number this feeds is the one the
 * Remove button prints as "frees 3.2 GB" — and a sum that silently skipped an
 * unreadable subdirectory would promise back less than it takes, which is the
 * one direction that figure must never be wrong in. A missing directory is 0,
 * not null: nothing there is a measurement, not a failure.
 */
function bytesUnder(dir: string): number | null {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const under = bytesUnder(full);
      if (under === null) return null;
      total += under;
      continue;
    }
    try {
      total += fs.statSync(full).size;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * What Foundry has downloaded for the page reader, itemised for the "Models on
 * this machine" row.
 *
 * THE BINARY IS ONE ITEM AND THE WHOLE `bin/` DIRECTORY, not the executable's
 * own size. The CUDA build arrives with its runtime zip unpacked beside it —
 * several hundred megabytes of cuBLAS — and listing the 3 MB executable while
 * that sat unnamed in the same folder would be an inventory that hides most of
 * what it is inventorying.
 */
export function pageReaderFootprint(): { items: MachineModelItem[]; bytes: number | null } {
  const items: MachineModelItem[] = [];
  const record = readRecord();

  const binBytes = bytesUnder(binDir());
  if (binBytes === null || binBytes > 0) {
    const build = record === null || record.release.length === 0
      ? 'llama.cpp (the record of which build this is was lost)'
      : `llama.cpp ${record.release}`;
    items.push({
      name: build,
      detail: `The server that runs ${PAGE_READER_MODEL}`
        + `${record === null ? '' : ` (${record.accel})`}, in ${binDir()}.`,
      bytes: binBytes,
    });
  }

  /*
   * ── THE DIRECTORY, NOT THE CURRENT PAIR ───────────────────────────────────
   *
   * This loop used to walk the two file names this module held as constants, and
   * that was safe only while those names could never change. They can now: the
   * pair is the CATALOG's (`pagesForm`), and a re-vendored `model-lineup.json`
   * renames it — as Wave 61's did, from ggml-org's Q8/Q8 pair to anthonym21's
   * Q8 + F16 one. A machine that installed the reader before such a change holds
   * files the new pair does not name, and a list built from the new pair would
   * show a store of "nothing" over four gigabytes of superseded weights: invisible
   * exactly when somebody is looking at this screen to find disk space.
   *
   * So every file in `models/` is listed, and the ones the catalog no longer
   * names say so. The Remove button takes the whole directory either way.
   */
  const wanted = pagesPair();
  let present: string[] = [];
  try {
    present = fs.readdirSync(modelsDir(), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch { /* no models directory yet, which is 'nothing downloaded'. */ }

  for (const name of present) {
    let bytes: number;
    try {
      bytes = fs.statSync(modelPath(name)).size;
    } catch {
      continue;
    }
    const detail = wanted === null
      ? 'A page-reader file. This build\'s catalog has no page-reader row, so nothing here names it.'
      : name === wanted.mmproj
        ? `${PAGE_READER_MODEL}'s vision projector, from ${wanted.hf_repo}.`
        : name === wanted.file
          ? `${PAGE_READER_MODEL}'s weights, from ${wanted.hf_repo}.`
          : `Superseded: the catalog now names ${wanted.file} and ${wanted.mmproj}, so this file is `
            + 'left over from an earlier one and nothing reads it.';
    items.push({ name, detail, bytes });
  }

  const total = items.reduce<number | null>(
    (sum, item) => (sum === null || item.bytes === null ? null : sum + item.bytes),
    0,
  );
  return { items, bytes: total };
}

/**
 * Delete what Foundry downloaded for the page reader, and say what that freed.
 *
 * ── ONLY WHAT THIS APP PUT THERE ────────────────────────────────────────────
 *
 * `pageReaderDir()` is a directory this app creates, fills and owns — the
 * llama.cpp build, the two GGUF files and the install record, and nothing else
 * has ever written into it. So the removal is that directory, whole, and the
 * blast radius is stated by the path rather than by a list of globs that could
 * drift from what the installer actually wrote. Ollama's store is not touched
 * and could not be: it is somewhere else entirely, and Owen's ruling is that
 * *"ollama has its own thing going on and we should leave it be"*.
 *
 * ── THE SERVER COMES DOWN FIRST, AND ONLY IF IT IS OURS ─────────────────────
 *
 * Deleting a GGUF out from under a running llama-server is a reader that fails
 * its next page with an I/O error rather than with a sentence. `stopPageReader`
 * already knows the difference between the server this app started and one it
 * ADOPTED on port 8000: an adopted server is somebody else's process, it is left
 * running, and the files here are still ours to delete.
 *
 * ── AND IT IS ALWAYS SAID OUT LOUD ──────────────────────────────────────────
 *
 * SLOTS.md §5b: *"never silently: the settings row says what was removed and the
 * gigabytes freed. Re-download restores it."* The outcome carries the figure,
 * measured BEFORE the delete, because afterwards there is nothing left to
 * measure.
 */
export async function removePageReader(): Promise<RemovalOutcome> {
  const dir = pageReaderDir();
  const bytes = bytesUnder(dir);
  if (bytes === 0) {
    return {
      ok: true,
      freedBytes: 0,
      detail: 'There was nothing to remove — the page reader is not installed.',
    };
  }

  await stopPageReader('the page reader is being removed');

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      freedBytes: 0,
      detail: `The page reader could not be removed: ${(err as Error).message}`,
    };
  }

  const freed = bytes ?? 0;
  return {
    ok: true,
    freedBytes: freed,
    detail: bytes === null
      ? `The page reader was removed from ${dir}. Its size could not be measured first, so there `
        + 'is no figure to give for what that freed.'
      : `The page reader was removed from ${dir}, freeing ${gib(freed)}. Installing it again `
        + 'downloads it back.',
  };
}
