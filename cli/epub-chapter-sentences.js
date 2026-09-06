/**
 * epub-chapter-sentences.js — the app's OWN sentence splitter, per epub chapter.
 *
 * The split step of `align_book_chapters.py`. It exists as a separate node process
 * for one reason: `splitSentences` is TypeScript that ships compiled in
 * `dist/electron/`, and a re-implementation in the driver would be a second
 * splitter that drifts from the one the app ships. This loads the real one — the
 * same module `whisperx-align-bridge.runEpubAlignOnFiles` calls — behind the same
 * `cli/electron-stub.js` the other CLI entry points use.
 *
 *   node --require ./cli/electron-stub.js cli/epub-chapter-sentences.js \
 *        --epub BOOK.epub --out chapters.json [--dist ../bookforge/dist]
 *
 * Writes {"paragraphAware":true,"joinedMatchesPerChapter":bool,
 *         "chapters":[{"index","title","chars","sentences":[{text,kind},...]}]}
 *
 * WHY PER-CHAPTER IS THE SAME SPLIT. The app joins chapters with '\n\n' and splits
 * the whole book at once, precisely so a chapter seam is a block boundary and the
 * last sentence of one chapter cannot fuse with the first heading of the next.
 * Splitting each chapter alone must therefore give the identical sentence list —
 * so this VERIFIES it rather than assuming it: it also runs the joined split and
 * reports `joinedMatchesPerChapter`. The driver refuses to run when that is false,
 * because then "the same splitter the app uses" would no longer be true.
 *
 * --dist points at a built `dist/` when this worktree has none (a git worktree has
 * no node_modules and must not be npm-installed). The compiled splitter is read,
 * never written.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) a[body.slice(0, eq)] = body.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a[body] = argv[++i];
    else a[body] = true;
  }
  return a;
}

function die(msg) { console.error(`[split] ${msg}`); process.exit(1); }

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (!a.epub || !a.out) die('usage: --epub BOOK.epub --out chapters.json [--dist DIR]');
  if (!fs.existsSync(a.epub)) die(`no epub at ${a.epub}`);

  const distDir = a.dist ? path.resolve(a.dist) : path.join(__dirname, '..', 'dist');
  const bridgePath = path.join(distDir, 'electron', 'whisperx-align-bridge.js');
  const epubPath = path.join(distDir, 'electron', 'epub-processor.js');
  for (const p of [bridgePath, epubPath]) {
    if (!fs.existsSync(p)) {
      die(`compiled module missing: ${p}\n` +
          `       pass --dist <path to a built dist> (this worktree has none, and ` +
          `installing one here is not allowed)`);
    }
  }
  const { splitSentences } = require(bridgePath);
  const { loadEpubForComparison } = require(epubPath);

  // Same call the align bridge makes: images off, headings marked.
  const { chapters } = await loadEpubForComparison(a.epub, false, true);
  if (!chapters || !chapters.length) die('epub yielded no chapters');

  const perChapter = chapters.map((c, i) => ({
    index: i,
    title: (c.title || c.name || '').toString(),
    chars: (c.text || '').length,
    sentences: splitSentences(c.text || '', true),
  }));

  // The verification described above.
  const joined = splitSentences(chapters.map((c) => c.text).join('\n\n'), true);
  const flat = perChapter.flatMap((c) => c.sentences);
  const same = joined.length === flat.length
    && joined.every((s, i) => s.text === flat[i].text && s.kind === flat[i].kind);
  if (!same) {
    const n = Math.min(joined.length, flat.length);
    let at = n;
    for (let i = 0; i < n; i++) {
      if (joined[i].text !== flat[i].text || joined[i].kind !== flat[i].kind) { at = i; break; }
    }
    console.error(`[split] WARNING: joined split (${joined.length}) and per-chapter split ` +
      `(${flat.length}) diverge at sentence ${at}`);
    console.error(`[split]   joined: ${JSON.stringify(joined[at] || null)}`);
    console.error(`[split]   chaptr: ${JSON.stringify(flat[at] || null)}`);
  }

  fs.writeFileSync(a.out, JSON.stringify({
    epub: path.resolve(a.epub),
    paragraphAware: true,
    joinedSentences: joined.length,
    joinedMatchesPerChapter: same,
    chapters: perChapter,
  }, null, 1), 'utf-8');
  console.log(`[split] ${chapters.length} chapter(s), ${flat.length} sentences ` +
    `(joined split ${joined.length}, identical=${same}) -> ${a.out}`);
  for (const c of perChapter) {
    const first = (c.sentences[0] || {}).text || '';
    console.log(`[split]   ${String(c.index).padStart(2)} ${String(c.sentences.length).padStart(5)} sents  ` +
      `${JSON.stringify(c.title).slice(0, 42).padEnd(44)} ${JSON.stringify(first.slice(0, 60))}`);
  }
})().catch((e) => die(e && e.stack ? e.stack : String(e)));
