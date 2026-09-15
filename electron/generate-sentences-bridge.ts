/**
 * Generate-sentences bridge — transcribes an audiobook variant into a synced VTT
 * and links that VTT to the ONE variant it describes.
 *
 * Runs as a queue job ('generate-sentences'). Mirrors the video-assembly bridge's
 * shape: `startGenerateSentences(jobId, mainWindow, config)` returns immediately;
 * progress and completion ride 'generate-sentences:progress' / ':complete' events
 * keyed by jobId. The heavy lifting is transcribe-bridge (faster-whisper); this
 * bridge resolves the model + output path, then writes the variant's vttPath so the
 * bookshelf reader syncs text against THIS audiobook (never bleeding a TTS variant's
 * transcript onto an independently-recorded one — the bug this feature closes).
 */

import { publishBridgeEvent } from './bridge-events';
import { BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { transcribeAudiobook } from './transcribe-bridge.js';
import { whisperModelDir, getWhisperModelDef, isWhisperModelPresent, downloadWhisperModel } from './whisper-models.js';
import { isWhisperEnvInstalled, WHISPER_ENV_ID } from './components/whisper-env.js';
import { componentManager } from './components/component-manager.js';
import { getMainLogger } from './rolling-logger.js';
import * as manifestService from './manifest-service.js';
import { embedAndVerifyVtt, deleteSidecarsForM4b } from './metadata-tools.js';
import { regenerateBoundSidecars } from './sidecar-migration.js';
import { normalizeFsPath } from './path-utils.js';
import { runEpubAlign } from './whisperx-align-bridge.js';
import type { JobStageProgress } from './job-stages.js';

// A packaged app discards stdout, so console-only logs were invisible when a
// transcription job silently stalled. Route every step through the file logger
// (bookforge.log) so a stuck job leaves a trail of exactly where it stopped.
export function glog(msg: string, data?: unknown): void {
  data !== undefined ? console.log(msg, data) : console.log(msg);
  try { getMainLogger().info(msg, data); } catch { /* logger not ready */ }
}
export function gerror(msg: string, data?: unknown): void {
  data !== undefined ? console.error(msg, data) : console.error(msg);
  try { getMainLogger().error(msg, data); } catch { /* logger not ready */ }
}

export interface GenerateSentencesConfig {
  projectId: string;
  variantId: string;
  /** Absolute path to the audiobook m4b. */
  m4bPath: string;
  /** Whisper model id (small | medium | large-v3 | distil-large-v3). */
  modelId: string;
  /** ISO language code, or 'auto'. */
  language?: string;
  /**
   * Alignment method: 'whisper' transcribes the audio; 'epub-align' force-aligns
   * the project's ebook text to the audio for accurate read-along subtitles.
   * Absent = 'whisper'.
   */
  method?: 'whisper' | 'epub-align';
  /** When method='epub-align', the ebook ProjectVariant.id to align against. */
  epubVariantId?: string;
  /**
   * THE CALLER'S OWN VENUE for a whisper transcription: the NAME of a Crucible
   * server (or `local`), when the caller chose one — a CLI `--crucible-server`,
   * a row re-run on the machine it first ran on. Absent, the routing record
   * decides (`decideWhereGenerationRuns`: the legacy switch, then rank), exactly
   * as a render's venue is decided. Read only by the `whisper` method; the
   * `epub-align` method is a local WhisperX spawn and stays one (see
   * `electron/crucible/align.ts`'s header for why it is not ported).
   */
  crucible?: { server: string };
  /**
   * THE RUN'S ALREADY-RESOLVED VENUE (a queue row's `waitForResolved`), when
   * the caller has one. A later step follows its run and decides only when the
   * run has no venue yet (`venueForRunStep`); `crucible` must agree with it.
   */
  runVenue?: { where: 'crucible'; server: string };
}

interface ActiveJob {
  controller: AbortController;
  cancelled: boolean;
}

const activeJobs = new Map<string, ActiveJob>();

export function sendProgress(
  win: BrowserWindow,
  jobId: string,
  percentage: number,
  message: string,
  /** Stacked stage bars for the epub-align pipeline (undefined for the whisper path). */
  stages?: JobStageProgress[],
): void {
  publishBridgeEvent('generate-sentences:progress', { jobId, percentage, message, stages });
  if (win.isDestroyed()) return;
  win.webContents.send('generate-sentences:progress', { jobId, percentage, message, stages });
}

/**
 * Bind the transcript this run produced to the m4b it describes, FROM THE FILE
 * THE ALIGNER WROTE — before anything deletes it.
 *
 * WHY THIS EXISTS, and why the order is the whole point.
 *
 * This bridge used to be embed-only: embed into the m4b, delete the VTT, sweep
 * the sidecars, clear `vttPath`, on the doctrine that "the m4b IS the source of
 * truth". Two things make that wrong now.
 *
 *   THE CONTAINER LOSES CUES. mov_text cannot represent an empty cue, so the
 *   track is a lossy copy of what was embedded — the reassembly bridge stopped
 *   trusting it in Sep 2026 for exactly this ("a 133-cue book shipped as 132 and
 *   every later cue was off by one"). Deleting the VTT right after the embed
 *   destroys the only lossless copy, so nothing can ever tell whether the track
 *   is complete. Measured 2026-09-10 on Shift: after a re-align the m4b's track
 *   extracted to 14,092 cues where the book's sentence set is 14,377, and the
 *   285-cue difference was UNATTRIBUTABLE because the aligner's own file was
 *   already gone.
 *
 *   BOOKSHELF PREFERS THE SIDECAR. Its transcript ladder is bound sidecar first
 *   (a validated file read, no per-request ffmpeg), embedded extraction only as
 *   the fallback — and a DOWNLOAD needs a bound copy, because a downloaded book
 *   plays with no network at all. Leaving the binding stale meant every
 *   re-aligned book served the lossy extraction until bookshelf-server's lazy
 *   repair happened to run, and that repair binds the extraction, not the truth.
 *
 * So: embed (the track is a copy for players), then bind the REAL file, then let
 * the caller delete it. `regenerateBoundSidecars` writes `<m4b>.vtt` plus the
 * hash-bound `<m4b>.sidecars.json`, recording the m4b's sha256 AS IT IS NOW —
 * which is why this runs after the embed and not before it, the embed being what
 * changes those bytes.
 *
 * `manifest.vttPath` stays cleared and this does not touch it: Bookshelf resolves
 * a mono transcript through the BINDING, never through that field (it is read
 * only for bilingual pairs), so the two facts do not conflict.
 *
 * NEVER THROWS. The alignment is hours of compute and the embed already
 * succeeded; a book whose sidecar did not get written still plays, still carries
 * its track, and is repaired by bookshelf-server on first serve. Failing the job
 * here would throw away the run over its least important artifact.
 */
async function bindAlignedTranscript(m4bPath: string, vttPath: string): Promise<void> {
  try {
    const bound = await regenerateBoundSidecars(m4bPath, { vttPath });
    const action = bound?.vtt.action ?? 'none';
    if (action === 'written' || action === 'would-write') {
      glog(`[generate-sentences] transcript bound as a sidecar (source: ${bound?.vtt.source})`);
    } else {
      gerror(`[generate-sentences] sidecar binding produced NO transcript (vtt: ${action}) — `
        + 'players fall back to the m4b\'s own track, which is lossy for empty cues');
    }
  } catch (err) {
    gerror(`[generate-sentences] sidecar binding threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}


/** Compact H:MM:SS for an audio position (e.g. 3:07:42). */
function fmtDur(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function sendComplete(
  win: BrowserWindow,
  jobId: string,
  success: boolean,
  outputPath?: string,
  error?: string,
  warning?: string,
  /**
   * WHERE the transcription ran — `crucible:<server>`
   * — recorded on the completion so the queue row's artifact says which machine
   * transcribed the book, the way a render's saved state says which rendered it.
   */
  venue?: string,
  /** Present exactly on a Crucible `server_busy`: the SDK's holder line the queue holds the row on. */
  busyLine?: string,
): void {
  publishBridgeEvent('generate-sentences:complete', { jobId, success, outputPath, error, warning, venue, busyLine });
  if (win.isDestroyed()) return;
  win.webContents.send('generate-sentences:complete', { jobId, success, outputPath, error, warning, venue, busyLine });
}

/** One word for a venue, for the log and the completion record. */
function venueLabel(venue: { where: 'crucible'; server: string }): string {
  return `crucible:${venue.server}`;
}

export async function startGenerateSentences(
  jobId: string,
  mainWindow: BrowserWindow,
  config: GenerateSentencesConfig,
): Promise<void> {
  const controller = new AbortController();
  let workingVttPath: string | undefined;
  activeJobs.set(jobId, { controller, cancelled: false });
  glog(`[generate-sentences] START job=${jobId}`, {
    modelId: config.modelId, m4bPath: config.m4bPath, language: config.language,
  });

  try {
    // epub-align: force-align the project's own ebook text to the audio for
    // accurate read-along subtitles (the ebook is the ground truth — no ASR
    // spelling/word errors). This is an explicit method selection: alignment
    // failures must fail the job, never silently substitute Whisper transcription.
    if (config.method === 'epub-align') {
      if (!config.epubVariantId) {
        throw new Error('EPUB alignment requires an ebook version. Select an ebook and retry.');
      }
      const m4bPath = normalizeFsPath(config.m4bPath);
      if (!fs.existsSync(m4bPath)) throw new Error(`Audiobook not found: ${m4bPath}`);

      const { vttPath, cues, warning } = await runEpubAlign(jobId, mainWindow, config);
      workingVttPath = vttPath;
      if (activeJobs.get(jobId)?.cancelled) {
        sendComplete(mainWindow, jobId, false, undefined, 'Cancelled');
        return;
      }

      // Seal the aligned transcript into the m4b for players, and BIND IT AS THE
      // SIDECAR FROM THIS FILE — in that order, and the file is not deleted until
      // the binder has had it. See `bindAlignedTranscript` for why.
      try {
        const lang = config.language && config.language !== 'auto' ? { language: config.language } : undefined;
        const embedded = await embedAndVerifyVtt(m4bPath, vttPath, lang);
        if (!embedded) throw new Error('Embedded transcript verification failed');
        glog('[generate-sentences] embedded and verified aligned transcript in m4b');
        await bindAlignedTranscript(m4bPath, vttPath);
        try { fs.unlinkSync(vttPath); } catch { /* absent/already cleaned */ }
      } catch (err) {
        // The alignment itself (hours of compute) succeeded — only sealing it
        // into the m4b failed. Rescue the VTT as a stem-named sidecar next to
        // the m4b so the work isn't lost; the next successful embed removes it
        // via deleteSidecarsForM4b(). The temp copy is cleaned by the outer
        // finally either way.
        let note = '';
        try {
          const rescuePath = path.join(path.dirname(m4bPath), `${path.parse(m4bPath).name}.vtt`);
          fs.copyFileSync(vttPath, rescuePath);
          note = ` The aligned transcript was rescued to "${rescuePath}" — the alignment is not lost.`;
          gerror(`[generate-sentences] embed failed; VTT rescued to ${rescuePath}`);
        } catch { /* best-effort rescue; the embed error below is what matters */ }
        throw new Error(`${err instanceof Error ? err.message : String(err)}${note}`);
      }
      deleteSidecarsForM4b(m4bPath);

      // Link to the variant. Embed-only: clear vttPath (the m4b IS the source).
      const projectDir = manifestService.getProjectPath(config.projectId);
      const saved = await manifestService.modifyManifest(config.projectId, (mf) => {
        const cur = manifestService.getVariants(mf);
        mf.variants = cur.variants.map((v) => v.id === config.variantId ? { ...v, vttPath: undefined } : v);
        if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
        const v = mf.variants.find((x) => x.id === config.variantId);
        if (v && v.kind === 'audiobook' && mf.outputs?.audiobook
            && normalizeFsPath(path.resolve(path.join(projectDir, mf.outputs.audiobook.path)))
               === normalizeFsPath(path.resolve(m4bPath))) {
          mf.outputs.audiobook.vttPath = undefined;
        }
      });
      if (!saved?.success) throw new Error(saved?.error || 'Failed to link transcript to the version');

      glog(`[generate-sentences] epub-align DONE job=${jobId} m4b=${m4bPath} cues=${cues}${warning ? ` WARNING: ${warning}` : ''}`);
      sendProgress(mainWindow, jobId, 100, warning ? `Subtitles ready — with gaps: ${warning}` : 'Subtitles ready');
      sendComplete(mainWindow, jobId, true, m4bPath, undefined, warning);
      return;
    }

    const modelDef = getWhisperModelDef(config.modelId);
    if (!modelDef) throw new Error(`Unknown Whisper model: ${config.modelId}`);
    const modelDir = whisperModelDir(config.modelId);

    const m4bPath = normalizeFsPath(config.m4bPath);
    if (!fs.existsSync(m4bPath)) throw new Error(`Audiobook not found: ${m4bPath}`);

    // The VTT is an intermediate build artifact only. Generate it outside the
    // project so Generate Sentences never creates a persistent sidecar.
    const outVtt = path.join(os.tmpdir(), `bookforge-transcript-${jobId}-${Date.now()}.vtt`);
    workingVttPath = outVtt;

    /*
     * THE LOCAL SPAWN, EXACTLY AS IT HAS ALWAYS RUN — engine overlay, model
     * download, `transcribe_audiobook.py` on this machine's card. It is now a
     * closure because WHERE the transcription runs is decided first
     * (`transcribeAtVenue`, the same decision a render makes), and this is the
     * answer when the legacy switch is on. It is never a fallback: a Crucible
     * that refuses fails the row by name and this closure is not called.
     *
     * A cancel inside it THROWS 'Cancelled' rather than completing the job
     * itself: the catch below turns that one word into the completion it always
     * did, and the outer finally cleans the VTT.
     */
    const transcribeLocally = async (): Promise<{ cues: number }> => {
      // Engine overlay not installed yet → install it as part of the job (~35 MB
      // pip overlay into the runtime env). This is the ONLY place the engine is
      // required, so the picker never blocks on it — the queue owns the install,
      // where progress and failures are visible and logged.
      const engineInstalled = isWhisperEnvInstalled();
      glog(`[generate-sentences] engine installed=${engineInstalled}`);
      if (!engineInstalled) {
        sendProgress(mainWindow, jobId, 0, 'Installing the speech-to-text engine…');
        glog('[generate-sentences] installing engine overlay…');
        const inst = await componentManager.install(WHISPER_ENV_ID, (p) => {
          if (p.message) sendProgress(mainWindow, jobId, 0, p.message);
        });
        glog(`[generate-sentences] engine install result ok=${inst.ok}`, { error: inst.error });
        if (!inst.ok) throw new Error(inst.error || 'Failed to install the speech-to-text engine');
        if (activeJobs.get(jobId)?.cancelled) throw new Error('Cancelled');
      }

      // Model not on disk yet → download it first (deduped inside whisper-models,
      // so if the download dock already started it we join that run instead of
      // racing a second snapshot into the same dir). The job's bar stays at 0 with
      // the download percent in the message, so transcription owns the 0–100 range.
      const modelPresent = isWhisperModelPresent(config.modelId);
      glog(`[generate-sentences] model ${config.modelId} present=${modelPresent} dir=${modelDir}`);
      if (!modelPresent) {
        sendProgress(mainWindow, jobId, 0, `Downloading the ${modelDef.label} model…`);
        glog(`[generate-sentences] downloading model ${config.modelId}…`);
        const dl = await downloadWhisperModel(config.modelId, (p) => {
          // Drive the bar with the real download percent (this is its own 0–100
          // phase; transcription re-drives 0–100 after, distinguished by message)
          // so a multi-GB download never looks like a frozen 0%.
          sendProgress(mainWindow, jobId, p.pct, `Downloading the ${modelDef.label} model… ${p.pct}%`);
        });
        glog(`[generate-sentences] model download ok=${dl.ok}`, { error: dl.error });
        if (!dl.ok) throw new Error(dl.error || `Failed to download the ${modelDef.label} model`);
        if (activeJobs.get(jobId)?.cancelled) throw new Error('Cancelled');
      }
      if (!fs.existsSync(path.join(modelDir, 'model.bin'))) {
        throw new Error(`The ${modelDef.label} model isn’t downloaded yet.`);
      }

      sendProgress(mainWindow, jobId, 0, `Loading the ${modelDef.label} model…`);
      glog(`[generate-sentences] transcribe START audio=${m4bPath} out=${outVtt}`);

      // The script narrates its phases so a long book (where the percentage rounds to
      // 0 for minutes) still shows something moving: model load → decode → a live
      // "H:MM:SS / H:MM:SS · N sentences" position that ticks every ~1.5 s.
      let deviceLabel = 'GPU';
      const result = await transcribeAudiobook({
        audioPath: m4bPath,
        modelDir,
        outPath: outVtt,
        language: config.language || 'auto',
        device: 'auto',
        signal: controller.signal,
        onDevice: (dev) => {
          deviceLabel = dev === 'cuda' ? 'GPU' : 'CPU';
          glog(`[generate-sentences] transcribing on ${dev}`);
        },
        onStage: (stage) => {
          if (stage === 'loading') sendProgress(mainWindow, jobId, 0, `Loading the ${modelDef.label} model…`);
          else if (stage === 'decoding') sendProgress(mainWindow, jobId, 0, 'Decoding the audiobook…');
          else if (stage === 'transcribing') sendProgress(mainWindow, jobId, 0, `Transcribing on the ${deviceLabel}…`);
        },
        onDecodeProgress: (processedSec, totalSec) => {
          // Decode owns its own 0–100 pass on the bar (same pattern as the model
          // download above; transcription re-drives 0–100 after, distinguished by
          // message). With no container duration, show the moving position alone.
          if (totalSec > 0) {
            const pct = Math.min(100, Math.round((processedSec / totalSec) * 100));
            sendProgress(mainWindow, jobId, pct, `Decoding the audiobook… ${fmtDur(processedSec)} / ${fmtDur(totalSec)}`);
          } else {
            sendProgress(mainWindow, jobId, 0, `Decoding the audiobook… ${fmtDur(processedSec)}`);
          }
        },
        onProgress: (frac, detail) => {
          const pct = Math.round(frac * 100);
          const message = detail && detail.totalSec > 0
            ? `Transcribing on the ${deviceLabel}… ${fmtDur(detail.processedSec)} / ${fmtDur(detail.totalSec)} · ${detail.cues} sentence${detail.cues === 1 ? '' : 's'}`
            : `Transcribing on the ${deviceLabel}…`;
          sendProgress(mainWindow, jobId, pct, message);
        },
      });

      glog(`[generate-sentences] transcribe DONE ok=${result.ok}`, { cues: result.cues, device: result.device, error: result.error });

      if (activeJobs.get(jobId)?.cancelled) throw new Error('Cancelled');
      if (!result.ok) throw new Error(result.error || 'Transcription failed');
      return { cues: result.cues ?? 0 };
    };

    /*
     * WHERE IT RUNS — decided once, the way a render's venue is decided
     * (`electron/crucible/generation-venue.ts`: the caller's server, else the
     * legacy switch, else the routing record). On a Crucible the m4b goes up as
     * an `asr` job and the same VTT lands at `outVtt` (`electron/crucible/asr.ts`);
     * everything after this block — the embed, the sidecar binding, the
     * manifest link — reads that file and cannot tell which machine wrote it.
     *
     * A refusal (`server_busy` with the holder named, `model_not_installed`,
     * an unreachable server) fails the row by name. Nothing here transcribes
     * locally instead.
     */
    const { transcribeAtVenue } = await import('./crucible/asr.js');
    const { processVenueHost } = await import('./crucible/generation-venue.js');
    let venue: string;
    try {
      const outcome = await transcribeAtVenue({
        ...(config.crucible === undefined ? {} : { crucible: config.crucible }),
        ...(config.runVenue === undefined ? {} : { runVenue: config.runVenue, runVenueSource: 'the queue row' }),
        host: processVenueHost(),
        audioPath: m4bPath,
        whisperModelId: config.modelId,
        ...(config.language === undefined ? {} : { language: config.language }),
        outVttPath: outVtt,
        signal: controller.signal,
        onLog: (line) => glog(`[generate-sentences] ${line}`),
        onProgress: (p) => {
          // The same three phases the local script narrates, in the same words,
          // with the SERVER's position and fraction behind them.
          if (p.stage === 'warming') {
            sendProgress(mainWindow, jobId, 0, `Loading the ${modelDef.label} model on the server… ${p.message}`);
          } else if (p.stage === 'decoding') {
            const pos = p.processedSec !== null && p.totalSec !== null && p.totalSec > 0
              ? ` ${fmtDur(p.processedSec)} / ${fmtDur(p.totalSec)}`
              : p.processedSec !== null ? ` ${fmtDur(p.processedSec)}` : '';
            sendProgress(mainWindow, jobId, 0, `Decoding the audiobook on the server…${pos}`);
          } else {
            const pct = Math.round(p.fraction * 100);
            const message = p.processedSec !== null && p.totalSec !== null && p.totalSec > 0
              ? `Transcribing on the server… ${fmtDur(p.processedSec)} / ${fmtDur(p.totalSec)}`
                + (p.cues !== null ? ` · ${p.cues} segment${p.cues === 1 ? '' : 's'}` : '')
              : 'Transcribing on the server…';
            sendProgress(mainWindow, jobId, pct, message);
          }
        },
      });
      venue = venueLabel(outcome.venue);
      glog(`[generate-sentences] transcribed at ${venue} (${outcome.venue.origin}: ${outcome.venue.because}): ${outcome.cues} cue(s)`
        + (outcome.crucible ? ` (crucible job ${outcome.crucible.jobId}, ${outcome.crucible.model}@${outcome.crucible.revision})` : ''));
    } catch (err) {
      // A cancel that reached the server comes back as the job's `cancelled`
      // ending; the flag is what says it was ours, and the word is the one the
      // completion path has always read.
      if (activeJobs.get(jobId)?.cancelled) throw new Error('Cancelled');
      throw err;
    }

    // Seal the freshly-generated transcript INTO the m4b as a subtitle track — the
    // guaranteed audio↔transcript link the players read directly (immune to any
    // sidecar-name mismatch). Idempotent: a re-generate replaces the prior track.
    // The m4b is the single source of truth. A false verification result or ffmpeg
    // error fails the queue job; neither may be reported as successful.
    try {
      const lang = config.language && config.language !== 'auto' ? { language: config.language } : undefined;
      const embedded = await embedAndVerifyVtt(m4bPath, outVtt, lang);
      if (!embedded) throw new Error('Embedded transcript verification failed');
      glog('[generate-sentences] embedded and verified transcript in m4b');
      await bindAlignedTranscript(m4bPath, outVtt);
    } finally {
      try { fs.unlinkSync(outVtt); } catch { /* absent/already cleaned */ }
    }
    // Remove any legacy mono sidecars only after the new embedded track verifies.
    deleteSidecarsForM4b(m4bPath);

    // Link to the variant. Embed-only: the m4b IS the source of truth, so vttPath is
    // ALWAYS cleared (undefined drops the key on serialize) — never a sidecar path.
    const projectDir = manifestService.getProjectPath(config.projectId);
    const saved = await manifestService.modifyManifest(config.projectId, (mf) => {
      const cur = manifestService.getVariants(mf);
      mf.variants = cur.variants.map((v) => v.id === config.variantId ? { ...v, vttPath: undefined } : v);
      if (!mf.primaryVariantId) mf.primaryVariantId = cur.primaryVariantId;
      // Keep the legacy outputs.audiobook.vttPath cleared too when this is the primary
      // audiobook output.
      const v = mf.variants.find((x) => x.id === config.variantId);
      if (v && v.kind === 'audiobook' && mf.outputs?.audiobook
          && normalizeFsPath(path.resolve(path.join(projectDir, mf.outputs.audiobook.path)))
             === normalizeFsPath(path.resolve(m4bPath))) {
        mf.outputs.audiobook.vttPath = undefined;
      }
    });
    if (!saved?.success) throw new Error(saved?.error || 'Failed to link transcript to the version');

    glog(`[generate-sentences] embedded transcript linked to variant, DONE job=${jobId} m4b=${m4bPath} venue=${venue}`);
    sendProgress(mainWindow, jobId, 100, 'Transcript ready');
    sendComplete(mainWindow, jobId, true, m4bPath, undefined, undefined, venue);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generate sentences failed';
    if (message !== 'Cancelled') {
      gerror(`[generate-sentences] FAILED job=${jobId}: ${message}`, {
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
    // A 409 `server_busy` is a WAIT, not a failure (crucible ARCHITECTURE.md §3):
    // the SDK's own holder line rides on the completion so the queue step can
    // hold the row on it (`noteStepBusy`) rather than fail the book.
    const busyLine = err instanceof Error && typeof (err as { busyLine?: unknown }).busyLine === 'string'
      ? (err as unknown as { busyLine: string }).busyLine
      : undefined;
    sendComplete(mainWindow, jobId, false, undefined, message, undefined, undefined, busyLine);
  } finally {
    if (workingVttPath) {
      try { fs.unlinkSync(workingVttPath); } catch { /* absent/already cleaned */ }
    }
    activeJobs.delete(jobId);
  }
}

export function cancelGenerateSentences(jobId: string): void {
  // Kill the epub-align child FIRST and unconditionally. The flag below is only
  // COOPERATIVE — it is checked between stages — but the align stage is the long
  // one and never checks it, so before 2026-07-24 a cancel during align left
  // WhisperX running to completion and holding the GPU. cancelEpubAlign is a
  // no-op for whisper-method jobs and for jobs that already finished, so it is
  // safe to call before the activeJobs lookup (which returns early for a job
  // whose bookkeeping has already been torn down while its child still lives).
  void import('./whisperx-align-bridge.js')
    .then((m) => m.cancelEpubAlign(jobId))
    .catch(() => { /* module load failure must not block the flag below */ });
  const job = activeJobs.get(jobId);
  if (!job) return;
  job.cancelled = true;
  try { job.controller.abort(); } catch { /* already gone */ }
}
