/**
 * End-to-end check of the BUILT-IN rubric runtime.
 *
 *   npm run build:electron
 *   npx tsc src/app/features/pdf-picker/services/rubric-encoder.ts \
 *     --outDir dist/rubric --module commonjs --target es2022 --skipLibCheck
 *   node --require cli/electron-stub.js tools/test-rubric-local.js [blocks.json]
 *
 * Needs the model installed (Settings -> Add-ons, or tools/aligner/rubric-publish.sh's
 * URL) and loads it for real, so it costs ~15 s and a few GB of RAM. It is the only
 * test that covers the seam that actually breaks: prompts from the real encoder,
 * inference through the real bridge, onto the real llama-server.
 *
 * What it is really asserting is that the prompt reaches the model VERBATIM. A
 * server-side chat template would still return fluent-looking text — the failure
 * shows up as categories that don't parse or don't exist, which is what the
 * coverage and illegal-category checks below are for.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const REPO_LOCAL = path.resolve(__dirname, '..');
const enc = (() => {
  for (const p of ['dist/rubric/features/pdf-picker/services/rubric-encoder.js',
                   'dist/rubric/rubric-encoder.js']) {
    try { return require(path.join(REPO_LOCAL, p)); } catch { /* next */ }
  }
  console.error('The encoder is not compiled. Run:\n  npx tsc ' +
    'src/app/features/pdf-picker/services/rubric-encoder.ts --outDir dist/rubric ' +
    '--module commonjs --target es2022 --skipLibCheck');
  process.exit(1);
})();
const { rubricClassify, rubricHealth, rubricModels } = require(path.join(REPO, 'dist/electron/rubric-bridge.js'));
const fs = require('fs');

const BLOCKS = process.argv[2]
  || '/Volumes/Callisto/training/rubric/unspeakable-truths/blocks.json';
const MODEL = 'rubric-v3-4b';

function toTextBlocks(blocks) {
  const perPage = new Map();
  return blocks.map((b) => {
    const n = perPage.get(b.page) ?? 0;
    perPage.set(b.page, n + 1);
    const f = b.lineBoxes && b.lineBoxes.length ? b.lineBoxes[0] : null;
    return { id: `p${b.page}b${n}`, page: b.page, x: b.x, y: b.y, width: b.w, height: b.h,
      text: b.text, font_size: b.fsize, font_name: 'OCR', char_count: b.text.length,
      region: '', category_id: '', line_count: b.lineCount, is_ocr: true, ocr_confidence: b.conf,
      is_bold: f && f.boldFrac !== undefined ? f.boldFrac >= 0.5 : undefined,
      is_italic: f && f.italicFrac !== undefined ? f.italicFrac >= 0.5 : undefined };
  });
}

let fails = 0;
const check = (name, ok, detail='') => {
  console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || !detail ? '' : ' — ' + detail));
  if (!ok) fails++;
};

async function main() {
  console.log('1. models list comes from the installed catalog (no server needed)');
  const ms = await rubricModels('', 'local');
  check('lists the installed model', ms.success && ms.models.includes(MODEL),
    JSON.stringify(ms));

  console.log('\n2. health answers from disk, without loading anything');
  const t0 = Date.now();
  const h = await rubricHealth('', 'local', MODEL);
  const healthMs = Date.now() - t0;
  check('loaded + adapter is the version-carrying id',
    h.success && h.loaded && h.adapter === MODEL, JSON.stringify(h));
  check(`fast (${healthMs}ms) — it did not spin up a server`, healthMs < 1000, `${healthMs}ms`);
  const unknown = await rubricHealth('', 'local', 'rubric-nope');
  check('an unknown model is an error, not a silent pass', !unknown.success);

  console.log('\n3. classify spawns the bundled server and answers in the trained format');
  const doc = JSON.parse(fs.readFileSync(BLOCKS, 'utf-8'));
  const version = enc.rubricVersionFor(MODEL);
  const dims = (doc.pageDimensions || []).map(d => d ? {width:d.width,height:d.height} : {width:0,height:0});
  const all = enc.encodeBook(toTextBlocks(doc.blocks), dims, { version, totalPages: dims.length });
  const pages = all.slice(40, 44);

  const started = Date.now();
  const res = await rubricClassify({
    backend: 'local', model: MODEL, endpoint: '', stop: enc.RUBRIC_STOP,
    pages: pages.map(p => ({ system: p.system, user: p.user, raw: enc.toRawPrompt(p) })),
  });
  check('classify succeeded', res.success, res.error || '');
  if (!res.success) { process.exit(1); }
  check('one answer per page', res.answers.length === pages.length);

  const legal = new Set(enc.rubricCategories(version));
  let total = 0, predicted = 0, illegal = 0;
  pages.forEach((p, i) => {
    const parsed = enc.parseAnswer(res.answers[i], p.blockIds, version);
    total += p.blockIds.length; predicted += parsed.size;
    for (const c of parsed.values()) if (!legal.has(c)) illegal++;
  });
  check(`every block labelled (${predicted}/${total})`, predicted === total);
  check('no illegal categories', illegal === 0, `${illegal}`);
  console.log(`  (${((Date.now()-started)/1000).toFixed(1)}s including model load)`);

  console.log('\n4. a second call reuses the running server');
  const t2 = Date.now();
  const res2 = await rubricClassify({
    backend: 'local', model: MODEL, endpoint: '', stop: enc.RUBRIC_STOP,
    pages: [{ system: pages[0].system, user: pages[0].user, raw: enc.toRawPrompt(pages[0]) }],
  });
  const warmMs = Date.now() - t2;
  check('succeeded', res2.success, res2.error || '');
  check(`warm (${(warmMs/1000).toFixed(1)}s) — no reload`, warmMs < 15000, `${warmMs}ms`);

  console.log('\n5. a missing raw prompt is refused, never re-templated server-side');
  const bad = await rubricClassify({
    backend: 'local', model: MODEL, endpoint: '',
    pages: [{ system: 's', user: 'u' }],
  });
  check('refused', !bad.success && /raw templated prompt/.test(bad.error||''), bad.error||'');

  const { stopRubricServer } = require(path.join(REPO, 'dist/electron/rubric-server.js'));
  await stopRubricServer();
  console.log('\nserver stopped.');
  console.log(fails ? `\n${fails} FAILURES\n` : '\nall checks passed\n');
  process.exit(fails ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
