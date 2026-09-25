/**
 * FORCED ALIGNMENT ON SOMEBODY ELSE'S CARD — the `align` door.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/coverage-align-job.ts` force-aligns a rendered session's chunks
 * against their text by spawning `narrator align --backend qwen3 --python
 * <the WSL qwen-align env>` — on this PC a spawn that crosses into the guest,
 * on the Mac a native one, on any other machine a refusal by name
 * (`qwen-aligner.ts`). A Crucible `align` job runs the same Qwen3-ForcedAligner
 * on a server (crucible `docs/PHASE4-AUDIO.md` §2): one input per chunk named
 * `<index>.flac`, one `{index, text}` per chunk in the params, a `cue` event as
 * each chunk lands, and one `alignment.json` artifact holding the model's own
 * timestamped items per chunk. This module is that job: it reads the session's
 * chunks, uploads their audio, submits, follows the cues, and lands
 * `alignment.json` (with its provenance sidecar) in the session's process
 * directory — beside where `coverage.json` goes.
 *
 * ── THE MODEL IS QWEN3. WHISPERX STAYS LOCAL, AND IS NOT PORTED ────────────
 *
 * `electron/whisperx-align-bridge.ts` (the whole-m4b "Generate sentences"
 * alignment, `align_audiobook.py`) lost the bake-off — 18x realtime and 39/61
 * chunk starts inside 0.1 s against qwen3's 229x and 51/61 on the same card
 * (`python/narrator/align/README.md`, 2026-09-08) — and PHASE4 §0 says in as
 * many words that `align` is not WhisperX. So there is no WhisperX arm here
 * and none is planned: {@link crucibleAlignerFor} refuses `whisperx` by name,
 * and that bridge keeps its local CPU spawn until it is deleted, not moved.
 *
 * ── WHERE THE OTHER HALF HAPPENS ──────────────────────────────────────────
 *
 * Crucible returns items in ITS OWN tokenization and asserts nothing about
 * words. Everything after that — the item-to-word mapping, the normalized
 * letter-sequence check that refuses a model which rewrote the text, the
 * derived word scores, the per-chunk gate, the sentence cues,
 * `<stem>.sentences.vtt` and `coverage.json` — is narrator's
 * (`python/narrator/align/{aligner,run,sentences,coverage}.py`), and PHASE4 §2
 * rules that it stays there: *"most of the value of the feature and none of the
 * value of a server"*.
 *
 * THAT DOOR IS BUILT (2026-09-18), and it is shape (a):
 * `narrator align --alignment <alignment.json>`. narrator builds its job list
 * exactly as it always did (manifest, `chunk_spans`, `spoken(chunk.text)`) and,
 * instead of loading a model, reads each chunk's items out of the document by
 * index, maps them onto `chunk_words(spoken)` with the existing
 * `_map_items_onto_words`, decodes the chunk locally for `detect_silences`,
 * derives scores and spans, and continues into cues/gate/coverage UNCHANGED.
 * BookForge's half is ONE spawn after this job (`runCoverageAlignOnCrucible`
 * hands it to `runCoverageAlignLocally`), and its parent interpreter is the
 * TOOLS env — no torch, no card, native on every platform — which is what lets
 * a Mac use a remote aligner at all.
 *
 * WHAT WAS HERE BEFORE: `narratorDoorOwedMessage` and a pre-submit refusal in
 * `queue-steps/align.ts`, both removed with the gap they named. They were
 * honest while they stood — a remote run would have spent GPU minutes on an
 * artifact nothing could read — but every alignment failed at its last step and
 * every book was sealed with an ESTIMATED transcript, and with the legacy local
 * narrator retired there was nothing else to run.
 *
 * Shape (b) — the transport inside narrator, BookForge handing it
 * url/token/model — was not taken. It keeps `spoken()` with one owner, but puts
 * an HTTP client for Crucible's wire into narrator's stdlib parent, which knows
 * no server and now has no reason to.
 *
 * {@link spokenTextForStoredChunk} must agree with narrator's `spoken()` letter
 * for letter; narrator's own equality check enforces that loudly on the first
 * chunk if it ever does not.
 *
 * ── The text sent is narrator's spoken reading ─────────────────────────────
 *
 * The aligner is handed `spoken(chunk.text)`: SML markers stripped, whitespace
 * collapsed (`python/narrator/text/paragraph_packer.py:spoken`,
 * `sml.py:SML_UNSPOKEN_PATTERN`). {@link spokenTextForStoredChunk} is that rule
 * in TypeScript, marker list included. R1 note: a second copy, checked by the
 * consumer — narrator compares the model's items against its own `spoken()` on
 * the letters alone, so a drift here (a sixth marker, say) is refused by name
 * on the first chunk rather than shipped as a slid transcript.
 *
 * **NO LEASE HERE.** This is ONE job on the lane, and a job already holds
 * everything a Crucible lease would hold — see `job.ts`'s header for the whole
 * argument, and `lease.ts` for the chat-shaped doors that do lease.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JobEvent } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import {
  CrucibleJobRefused,
  assertCrucibleModelOffered,
  runCrucibleJob,
  type CrucibleJobOutcome,
  type CrucibleJobProgress,
} from './job';
import { planAlignInputs, uploadEveryChunk, type AlignInputPlan } from './render-holds';

// ─────────────────────────────────────────────────────────────────────────────
// The model id table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BookForge's aligner backend name (`narrator align --backend`) → Crucible
 * `align` manifest id (`crucible/align/qwen3-aligner.toml`). One row, because
 * one aligner is the app's (Owen, 2026-09-08). `whisperx` is deliberately
 * absent — see the header.
 */
export const CRUCIBLE_ALIGNER_BY_BOOKFORGE_BACKEND: Readonly<Record<string, string>> = {
  qwen3: 'qwen3-aligner',
};

/** The backend every app door passes. `coverageAlignArgs` spells the same word. */
export const BOOKFORGE_ALIGN_BACKEND = 'qwen3';

/** A backend, a session or a document this door cannot work with, named. */
export class CrucibleAlignRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleAlignRefused';
    this.code = code;
  }
}

/** Which Crucible aligner runs this BookForge backend. */
export function crucibleAlignerFor(backend: string): string {
  const id = (backend ?? '').trim();
  if (id === 'whisperx') {
    throw new CrucibleAlignRefused(
      'crucible_aligner_whisperx_local_only',
      'whisperx has no Crucible aligner and will not get one: it lost the bake-off to qwen3 '
      + '(python/narrator/align/README.md, 2026-09-08) and PHASE4-AUDIO.md §0 rules that `align` is '
      + 'not WhisperX. The whole-m4b whisperx door (whisperx-align-bridge.ts) stays a local CPU spawn.',
    );
  }
  const mapped = CRUCIBLE_ALIGNER_BY_BOOKFORGE_BACKEND[id];
  if (mapped === undefined) {
    throw new CrucibleAlignRefused(
      'crucible_aligner_unmapped',
      `aligner backend "${id}" has no Crucible manifest in CRUCIBLE_ALIGNER_BY_BOOKFORGE_BACKEND `
      + `(mapped: ${Object.keys(CRUCIBLE_ALIGNER_BY_BOOKFORGE_BACKEND).join(', ')}).`,
    );
  }
  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The session's chunks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `SML_UNSPOKEN_PATTERN` (`python/narrator/text/sml.py`): the five TTS-SML
 * tags plus `pause` and `silence`, open or close, with an optional `:arg`.
 */
const SML_UNSPOKEN_RE = /\[\/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]/gi;

/** `paragraph_packer.spoken`: markers stripped, whitespace collapsed, trimmed. */
export function spokenTextForStoredChunk(stored: string): string {
  return stored.replace(SML_UNSPOKEN_RE, '').replace(/\s+/g, ' ').trim();
}

/** Where a session keeps its per-chunk FLACs: `<processDir>/chapters/sentences/<index>.flac`. */
export function sessionSentencesDir(processDir: string): string {
  return path.join(processDir, 'chapters', 'sentences');
}

/** The artifact's name on the server, and the file's name in the session. */
export const CRUCIBLE_ALIGNMENT_NAME = 'alignment.json';

/** Where this door lands the alignment: beside `coverage.json`. */
export function crucibleAlignmentPath(processDir: string): string {
  return path.join(processDir, CRUCIBLE_ALIGNMENT_NAME);
}

export interface SessionAlignChunk {
  readonly index: number;
  /** The spoken text — what narrator hands its own aligner. */
  readonly text: string;
  readonly audioPath: string;
  /** Its size as stat'd here — what proves the server's copy is these bytes (render-holds.ts). */
  readonly size: number;
}

export interface SessionAlignChunks {
  readonly chunks: readonly SessionAlignChunk[];
  /** Indices with nothing to align and why: marker-only text, or no audio on disk. */
  readonly skipped: readonly { readonly index: number; readonly reason: string }[];
}

/**
 * Every chunk of a session that can be aligned, from the session's own record.
 *
 * `<processDir>/session-state.json` → `chapter_sentences`, flattened in
 * chapter order — the exact list narrator's `flatten_sentences` indexes, so
 * chunk N is `N.flac` (the same read `correct-sentences-bridge.ts` and the
 * render seam make). Two kinds of chunk are SKIPPED and named, never failed:
 * a marker-only chunk speaks nothing (narrator's own `align_session` skips
 * it with reason `no spoken text`), and a chunk with no FLAC is a render that
 * produced nothing — Crucible refuses `invalid_inputs` for a chunk whose audio
 * is absent, and that refusal would be about the whole job rather than the one
 * chunk, so those are left out here and reported.
 *
 * `indices` narrows to a subset (narrator's `--indices`); absent means all.
 */
export function sessionAlignChunks(processDir: string, indices?: readonly number[]): SessionAlignChunks {
  const statePath = path.join(processDir, 'session-state.json');
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, 'utf-8');
  } catch (err) {
    throw new CrucibleAlignRefused(
      'crucible_align_session_state_missing',
      `${statePath} could not be read: ${err instanceof Error ? err.message : String(err)}. Prep writes `
      + 'it when the render starts.',
    );
  }
  let state: { chapter_sentences?: unknown };
  try {
    state = JSON.parse(raw);
  } catch (err) {
    throw new CrucibleAlignRefused(
      'crucible_align_session_state_unreadable',
      `${statePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const chapters = state.chapter_sentences;
  if (!Array.isArray(chapters)) {
    throw new CrucibleAlignRefused(
      'crucible_align_session_state_unreadable', `${statePath} has no chapter_sentences list`,
    );
  }
  const stored: string[] = [];
  chapters.forEach((chapter, ci) => {
    if (!Array.isArray(chapter)) {
      throw new CrucibleAlignRefused(
        'crucible_align_session_state_unreadable', `${statePath}: chapter_sentences[${ci}] is not a list`,
      );
    }
    for (const s of chapter) stored.push(String(s ?? ''));
  });

  const wanted = indices === undefined ? null : new Set(indices);
  const sentencesDir = sessionSentencesDir(processDir);
  const chunks: SessionAlignChunk[] = [];
  const skipped: { index: number; reason: string }[] = [];
  stored.forEach((text, index) => {
    if (wanted !== null && !wanted.has(index)) return;
    const spoken = spokenTextForStoredChunk(text);
    if (spoken === '') {
      skipped.push({ index, reason: 'no spoken text' });
      return;
    }
    const audioPath = path.join(sentencesDir, `${index}.flac`);
    let size: number;
    try {
      size = fs.statSync(audioPath).size;
    } catch {
      skipped.push({ index, reason: 'no audio on disk' });
      return;
    }
    if (size === 0) {
      skipped.push({ index, reason: 'empty audio file' });
      return;
    }
    chunks.push({ index, text: spoken, audioPath, size });
  });
  if (wanted !== null) {
    for (const index of wanted) {
      if (index < 0 || index >= stored.length) {
        throw new CrucibleAlignRefused(
          'crucible_align_index_out_of_range',
          `chunk ${index} was asked for and this session has ${stored.length} chunk(s)`,
        );
      }
    }
  }
  return { chunks, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────

/** One `cue` event: a chunk's items as the model tokenized them, or its failure. */
export type CrucibleAlignCue =
  | { readonly index: number; readonly items: readonly { text: string; start: number; end: number }[] }
  | { readonly index: number; readonly error: string };

export interface CrucibleAlignProgress {
  readonly stage: 'warming' | 'aligning';
  readonly fraction: number;
  readonly message: string;
  /** Off the frame's `extra` (`processed`, `total`), when the server sent them. */
  readonly processed: number | null;
  readonly total: number | null;
}

export interface RunCrucibleAlignOptions {
  readonly server: string;
  /** The session's HASH directory. `alignment.json` lands here. */
  readonly processDir: string;
  /** The aligner's ISO language code. The server refuses one outside its eleven, by name. */
  readonly language: string;
  /** BookForge's backend name, mapped through {@link crucibleAlignerFor}. */
  readonly backend: string;
  readonly chunks: readonly SessionAlignChunk[];
  readonly onProgress?: (progress: CrucibleAlignProgress) => void;
  readonly onCue?: (cue: CrucibleAlignCue) => void;
  /** Each chunk FLAC as it lands on the server, before the job exists. */
  readonly onUploaded?: (uploaded: { readonly done: number; readonly total: number }) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface CrucibleAlignOutcome {
  readonly jobId: string;
  /** `<processDir>/alignment.json`, with `alignment.json.provenance.json` beside it. */
  readonly alignmentPath: string;
  readonly provenancePath: string;
  /** How many chunks went up. */
  readonly chunks: number;
  /** Indices whose chunk failed, off the `done` frame's authoritative `failed`. */
  readonly failed: readonly number[];
  /** How many `cue` events arrived. */
  readonly cues: number;
}

function readCue(data: Readonly<Record<string, unknown>>): CrucibleAlignCue {
  const index = data['index'];
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    throw new CrucibleAlignRefused('crucible_align_cue_unreadable', 'a cue event carries no integer index');
  }
  if (typeof data['error'] === 'string') return { index, error: data['error'] };
  const items = data['items'];
  if (!Array.isArray(items)) {
    throw new CrucibleAlignRefused(
      'crucible_align_cue_unreadable', `cue ${index} carries neither items nor error`,
    );
  }
  return {
    index,
    items: items.map((item, i) => {
      if (typeof item !== 'object' || item === null) {
        throw new CrucibleAlignRefused('crucible_align_cue_unreadable', `cue ${index} item ${i} is not an object`);
      }
      const row = item as Record<string, unknown>;
      const { text, start, end } = row;
      if (typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
        throw new CrucibleAlignRefused(
          'crucible_align_cue_unreadable', `cue ${index} item ${i} is not {text, start, end}`,
        );
      }
      return { text, start, end };
    }),
  };
}

/**
 * Align these chunks on a Crucible and land `alignment.json` in the session.
 *
 * Every chunk's FLAC is uploaded under its index, the whole list goes up in
 * ONE job (the aligner stays resident across a book — PHASE4 §2 — and one
 * lane admission is one admission), and the artifact is written by the SDK's
 * atomic writer with its sidecar first. `done.extra.failed` is read strictly:
 * a failed chunk does not fail the job on the server (§2's ruling: "a failed
 * chunk is reported, the run continues") and it does not fail it here either;
 * the list is returned for the narrator half to estimate those chunks.
 */
export async function runCrucibleAlign(options: RunCrucibleAlignOptions): Promise<CrucibleAlignOutcome> {
  const { server, processDir } = options;
  const log = options.onLog ?? (() => undefined);

  if (typeof processDir !== 'string' || processDir === '' || !fs.existsSync(processDir)) {
    throw new CrucibleAlignRefused(
      'crucible_align_session_missing', `the session directory is not on disk: ${processDir}`,
    );
  }
  if (typeof options.language !== 'string' || options.language.trim() === '') {
    throw new CrucibleAlignRefused(
      'crucible_align_language_not_named',
      'a Crucible alignment needs the language the book was rendered in; the aligner does not '
      + 'fall back to English for a language it was not told.',
    );
  }
  if (!Array.isArray(options.chunks) || options.chunks.length === 0) {
    throw new CrucibleAlignRefused(
      'crucible_align_no_chunks',
      'no chunk to align — every selected chunk is marker-only or has no audio (see sessionAlignChunks).',
    );
  }
  const model = crucibleAlignerFor(options.backend);

  // BEFORE the uploads: a host with no `align` — the Mac, where qwen3-aligner
  // has no mlx-darwin block and the capability is off — says so now
  // (`crucible_align_not_offered`), not after a book's worth of FLACs went up.
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await assertCrucibleModelOffered(client, server, 'align', model);

  // THE RENDER'S FILES WHERE THE SERVER STILL HOLDS THEM, the rest uploaded
  // (render-holds.ts, Crucible 1.0.38).
  const plan = await planAlignInputs(client, server, processDir, options.chunks, log);
  const params = {
    language: options.language.trim(),
    chunks: options.chunks.map((c) => ({ index: c.index, text: c.text })),
  };

  let cues = 0;
  const submit = (inputs: AlignInputPlan['inputs']): Promise<CrucibleJobOutcome> => runCrucibleJob({
    server,
    type: 'align',
    model,
    params,
    inputs,
    artifactsTo: processDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onUploaded === undefined ? {} : { onUploaded: options.onUploaded }),
    onLog: log,
    onEvent: (event: JobEvent) => {
      // `cue` is a kind this SDK does not model; it arrives as `unknown` with
      // its name and data intact, which is the contract (types.d.ts, UnknownEvent).
      if (event.event === 'unknown' && event.kind === 'cue') {
        cues += 1;
        options.onCue?.(readCue(event.data));
      }
    },
    onProgress: (p: CrucibleJobProgress) => {
      if (options.onProgress === undefined) return;
      if (p.kind === 'warming') {
        options.onProgress({ stage: 'warming', fraction: 0, message: p.message, processed: null, total: null });
        return;
      }
      const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      options.onProgress({
        stage: 'aligning',
        fraction: p.fraction,
        message: p.message,
        processed: numberOrNull(p.extra['processed']),
        total: numberOrNull(p.extra['total']),
      });
    },
  });

  /*
   * A NAMED FILE THE SERVER LOST BETWEEN THE PLAN AND THE SUBMIT is refused
   * `artifact_expired` before the job exists — the one moment it can happen is
   * the collector running in between. Every chunk then goes up as a file, once:
   * that is how a server is given bytes it does not have, not a second try at
   * the same thing.
   */
  let outcome: CrucibleJobOutcome;
  try {
    outcome = await submit(plan.inputs);
  } catch (err) {
    if (!(err instanceof CrucibleJobRefused && err.code === 'artifact_expired' && plan.referenced > 0)) throw err;
    log(`crucible "${server}" no longer holds a render file the align named (${err.message}); `
      + `uploading all ${options.chunks.length} chunk(s)`);
    outcome = await submit(uploadEveryChunk(options.chunks).inputs);
  }

  if (outcome.artifacts.where !== 'disk') {
    throw new CrucibleAlignRefused('crucible_align_artifact_missing', 'artifacts were not written to disk');
  }
  const written = outcome.artifacts.files.get(CRUCIBLE_ALIGNMENT_NAME);
  if (written === undefined) {
    throw new CrucibleAlignRefused(
      'crucible_align_artifact_missing',
      `crucible "${server}" job ${outcome.jobId} ended done without ${CRUCIBLE_ALIGNMENT_NAME} `
      + `(it wrote: ${[...outcome.artifacts.files.keys()].join(', ') || 'nothing'}).`,
    );
  }
  const rawFailed = outcome.done.extra['failed'];
  if (!Array.isArray(rawFailed) || !rawFailed.every((i) => typeof i === 'number')) {
    throw new CrucibleJobRefused(
      'crucible_protocol', server,
      `the align job's done frame carries no integer \`failed\` list (crucible/jobs/align: done_extra)`,
    );
  }
  const failed = rawFailed as number[];
  log(`crucible "${server}" aligned ${options.chunks.length} chunk(s), ${failed.length} failed`
    + `${failed.length > 0 ? ` (${failed.slice(0, 20).join(',')}${failed.length > 20 ? ',…' : ''})` : ''}; `
    + `${written.name} → ${written.path}`);

  return {
    jobId: outcome.jobId,
    alignmentPath: written.path,
    provenancePath: written.provenancePath,
    chunks: options.chunks.length,
    failed,
    cues,
  };
}
