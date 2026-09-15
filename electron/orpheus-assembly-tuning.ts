/**
 * PER-VOICE ASSEMBLY TUNING FOR SESSIONS RENDERED BY THE RETIRED ENGINE.
 *
 * Orpheus is retired — it cannot be selected and it cannot render
 * (`shared/tts/engine-caps.ts`, docs/LEGACY-REMOVAL.md). But **audiobooks are
 * never deleted**, and a session rendered by it last month can still be
 * reassembled today: the Reassemble door, a CLI audiobook rebuild, a variant
 * re-cut. Those runs read the voice's tuned gap and its post-render filter, and
 * an assembly that quietly used different numbers from the ones the audio was
 * made with is a re-cut that does not match the original.
 *
 * So the TUNING survives the engine. Three readers and one constant, over the
 * shipped catalog `electron/data/orpheus-models.json`.
 *
 * ── What did NOT survive, and why this file is small ───────────────────────
 *
 * `orpheus-models.ts` resolved these through the local MODELS DIRECTORY — which
 * on Windows was typically a `\wsl$` UNC path — so it also owned custom-voice
 * discovery, base/adapter install states, half-download detection and a WSL
 * liveness gate in front of every `fs` call. All of that is weights machinery and
 * Crucible owns weights now, so it is gone. What is left reads a JSON file that
 * ships with the app.
 *
 * ONE CONSEQUENCE, STATED RATHER THAN HIDDEN: a voice that existed only as a
 * hand-dropped folder in the old models directory no longer resolves, so it
 * declares no tuning and the caller sees `undefined` — which is the same answer
 * the old code gave for any unresolvable id, and the callers already treat it as
 * "this voice declares none". The five voices BookForge ships are unaffected.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface TuningRow {
  id: string;
  token?: string;
  postRenderFilter?: string;
  sentenceGap?: number;
  minChunkGap?: number;
}

/**
 * The universal, user-VISIBLE inter-sentence gap default (seconds) for a voice
 * whose catalog row declares no tuned `sentenceGap` — i.e. the gap tests were
 * never run for it.
 *
 * Surfaced pre-filled in the assembly page's gap field rather than hidden, so a
 * person knows they are looking at the "untested voice" default and can override
 * it. **This is the single permitted default in the gap feature; no other code
 * path may invent one.** 0.6 s reproduces the historical baked gap Orpheus
 * produced.
 */
export const DEFAULT_SENTENCE_GAP = 0.6;

let cache: TuningRow[] | null = null;

/**
 * The shipped catalog, read once.
 *
 * A read failure is REPORTED and then treated as an empty catalog, which is the
 * one place this file is deliberately quiet: an assembly must not fail because a
 * retired engine's tuning file is unreadable, and every caller already handles
 * "this voice declares no tuning". The log line is what makes it findable.
 */
function rows(): TuningRow[] {
  if (cache !== null) return cache;
  const candidates = [
    path.join(__dirname, 'data', 'orpheus-models.json'),
    path.join(app.getAppPath(), 'electron', 'data', 'orpheus-models.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { models?: TuningRow[] };
      cache = Array.isArray(parsed.models) ? parsed.models : [];
      return cache;
    } catch {
      /* try the next location */
    }
  }
  console.warn(
    '[ORPHEUS-TUNING] orpheus-models.json could not be read from '
    + `${candidates.join(' or ')}. Sessions rendered by the retired Orpheus engine will `
    + 'reassemble with no per-voice gap or filter — the audio is untouched, but a re-cut '
    + 'may not match the original.',
  );
  cache = [];
  return cache;
}

/** A voice's row, by catalog id or by the prompt token an old session recorded. */
function rowFor(id: string | undefined | null): TuningRow | undefined {
  if (!id) return undefined;
  return rows().find((r) => r.id === id || r.token === id);
}

/**
 * The voice's post-render ffmpeg filter, or undefined when it declares none.
 *
 * The SHARED read-path handler: both assembly sites call it — the direct
 * TTS-then-assemble path and the reassembly/CLI path — so the value is resolved
 * identically everywhere rather than in two places that can drift.
 */
export function resolveOrpheusPostRenderFilter(id: string | undefined | null): string | undefined {
  return rowFor(id)?.postRenderFilter;
}

/**
 * The per-voice assembly-time inter-sentence gap (seconds), RAW — undefined when
 * the voice declares none. Callers apply {@link DEFAULT_SENTENCE_GAP} visibly,
 * so "untested" never looks like "tuned to 0.6".
 */
export function resolveOrpheusSentenceGap(id: string | undefined | null): number | undefined {
  return rowFor(id)?.sentenceGap;
}

/**
 * The voice's assembly-time FLOOR on chunk trailing silence, in seconds.
 * Undefined = no floor, i.e. chunk joins are the model's bare trained tail.
 *
 * Measured over 1151 chunks of The Mysterious Stranger: median 0.81 s, p10
 * 0.39 s, min 0.00 s — the short ones collide audibly, which is what a floor is
 * for.
 */
export function resolveOrpheusMinChunkGap(id: string | undefined | null): number | undefined {
  return rowFor(id)?.minChunkGap;
}
