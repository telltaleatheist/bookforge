#!/usr/bin/env node
/**
 * A VOICE ROW MAY STATE NO LENGTH, AND THE EXTENSION HAS AN ANSWER FOR IT.
 *
 *   node tools/test-extension-voice-band.js
 *
 * ── The change this pins ────────────────────────────────────────────────────
 *
 * Crucible made `max_chars` optional on 2026-09-19 and retired `chunk_too_long`
 * with it (`crucible/docs/PHASE18-UNCERTIFIED.md` §4, `crucible/voices.py`'s
 * `_BACKEND_OPTIONAL`): a cap is a RESULT — the longest chunk a sweep on these
 * weights on this arm came back whole from — so a checkpoint being screened has
 * none, and the `/v1/voices` row reports `max_chars: null` meaning NOT
 * MEASURED. The render door stopped refusing by length at the same moment, so
 * there is no server-side backstop either: the client packs.
 *
 * Before this, the extension read `VoiceInfo.maxChars` into a private map,
 * handed it alone to `listenBandFromCaps`, and got the APP's refusal back —
 * a sentence naming `electron/data/higgs-models.json` and the Orpheus cap for a
 * same-named voice, neither of which exists in a browser extension. It arrived
 * at the moment somebody pressed play, on a voice the picker had offered and
 * the Load button had loaded.
 *
 * ── And the band that was on the wire all along ─────────────────────────────
 *
 * The same call dropped `pace.safeMinChars` / `safeMaxChars`, under a comment
 * asserting there was "no `safeMaxChars` on the wire". There is: it is `pace`
 * on the voice row (`VoicePace` in the SDK) and `electron/crucible/stream.ts`
 * has been handing `listenBandFromCaps` all three numbers, off the SAME row, on
 * the app's side of the SAME session since 2026-09-15. Two clients packing one
 * voice on one server to two bands is this repository's recurring defect — a
 * fact with two owners and nothing comparing them — and it is latent rather
 * than visible today only because every voice in the live catalog happens to
 * state `safe_max_chars == max_chars`.
 *
 * ── Why this EXECUTES instead of grepping ───────────────────────────────────
 *
 * `extension/src/voice-band.ts` was extracted to be executable: no DOM, no
 * `chrome.*`, no SDK client. `tools/test-extension-pairing.js` set the pattern
 * — esbuild the module to CJS and run the real thing — and it is what makes
 * "the picker offers exactly what the packer can answer for" a check rather
 * than a promise, because both surfaces call these two functions.
 *
 * NO GPU, NO SERVER, NO NETWORK.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'extension');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/** Bundle voice-band.ts to CJS so this runs it, rather than a copy of its logic. */
async function loadVoiceBand() {
  const esbuild = require(path.join(EXT, 'node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `bfr-voice-band-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(EXT, 'src/voice-band.ts')],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
  });
  const loaded = require(out);
  fs.unlinkSync(out);
  return loaded;
}

/** A row's length facts, with every field stated — nulls are answers here. */
const lengths = (maxChars, safeMinChars, safeMaxChars) =>
  ({ maxChars, safeMinChars, safeMaxChars });

async function main() {
  console.log('extension voice band (crucible PHASE18-UNCERTIFIED.md §4)');
  const vb = await loadVoiceBand();

  // ── 1. A screening checkpoint: no cap, no band ────────────────────────────

  check('a row stating no length in either spelling is NOT readable here', () => {
    assert.strictEqual(vb.isReadable(lengths(null, null, null)), false);
  });

  check('and says why, in this client\'s own words', () => {
    const why = vb.unreadableBecause('ds_ckpt_3658', 'owens-pc-wsl', lengths(null, null, null));
    assert.ok(why !== null, 'an unreadable voice must state a reason');
    assert.ok(/ds_ckpt_3658/.test(why), 'the reason must name the voice');
    assert.ok(/owens-pc-wsl/.test(why), 'the reason must name the server');
    assert.ok(
      !/higgs-models\.json|Orpheus|electron[\\/]/i.test(why),
      'the refusal reached the browser extension still naming the APP\'s catalog file or the '
      + `Orpheus cap. Neither exists here. Got: ${why}`,
    );
  });

  check('the packer refuses it BEFORE the shared helper does', () => {
    assert.throws(
      () => vb.bandFromVoiceRow('ds_ckpt_3658', 'owens-pc-wsl', lengths(null, null, null)),
      (err) => /no measured chunk length/.test(err.message)
        && !/higgs-models\.json/.test(err.message),
      'bandFromVoiceRow must refuse a capless voice in the extension\'s own words',
    );
  });

  // ── 2. A measured voice: BOTH spellings reach the band ────────────────────

  check('the safe ceiling wins over the cap, and the floor travels', () => {
    // deathstalker on this PC's Crucible, 2026-09-19: max_chars 800,
    // pace.safe_min_chars 500, pace.safe_max_chars 800. The pair is what
    // `electron/crucible/stream.ts` sends on the app's side of the same door.
    const band = vb.bandFromVoiceRow('deathstalker', 'owens-pc-wsl', lengths(900, 500, 800));
    assert.strictEqual(band.maxChars, 800, 'the MEASURED ceiling is the one packed to');
    assert.strictEqual(band.minChars, 500, 'the safe floor must reach the band');
  });

  check('a voice with a cap and no measured band packs to the cap', () => {
    // higgs-default, live today: max_chars 600 and a pace table whose every
    // member is null. Readable, and the cap is the only number there is.
    const band = vb.bandFromVoiceRow('higgs-default', 'owens-pc-wsl', lengths(600, null, null));
    assert.strictEqual(band.maxChars, 600);
    assert.strictEqual(band.minChars, null);
    assert.strictEqual(vb.isReadable(lengths(600, null, null)), true);
  });

  check('a band with no cap is still readable — the band IS the ceiling', () => {
    // `crucible/voices.py` checks `safe_max_chars <= max_chars` only when a cap
    // is stated, so a measured band on an uncapped arm is expressible and is a
    // length this extension can pack to.
    assert.strictEqual(vb.isReadable(lengths(null, 500, 800)), true);
    assert.strictEqual(vb.bandFromVoiceRow('x', 's', lengths(null, 500, 800)).maxChars, 800);
  });

  // ── 3. One answer, not two ────────────────────────────────────────────────

  check('the popup greys exactly the rows the packer refuses', () => {
    const popup = fs.readFileSync(path.join(EXT, 'src', 'popup.ts'), 'utf-8');
    assert.ok(
      /unreadableBecause\(/.test(popup) && /from '\.\/voice-band'/.test(popup),
      'the popup must decide a row is unofferable through voice-band.ts, not with a test of '
      + 'its own — a second opinion here is a voice you can select and cannot read',
    );
    assert.ok(
      /o\.disabled = .*unreadable !== null/.test(popup),
      'the popup no longer disables the option for a voice with no measured length',
    );
  });

  check('the offscreen packer keeps no private copy of the cap', () => {
    const off = fs.readFileSync(path.join(EXT, 'src', 'offscreen.ts'), 'utf-8');
    // CODE, not prose: the comment where that map used to be names it on
    // purpose, and a check that could not tell the two apart would force the
    // note out, which is worse than the drift it guards.
    assert.ok(
      !/voiceCaps\s*[.=]|\bvoiceCaps\s*\(/.test(off),
      'the `voiceCaps` map is back. The lengths belong to the row the pickers draw '
      + '(`VoiceRow.lengths`); a second copy beside it is the two-owner defect this replaced, '
      + 'and the popup could not see that map at all',
    );
    assert.ok(
      /bandFromVoiceRow\(/.test(off) && !/listenBandFromCaps\(/.test(off),
      'offscreen.ts must reach the shared packer through voice-band.ts so the picker and the '
      + 'packer cannot drift apart',
    );
  });

  check('and it carries the safe band off the row, not just the cap', () => {
    const off = fs.readFileSync(path.join(EXT, 'src', 'offscreen.ts'), 'utf-8');
    assert.ok(
      /safeMinChars: v\.pace\.safeMinChars/.test(off)
      && /safeMaxChars: v\.pace\.safeMaxChars/.test(off),
      '`VoiceInfo.pace` carries the measured band and the extension is dropping it again. The '
      + 'app reads all three off the same row (electron/crucible/stream.ts), so dropping two '
      + 'here is two clients packing one voice to two bands.',
    );
  });

  console.log(failures === 0 ? '\nThe band is the row\'s.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
