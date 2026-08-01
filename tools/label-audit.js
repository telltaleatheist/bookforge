#!/usr/bin/env node
/**
 * label-audit — have a local reasoning model AUDIT derived page-layout labels.
 *
 *   node tools/label-audit.js --book what-to-expect [--model cogito:14b]
 *        [--pages 10] [--think] [--json out.json]
 *
 * WHY AUDIT RATHER THAN RELABEL. Asking a general model to classify every block
 * from scratch just builds a worse rubric — rubric is a 4B fine-tuned on 57k
 * hand-labelled blocks and beats any zero-shot prompt at this. What a general
 * model with reasoning IS good at is spotting a label that contradicts its own
 * context: a "body" block of nine characters sitting alone at the top of the
 * page, a "caption" nowhere near an image, a running head labelled as prose.
 * So it sees the derived label and is asked to disagree, not to guess.
 *
 * That framing also makes the output cheap to verify. A relabelling pass gives
 * you thousands of opinions with nothing to check them against; an audit gives
 * you a short list of disagreements, and a human can settle each one in seconds.
 * The disagreement list is the deliverable — the agreement rate is not evidence
 * of anything on its own, because a model that rubber-stamps everything scores
 * 100%.
 *
 * The labels under audit come from aligning OCR blocks to an independent EPUB's
 * markup (`<h3>` -> subheading, `<figcaption>` -> caption). That channel is
 * trustworthy for what content IS and blind to how it was LAID OUT: this book's
 * printed tables are `<div class="box">` in the EPUB, so `table` cannot come
 * from it at all. Expect the audit to find layout-vs-semantics disagreements,
 * and treat those as the interesting cases rather than as noise.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const book = opt('book', 'what-to-expect');
const model = opt('model', 'cogito:14b');
const maxPages = Number(opt('pages', '10'));
const think = flag('think');
const jsonOut = opt('json', null);

const DIR = path.join('/Volumes/Callisto/training/rubric/epub-derived', book);
const rows = fs.readFileSync(path.join(DIR, 'dataset.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map(JSON.parse).slice(0, maxPages);

// The taxonomy, stated the way a general model needs it — rubric's own prompt
// assumes a fine-tune that already knows these; a zero-shot model does not.
const TAXONOMY = `body        running prose, the paragraphs a narrator would read aloud
title       the book's own title, on a title page or half-title
chapter     a chapter opening — number and/or chapter name, usually large, high on a fresh page
heading     a section heading inside a chapter
subheading  a heading below a section heading; smaller, often bold, introduces a short passage
quote       block quotation or pulled-out epigraph, usually indented or set narrower
caption     text describing an adjacent image, table or figure
footnote    a note at the foot of the page, usually smaller type
header      a running head repeated across pages (book or chapter title), at the very top
footer      a folio or running foot at the very bottom — usually just a page number
image       a picture, figure or illustration (may carry no text of its own)
table       tabular matter: rows and columns, often numeric
list        an itemised or bulleted list`;

const SYSTEM = `You audit page-layout labels for scanned book pages. You will be shown every text block on one page, with its position, size and text, plus the label each block was assigned. Your job is to find labels that are WRONG.

The label set:
${TAXONOMY}

How to judge:
- Position matters. y0 near 0 is the top of the page, y1 near 100 is the bottom.
- Font size matters, but RELATIVELY. Compare a block against the body text on the same page, not against an absolute number. One or two points above body is ordinary variation, not a heading.
- Context matters. A caption sits next to an image. A subheading is followed by prose.
- These labels came from an ebook edition's markup, which knows what content IS but not how the printed page was LAID OUT. Printed tables in this book were reflowed into boxes, so a genuinely tabular block may be mislabelled body or list.

Rules that override your instinct — these are the mistakes auditors actually make:
- A RUNNING HEAD USUALLY CONTAINS THE PAGE NUMBER. "YOUR NEWBORN 125" at the very top of the page is a header, not a title. Do not flag it.
- "title" means the BOOK's title on its title page. A book has one. Past the opening pages it is essentially never correct, no matter how title-like the text looks.
- A block whose text begins mid-sentence, begins lowercase, or ends without terminal punctuation is body text continuing across a column or page break. It is not a heading, however it is set.
- Headings and subheadings are SHORT and self-contained. A full sentence, or a clause that only makes sense joined to its neighbour, is body.
- A folio — a bare page number alone at the bottom — is a footer, not a caption or body.

Be conservative, and understand the asymmetry: a false flag costs a human the time to check it and, if believed, corrupts a correct label. A missed error costs one label out of thousands. When you are unsure, say nothing. Most labels are correct; a page with no errors is the normal outcome and reporting [] is a good answer, not a lazy one.

Reply with ONLY a JSON array, no prose around it. One object per block you believe is mislabelled:
[{"block": <number>, "is": "<assigned label>", "should": "<correct label>", "why": "<one short sentence>"}]
Reply with [] if every label is right.`;

function renderPage(row) {
  const lines = row.blocks.map((b) => {
    const [x0, y0, x1, y1] = b.bbox;
    const pc = (v) => Math.round(v * 100);
    const text = (b.text || '').replace(/\s+/g, ' ').trim();
    const shown = text.length > 180 ? `${text.slice(0, 150)} … ${text.slice(-25)}` : text;
    return `${b.i}. [x${pc(x0)}-${pc(x1)} y${pc(y0)}-${pc(y1)}] size${b.fsize} lines${b.lines} chars${b.chars}`
      + ` -> LABELLED "${row.labels[String(b.i)] ?? '?'}"\n   ${shown || '(no text — image region)'}`;
  });
  return `Page ${row.page} of ${row.pages}, page is ${row.pageWidth}x${row.pageHeight}pt.\n\n${lines.join('\n')}`;
}

async function ask(system, user) {
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      options: { temperature: 0, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const body = await res.json();
  return body.message?.content ?? '';
}

/**
 * The model may wrap JSON in prose or a fence despite instructions.
 *
 * The <think> strip is not optional for a reasoning model. Cogito's deep-thinking
 * mode emits its reasoning first, and that reasoning QUOTES THE PAGE — including
 * block coordinates like "[x38-92 y4-6]". A parser that scans for the first `[`
 * therefore starts inside the reasoning and produces garbage, which is why the
 * first 32b run reported every page unparseable while the model was in fact
 * answering correctly.
 */
function parseVerdicts(text) {
  const thought = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = thought.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : thought;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

(async () => {
  // Cogito's reasoning mode is opt-in via this exact system-prompt line.
  const system = think ? `Enable deep thinking subroutine.\n\n${SYSTEM}` : SYSTEM;
  const findings = [];
  let unparseable = 0, blocks = 0;
  const started = Date.now();

  console.log(`[audit] ${rows.length} pages of ${book} through ${model}${think ? ' (deep thinking)' : ''}`);

  for (const [n, row] of rows.entries()) {
    blocks += row.blocks.length;
    let out;
    try {
      out = await ask(system, renderPage(row));
    } catch (err) {
      console.error(`\n[audit] page ${row.page}: ${err.message}`);
      continue;
    }
    const verdicts = parseVerdicts(out);
    if (verdicts === null) {
      unparseable++;
      process.stderr.write(`\r[audit] ${n + 1}/${rows.length} pages  ${findings.length} flagged  ${unparseable} unparseable  ${((Date.now() - started) / 1000).toFixed(0)}s   `);
      continue;
    }
    for (const v of verdicts) {
      const b = row.blocks.find((x) => x.i === Number(v.block));
      findings.push({
        page: row.page,
        block: Number(v.block),
        assigned: row.labels[String(v.block)] ?? null,
        modelSays: v.should,
        why: v.why,
        // Carried so a human can settle the disagreement without opening the book.
        text: (b?.text || '').replace(/\s+/g, ' ').slice(0, 160),
        bbox: b?.bbox,
        fsize: b?.fsize,
      });
    }
    process.stderr.write(`\r[audit] ${n + 1}/${rows.length} pages  ${findings.length} flagged  ${unparseable} unparseable  ${((Date.now() - started) / 1000).toFixed(0)}s   `);
  }
  process.stderr.write('\n');

  const byPair = {};
  for (const f of findings) {
    const k = `${f.assigned} -> ${f.modelSays}`;
    byPair[k] = (byPair[k] ?? 0) + 1;
  }

  console.log(`\n${model} audited ${blocks} blocks across ${rows.length} pages`);
  console.log(`  flagged ${findings.length} (${(findings.length / blocks * 100).toFixed(1)}%)   unparseable pages ${unparseable}`);
  console.log(`  elapsed ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log('\n  disagreements by kind (labelled -> model says)');
  for (const [k, n] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(26)} ${n}`);
  }
  console.log('\n  the flags themselves');
  for (const f of findings.slice(0, 40)) {
    console.log(`    p${f.page} #${f.block}  ${f.assigned} -> ${f.modelSays}  (size${f.fsize})`);
    console.log(`       "${f.text}"`);
    console.log(`       ${f.why}`);
  }

  if (jsonOut) {
    const p = jsonOut.replace(/^~(?=\/)/, os.homedir());
    fs.writeFileSync(p, JSON.stringify({ book, model, think, pages: rows.length, blocks, findings, byPair }, null, 1));
    console.log(`\n[audit] wrote ${p}`);
  }
})();
