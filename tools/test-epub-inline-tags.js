// Inline tags add no space (2026-09-26): `<i>Keep focused</i>.` must extract as "Keep focused.", not
// "Keep focused ." - the blanket tag->space strip put a space before every punctuation mark that follows
// an italic run (~790 Mistborn cues, 2,179 in The Third Reich at War). Block tags still separate words.
const { EpubProcessor } = require('../dist/electron/epub-processor.js');
const p = new EpubProcessor();
const x = (h) => p['extractTextFromXhtml'](h);
const cases = [
  ['<p><i>Keep focused</i>.</p>', 'Keep focused.'],
  ['<p><i>Careful</i>, he told himself.</p>', 'Careful, he told himself.'],
  ['<p>beads that made men into <i>Mistborn</i>—<i>were</i> the reason</p>', 'beads that made men into Mistborn—were the reason'],
  ['<p>a <em>b</em> c</p>', 'a b c'],
  ['<p><span class="dropcap">W</span>ax ran.</p>', 'Wax ran.'],
  ['<p>one</p><p>two</p>', 'one\n\ntwo'],
  ['<div>x</div><div>y</div>', 'x y'],
  ['<p>He said<br/>no.</p>', 'He said\nno.'],
];
let fail = 0;
for (const [h, want] of cases) {
  const got = x(h);
  if (got !== want) { fail++; console.log(`FAIL ${JSON.stringify(h)} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`); }
}
console.log(`epub-inline-tags: ${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
