/**
 * Unit test for the hyphen CORPUS-ATTESTATION PROOF (ai-cleanup-prepass.ts).
 *
 * Covers addTextToHyphenAttestation + proveHyphenVerdict, including the masking
 * contamination trap (a split's own second fragment must not attest itself) and the
 * guard against the REJECTED absence-based tier (no attestation either way = unproven,
 * NOT a join — that rule corrupts self-sufficient → selfsufficient).
 *
 * Run after `npx tsc -p tsconfig.electron.json`:
 *   node scripts/test-hyphen-corpus-proof.mjs
 */

import {
  createHyphenAttestation,
  addTextToHyphenAttestation,
  proveHyphenVerdict,
  extractHyphenPairs,
} from '../dist/electron/ai-cleanup-prepass.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function attest(...texts) {
  const att = createHyphenAttestation();
  for (const t of texts) addTextToHyphenAttestation(att, t);
  return att;
}

console.log('proveHyphenVerdict / addTextToHyphenAttestation');

// 1. JOIN proven: the concatenation is attested elsewhere, the compound is not.
{
  const att = attest('It was a hard ques-\ntion to answer.\nThe question stood unanswered.\n');
  check('ques-tion → join (question attested elsewhere)', proveHyphenVerdict('ques', 'tion', att), 'join');
}

// 2. HYPHEN proven: the compound is attested elsewhere on one line, the join is not.
{
  const att = attest('He was declared non-\nAryan by the state.\nEvery non-Aryan pastor was removed.\n');
  check('non-Aryan → hyphen (non-Aryan attested on one line)', proveHyphenVerdict('non', 'Aryan', att), 'hyphen');
}

// 3. MASKING CONTAMINATION TRAP: the ONLY occurrence of `tion` is the split's own
//    second fragment. Unmasked it would attest itself; masked it must not, and with
//    no other evidence the pair is unproven.
{
  const att = attest('It was a hard ques-\ntion to answer.\n');
  check('masked corpus does not attest the fragment `tion`', att.words.has('tion'), false);
  check('masked corpus does not attest the fragment `ques`', att.words.has('ques'), false);
  check('fragment-only corpus → unproven (null)', proveHyphenVerdict('ques', 'tion', att), null);
}

// 4. Attested BOTH ways → unproven, falls through to the model.
{
  const att = attest('A re-\nformed church.\nThe reformed church met.\nEvery re-formed body split again.\n');
  check('attested both ways → null', proveHyphenVerdict('re', 'formed', att), null);
}

// 5. Attested NEITHER way → unproven.
{
  const att = attest('A wholly unrelated sentence about weather.\n');
  check('attested neither way → null', proveHyphenVerdict('some', 'word', att), null);
}

// 6. REJECTED-TIER GUARD: `self-sufficient` split with no attestation of either form.
//    An absence-based rule ("sufficient never stands alone ⇒ fragment") would JOIN it
//    into `selfsufficient`. Absence is not proof — this must stay unproven.
{
  const att = attest('The village was self-\nsufficient by winter.\n');
  check('self-sufficient with no evidence → null (NOT join)', proveHyphenVerdict('self', 'sufficient', att), null);
  check('  and `sufficient` is not attested at all', att.words.has('sufficient'), false);
}

// 7. Compound halves must never enter `words` (the `-` boundary rule).
{
  const att = attest('Every non-Aryan pastor was removed.\n');
  check('compound does not contribute `non` to words', att.words.has('non'), false);
  check('compound does not contribute `aryan` to words', att.words.has('aryan'), false);
  check('compound is recorded lowercased in hyphenated', att.hyphenated.has('non-aryan'), true);
  check('surrounding plain words still attested', att.words.has('pastor'), true);
}

// 8. Case-insensitive proof (the split is capitalized mid-sentence, evidence is not).
{
  const att = attest('The Ger-\nman delegation arrived.\nA german delegation arrived earlier.\n');
  check('proof compares lowercased', proveHyphenVerdict('Ger', 'man', att), 'join');
}

// 9. The attestation keys line up with the pair keys applyHyphenJoins uses.
{
  const text = 'It was a hard ques-\ntion to answer.\nThe question stood.\n';
  const pairs = extractHyphenPairs(text);
  check('extractHyphenPairs yields the expected key', pairs.join(','), 'ques-tion');
  const [a, b] = pairs[0].split('-');
  check('that key proves join against its own corpus', proveHyphenVerdict(a, b, attest(text)), 'join');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
