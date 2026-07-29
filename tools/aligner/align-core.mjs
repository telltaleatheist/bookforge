/**
 * align-core — the EPUB-pair labelling engine, shared verbatim by the batch
 * CLI (align-pair.mjs) and the app's in-editor "Align from EPUB" action
 * (electron/main.ts imports this dynamically). One implementation, two hosts:
 * the CLI brings its own render+OCR; the app aligns blocks it already OCR'd.
 */

import * as path from 'path';
import { execFileSync } from 'child_process';
import * as cheerio from 'cheerio';

// ── text normalization (shared by both sides of the match) ───────────────────

export function normTokens(text) {
  return text
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

// ── 1. EPUB -> labeled segment stream ───────────────────────────────────────

function unzipList(file) {
  return execFileSync('unzip', ['-Z1', file], { encoding: 'utf-8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean);
}
function unzipRead(file, entry) {
  return execFileSync('unzip', ['-p', file, entry], { encoding: 'utf-8', maxBuffer: 64 << 20 });
}

const FRONT_HINTS = /titlepage|title-page|copyright|colophon|halftitle|imprint|dedication|epigraph|^toc|contents|cover/i;
const BACK_HINTS = /index|bibliograph|glossary|colophon-back/i;
const NOTE_HINTS = /footnote|endnote|rearnote|^notes?\b|\/notes?\./i;

/**
 * What a front/back document's blocks ARE, by the document's own filename.
 *
 * `front_matter` and `back_matter` were retired in Jul 2026 because they said
 * where a page sits, not what is on it — and a class defined by position
 * swallowed the headings, titles and lists that happened to fall in those page
 * ranges. The EPUB names its own sections, so the same filename hints that used
 * to route a document to a positional bucket now route it to a real class.
 *
 * Order matters: `contents` and `index` are checked before the title/imprint
 * patterns because a file called `index.xhtml` is usually the back-of-book
 * index, and a titlepage rarely calls itself anything else.
 */
const DOC_CLASS = [
  [/toc|contents|index|bibliograph|glossary|list-?of|chronolog/i, 'list'],
  [/dedication|epigraph/i, 'quote'],
  [/copyright|imprint|colophon|cip/i, 'body'],
  [/titlepage|title-page|halftitle|half-title|cover/i, 'title'],
];

/** Map one EPUB content document to labeled segments in document order. */
function segmentsFromDoc(html, docHref, docRole) {
  const $ = cheerio.load(html);
  const segments = [];
  const push = (cat, text) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) segments.push({ cat, text: t, doc: docHref });
  };

  // Whole-document roles win: a titlepage's <h1> is the book's title, not a
  // chapter opening. Split per element rather than pushing the whole body as
  // one segment — an index or a bibliography matches OCR blocks entry by
  // entry, and one 40 KB segment matches nothing.
  if (docRole === 'front' || docRole === 'back') {
    const cat = DOC_CLASS.find(([re]) => re.test(docHref))?.[1]
      // An unrecognised front/back document is prose until something says
      // otherwise — a preface or an afterword, which is what is left once the
      // named sections are accounted for.
      ?? 'body';
    const els = $('li, p, h1, h2, h3, h4, h5, h6, div');
    if (els.length) els.each((_, el) => {
      // Only leaves, or a wrapper div re-pushes everything nested inside it.
      if ($(el).children('li, p, h1, h2, h3, h4, h5, h6, div').length) return;
      push(cat, $(el).text());
    });
    else push(cat, $('body').text());
    return segments;
  }
  if (docRole === 'notes') {
    // Preserve per-note granularity so individual footnotes can match.
    const noteEls = $('li, p');
    if (noteEls.length) noteEls.each((_, el) => push('footnote', $(el).text()));
    else push('footnote', $('body').text());
    return segments;
  }

  $('body *').each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;
    const $el = $(el);
    // Only leaf-ish structural elements; skip containers whose text we'd double-count.
    if (tag === 'h1') {
      const t = $el.text();
      push(/^\s*(part|book)\b/i.test(t) ? 'title' : 'chapter', t);
    } else if (tag === 'h2') {
      push('heading', $el.text());
    } else if (/^h[3-6]$/.test(tag)) {
      push('subheading', $el.text());
    } else if (tag === 'blockquote') {
      push('quote', $el.text());
      $el.find('*').addBack().each((__, d) => { d.__consumed = true; });
    } else if (tag === 'figcaption') {
      push('caption', $el.text());
    } else if (tag === 'table') {
      push('table', $el.text());
      $el.find('*').addBack().each((__, d) => { d.__consumed = true; });
    } else if (tag === 'p' || tag === 'li') {
      if (el.__consumed) return;
      if ($el.parents('blockquote').length) return;      // already emitted as quote
      const type = ($el.attr('epub:type') || '') + ' ' + ($el.attr('class') || '');
      if (tag === 'li') {
        // TOC/landmark lists are front matter by taxonomy, not `list` — only
        // content lists count. nav docs are handled by their guide role.
        push('list', $el.text());
        return;
      }
      push(NOTE_HINTS.test(type) ? 'footnote' : 'body', $el.text());
    }
  });

  // A document with headings but no prose is a display page, not a chapter:
  // a title page (h1 "Animal Farm" + author line) or a part divider. Part
  // dividers already matched /^part|book/ above and are 'title'; a bare
  // book-title h1 on a prose-free page is the same thing — display type
  // standing alone — so it is 'title' too, not a chapter opening.
  const hasProse = segments.some(sg => sg.cat === 'body');
  const totalChars = segments.reduce((n, sg) => n + sg.text.length, 0);
  if (!hasProse && totalChars < 300) {
    for (const sg of segments) {
      if (sg.cat === 'chapter' || sg.cat === 'heading' || sg.cat === 'subheading') sg.cat = 'title';
    }
  }
  return segments;
}

export function parseEpub(file) {
  const entries = unzipList(file);
  const container = unzipRead(file, entries.find(e => e.endsWith('container.xml')));
  const opfPath = /full-path="([^"]+)"/.exec(container)[1];
  const opfDir = path.posix.dirname(opfPath);
  const opf = unzipRead(file, opfPath);
  const $opf = cheerio.load(opf, { xmlMode: true });

  const manifest = new Map();
  $opf('manifest > item').each((_, it) => {
    manifest.set($opf(it).attr('id'), $opf(it).attr('href'));
  });
  // guide/landmarks give explicit front-matter roles where present
  const guideRoles = new Map();
  $opf('guide > reference').each((_, r) => {
    const href = ($opf(r).attr('href') || '').split('#')[0];
    const type = $opf(r).attr('type') || '';
    if (/title-page|copyright|toc|dedication|epigraph|cover/i.test(type)) guideRoles.set(href, 'front');
    if (/index|bibliography/i.test(type)) guideRoles.set(href, 'back');
    if (/notes/i.test(type)) guideRoles.set(href, 'notes');
  });

  const spineHrefs = [];
  $opf('spine > itemref').each((_, ir) => {
    const href = manifest.get($opf(ir).attr('idref'));
    if (href && /x?html?$/i.test(href)) spineHrefs.push(href);
  });

  const segments = [];
  let sawChapter = false;
  for (const href of spineHrefs) {
    const full = opfDir && opfDir !== '.' ? `${opfDir}/${href}` : href;
    let html;
    try { html = unzipRead(file, full); } catch { continue; }

    let role = guideRoles.get(href) || null;
    if (!role) {
      if (NOTE_HINTS.test(href)) role = 'notes';
      else if (BACK_HINTS.test(href)) role = 'back';
      else if (!sawChapter && FRONT_HINTS.test(href)) role = 'front';
    }
    const docSegments = segmentsFromDoc(html, href, role);
    if (docSegments.some(s => s.cat === 'chapter' || s.cat === 'body')) sawChapter = true;
    segments.push(...docSegments);
  }
  return segments;
}

// ── 3. alignment ─────────────────────────────────────────────────────────────

export function buildStream(segments) {
  const words = [];       // normalized word stream
  const segOf = [];       // words[i] belongs to segments[segOf[i]]
  segments.forEach((seg, si) => {
    for (const w of normTokens(seg.text)) { words.push(w); segOf.push(si); }
  });
  // 4-gram index over the stream
  const index = new Map();
  for (let i = 0; i + 3 < words.length; i++) {
    const key = `${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`;
    let arr = index.get(key);
    if (!arr) index.set(key, arr = []);
    if (arr.length < 4) arr.push(i);   // cap: high-frequency grams are useless anyway
  }
  return { words, segOf, index };
}

/** Greedy two-pointer token match ratio of block tokens inside a stream window. */
function verify(blockTokens, words, start, end) {
  let i = Math.max(0, start), hit = 0;
  for (const t of blockTokens) {
    for (let j = i; j < Math.min(end, words.length); j++) {
      if (words[j] === t) { hit++; i = j + 1; break; }
    }
  }
  return blockTokens.length ? hit / blockTokens.length : 0;
}

export function align(blocks, stream) {
  const { words, segOf, index } = stream;

  // Anchor each block by voting over its low-frequency 4-grams
  const anchors = blocks.map(b => {
    const toks = normTokens(b.text);
    b.toks = toks;
    const votes = new Map();
    for (let i = 0; i + 3 < toks.length; i++) {
      const hits = index.get(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]} ${toks[i + 3]}`);
      if (!hits || hits.length > 2) continue;
      for (const pos of hits) {
        const est = pos - i;
        votes.set(est, (votes.get(est) || 0) + 1);
      }
    }
    let best = null;
    for (const [est, v] of votes) if (!best || v > best.v) best = { est, v };
    const need = toks.length >= 12 ? 2 : 1;
    return best && best.v >= need ? best.est : null;
  });

  // LIS over anchored blocks -> the monotone main flow. Off-flow anchors
  // (footnotes pointing into the endnotes section) survive on merit below.
  const idxAnchored = anchors.map((a, i) => a !== null ? i : -1).filter(i => i >= 0);
  const seq = idxAnchored.map(i => anchors[i]);
  const lisIdx = longestIncreasingSubsequence(seq);
  const onFlow = new Set(lisIdx.map(k => idxAnchored[k]));

  const results = blocks.map((b, bi) => {
    const est = anchors[bi];
    if (est !== null) {
      const ratio = verify(b.toks, words, est - 3, est + b.toks.length + 5);
      if (ratio >= (onFlow.has(bi) ? 0.55 : 0.7)) {   // off-flow needs stronger proof
        return { matched: true, pos: est, ratio };
      }
    }
    return { matched: false, pos: null, ratio: 0 };
  });

  // Unanchored blocks: interpolate a window from flow neighbours and rescan.
  for (let bi = 0; bi < blocks.length; bi++) {
    if (results[bi].matched) continue;
    let prev = null, next = null;
    for (let k = bi - 1; k >= 0; k--) if (results[k].matched && onFlow.has(k)) { prev = results[k].pos + blocks[k].toks.length; break; }
    for (let k = bi + 1; k < blocks.length; k++) if (results[k].matched && onFlow.has(k)) { next = results[k].pos; break; }
    if (prev === null && next === null) continue;
    const lo = Math.max(0, (prev ?? next - 600) - 40);
    const hi = Math.min(words.length, (next ?? prev + 600) + 40);
    const toks = blocks[bi].toks;
    if (!toks.length || hi - lo < toks.length) continue;
    let best = { ratio: 0, pos: null };
    const step = Math.max(1, Math.floor(toks.length / 2));
    for (let p = lo; p + toks.length <= hi; p += step) {
      const r = verify(toks, words, p, p + toks.length + 5);
      if (r > best.ratio) best = { ratio: r, pos: p };
    }
    if (best.ratio >= 0.6) results[bi] = { matched: true, pos: best.pos, ratio: best.ratio };
  }

  // Category by word-weighted majority over the matched span
  for (let bi = 0; bi < blocks.length; bi++) {
    const r = results[bi];
    if (!r.matched) continue;
    const count = new Map();
    for (let w = r.pos; w < Math.min(words.length, r.pos + blocks[bi].toks.length); w++) {
      const cat = segOf[w] !== undefined ? segOf[w] : null;
      if (cat !== null) count.set(cat, (count.get(cat) || 0) + 1);
    }
    let bestSeg = null, bestN = 0;
    for (const [si, n] of count) if (n > bestN) { bestN = n; bestSeg = si; }
    r.segIndex = bestSeg;
  }
  return results;
}

function longestIncreasingSubsequence(seq) {
  const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= seq[i]) lo = mid + 1; else hi = mid; }
    tails[lo] = seq[i];
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  let k = tailIdx[tails.length - 1];
  while (k >= 0) { out.push(k); k = prev[k]; }
  return out.reverse();
}

// ── 4. anchored elimination ─────────────────────────────────────────────────
//
// The matched prose is a per-page coordinate frame; unmatched blocks are then
// classified by where they stand relative to it. A print page's furniture was
// never IN the EPUB, but it doesn't need to be: above the first proven prose
// is header territory (or a chapter opening), below the last proven prose is
// footer/footnote territory, and an unmatched island beside a large text-free
// area is a caption beside its image. Same shape as the sentence-correction
// pipeline: known text anchors the frame, position fills in the rest.

export function furniture(blocks, results, segments) {
  const normed = blocks.map(b => normTokens(b.text.replace(/\d+/g, '#')).join(' '));
  const pagesByText = new Map();
  blocks.forEach((b, i) => {
    if (results[i].matched || !normed[i]) return;
    let s = pagesByText.get(normed[i]);
    if (!s) pagesByText.set(normed[i], s = new Set());
    s.add(b.page);
  });
  const repeats = i => (pagesByText.get(normed[i])?.size ?? 0) >= 3;
  const isPageNum = t => /^[0-9ivxlc]{1,5}$/i.test(t.trim());

  // Chapter/heading titles known from the EPUB, for above-flow disambiguation.
  const titleSet = new Map();
  segments.forEach(seg => {
    if (['chapter', 'heading', 'subheading', 'title'].includes(seg.cat)) {
      titleSet.set(normTokens(seg.text).join(' '), seg.cat);
    }
  });

  // Median body size across matched prose — footnotes read smaller than this.
  const proseSizes = blocks.filter((b, i) => results[i].matched && b.fsize > 0).map(b => b.fsize).sort((a, b) => a - b);
  const bodySize = proseSizes.length ? proseSizes[Math.floor(proseSizes.length / 2)] : 0;

  // Inline-footnote reclassification. EPUBs with popup/inline notes (Vellum
  // Kindle exports, EPUB3 asides) carry the footnote TEXT in the prose stream,
  // so a bottom-of-page footnote matches the EPUB like any paragraph and would
  // be stamped with its segment's category — silently mislabeling footnotes as
  // body. The match tells us the words are right; the GEOMETRY says what the
  // block is: bottom band, smaller than body type, marker-led. Once one
  // footnote is proven on a page, everything matched below it in small type is
  // its continuation.
  if (bodySize > 0) {
    const byPage = new Map();
    blocks.forEach((b, i) => {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page).push(i);
    });
    let prevPageEndedInNote = false;
    for (const page of [...byPage.keys()].sort((p, q) => p - q)) {
      const idxs = byPage.get(page);
      idxs.sort((p, q) => blocks[p].y - blocks[q].y);
      const last = idxs[idxs.length - 1];
      let noteTop = Infinity;
      for (const i of idxs) {
        const b = blocks[i];
        if (!results[i].matched || results[i].furniture) continue;
        const small = b.fsize > 0 && b.fsize < bodySize * 0.92;
        if (!small) continue;
        const marker = /^[*†‡§]|^[a-z]?\d{1,3}[.,)]?\s/.test(b.text.trim());
        const inBottomBand = b.y / b.pageH > 0.6;
        // A note that overran its page continues at the bottom of the next
        // one with no marker — the previous page ending in a footnote is the
        // evidence.
        const continuation = prevPageEndedInNote && inBottomBand && i === last && noteTop === Infinity;
        if ((marker && inBottomBand) || b.y >= noteTop || continuation) {
          results[i] = { matched: true, furniture: 'footnote', ratio: results[i].ratio, why: 'inline-footnote' };
          noteTop = Math.min(noteTop, b.y);
        }
      }
      prevPageEndedInNote = results[last].furniture === 'footnote';
    }
  }

  // Per-page prose envelope from on-flow matches (reclassified footnotes are
  // no longer prose — the envelope must not extend down to them).
  const envelope = new Map();   // page -> {top, bottom}
  blocks.forEach((b, i) => {
    if (!results[i].matched || results[i].furniture) return;
    const e = envelope.get(b.page) ?? { top: Infinity, bottom: -Infinity };
    e.top = Math.min(e.top, b.y);
    e.bottom = Math.max(e.bottom, b.y + b.h);
    envelope.set(b.page, e);
  });

  blocks.forEach((b, i) => {
    if (results[i].matched) return;
    const label = (furnitureCat, why) => { results[i] = { matched: true, furniture: furnitureCat, ratio: 1, why }; };
    const t = b.text.trim();
    const e = envelope.get(b.page);
    const yFrac = b.y / b.pageH;

    // Known chapter/heading title text wins wherever it sits on the page.
    const asTitle = titleSet.get(normTokens(t).join(' '));
    if (asTitle && t.length < 120) { label(asTitle, 'epub-title'); return; }

    if (isPageNum(t)) { label(yFrac < 0.5 ? 'header' : 'footer', 'pagenum'); return; }

    if (e) {
      const aboveFlow = b.y + b.h <= e.top + 2;
      const belowFlow = b.y >= e.bottom - 2;
      if (aboveFlow) {
        if (repeats(i)) { label('header', 'repeat-above'); return; }
        // Non-repeating text above all prose: a chapter/section opening.
        if (t.length < 100) { label('chapter', 'above-flow'); return; }
      }
      if (belowFlow) {
        if (repeats(i)) { label('footer', 'repeat-below'); return; }
        // Below all prose, not a page number, not matching prose -> footnote.
        // Smaller-than-body type or a leading marker corroborates; without
        // either it's still the best guess, but a weak one.
        const smaller = bodySize > 0 && b.fsize > 0 && b.fsize < bodySize * 0.95;
        if (smaller || /^[\d*†‡§]/.test(t)) { label('footnote', 'below-flow'); return; }
        label('footnote', 'weak:below-flow'); return;
      }
      // Inside the envelope but unmatched: caption candidate if it's a short
      // island (images leave text-free zones; hOCR reports no image regions,
      // so the island itself is the evidence).
      if (t.length < 200 && b.lineCount <= 4) { label('caption', 'weak:island'); return; }
    } else if (repeats(i)) {
      label(yFrac < 0.5 ? 'header' : 'footer', 'repeat-nofly');
    }
    // Everything else on a no-envelope page stays UNLABELED, on purpose.
    //
    // This branch used to fall back on position: before the first prose page ->
    // front_matter, after the last -> back_matter. That rule alone produced 18%
    // of the corpus and had to be undone by hand, because position is not a
    // category — an index, a bibliography, a title page and a dedication all
    // land after the last prose page and are four different things. Nothing
    // available here distinguishes them, so the honest output is no label and a
    // human decides. Same reason plates and part dividers between prose pages
    // were already left alone.
  });
}


// Thirteen since Jul 2026 — `front_matter`/`back_matter` were positional, not
// categorical, and `footnote_ref` had 2 examples in 42,759. Keep in step with
// CATEGORIES in build-sft-dataset.mjs and BLOCKCAT_CATEGORIES_V3 in
// blockcat-encoder.ts.
export const LABEL_SET = ['body','title','chapter','heading','subheading','quote','caption',
  'footnote','header','footer','image','table','list'];
