/**
 * higgs-override.js — ONE parser for the `--higgs-override <json>` argument both
 * render adapters take (orpheus-batch-render.js and orpheus-audiobook-render.js).
 *
 * WHY A JSON ARGUMENT AND WHY ONE PARSER (2026-09-12). Owen wanted the CLI to be
 * able to point a render at any checkpoint — "we should be able to pick any model
 * specifically, including a checkpoint we want to test, and it should allow that"
 * — with its own sampling and its own band. That is five or six values, and the
 * two adapters must read them IDENTICALLY: two hand-rolled flag blocks would
 * drift the moment a field is added, and then a `--tts` audition and an
 * `--audiobook` build of the same checkpoint would be two different renders with
 * nothing saying so. So the python wrapper composes ONE object and both adapters
 * parse it here.
 *
 * THIS FILE HAS NO POLICY. It parses the JSON, checks the SHAPE (which keys, of
 * which kind) and nothing else — no ranges, no "is this dir plausible", no
 * defaults. What a value MEANS is the bridge's business: it resolves the base
 * `fineTuned` voice from the catalog, renders the override against that voice's
 * certificate, and refuses a value it cannot honour by name. A second opinion
 * here would be a second implementation of the thing being tested.
 *
 * The shape mirrors `HiggsRenderOverride` in electron/parallel-tts-bridge.ts:
 *
 *   { checkpointDir?: string,
 *     sampling?: { temperature?: number, topP?: number, topK?: number },
 *     maxChars?: number, safeMinChars?: number, safeMaxChars?: number,
 *     note: string }
 *
 * `note` is REQUIRED — it is who ran this and why, and it is what a rendered
 * session carries forward. An override with no note is an unattributable render.
 */
'use strict';

/** Fields the object may carry, and the typeof each must be. */
const FIELDS = {
  checkpointDir: 'string',
  sampling: 'object',
  maxChars: 'number',
  safeMinChars: 'number',
  safeMaxChars: 'number',
  note: 'string',
};
const SAMPLING_FIELDS = ['temperature', 'topP', 'topK'];

/**
 * Parse and shape-check a `--higgs-override` payload.
 * @param {string} raw the JSON text as it arrived on argv
 * @returns {object} the override, ready to put on ParallelTtsSettings.higgsOverride
 */
function parseHiggsOverride(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('--higgs-override needs a JSON object (got '
      + (raw === true ? 'a bare flag' : JSON.stringify(raw)) + ')');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--higgs-override is not valid JSON: ${e && e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--higgs-override must be a JSON OBJECT, not '
      + (Array.isArray(parsed) ? 'an array' : JSON.stringify(parsed)));
  }
  for (const key of Object.keys(parsed)) {
    const want = FIELDS[key];
    if (!want) {
      throw new Error(`--higgs-override: unknown field '${key}' `
        + `(this build reads: ${Object.keys(FIELDS).join(', ')})`);
    }
    const got = parsed[key];
    if (key === 'sampling') {
      if (!got || typeof got !== 'object' || Array.isArray(got)) {
        throw new Error("--higgs-override.sampling must be an object of "
          + `${SAMPLING_FIELDS.join('/')}`);
      }
      for (const s of Object.keys(got)) {
        if (!SAMPLING_FIELDS.includes(s)) {
          throw new Error(`--higgs-override.sampling: unknown field '${s}' `
            + `(this build reads: ${SAMPLING_FIELDS.join(', ')})`);
        }
        if (typeof got[s] !== 'number' || !Number.isFinite(got[s])) {
          throw new Error(`--higgs-override.sampling.${s} must be a number `
            + `(got ${JSON.stringify(got[s])})`);
        }
      }
      continue;
    }
    if (typeof got !== want || (want === 'number' && !Number.isFinite(got))) {
      throw new Error(`--higgs-override.${key} must be a ${want} (got ${JSON.stringify(got)})`);
    }
  }
  // Attribution is not optional: the bridge stamps it, and a session whose
  // sampling nobody can account for is worse than no session.
  if (!parsed.note || !String(parsed.note).trim()) {
    throw new Error("--higgs-override.note is required — who ran this render and why "
      + '(the wrapper fills it from the command line unless --note says otherwise)');
  }
  return parsed;
}

/**
 * The adapters' one-liner: read `--higgs-override` off a parsed argv map, with the
 * engine gate. Both adapters call this so a Higgs-only override can never ride an
 * Orpheus render silently.
 *
 * @param {Record<string, string|true>} args parsed argv
 * @param {string} engine the resolved ttsEngine
 * @returns {object|undefined}
 */
function higgsOverrideFromArgs(args, engine) {
  const raw = args['higgs-override'];
  if (raw === undefined) return undefined;
  if (engine !== 'higgs') {
    throw new Error('--higgs-override carries a Higgs checkpoint/sampling/band; this run is '
      + (engine ? `--engine ${engine}` : 'not a render and names no engine')
      + '. Orpheus names a model directory with --model-dir.');
  }
  return parseHiggsOverride(raw);
}

module.exports = { parseHiggsOverride, higgsOverrideFromArgs };
