#!/usr/bin/env node
/**
 * test-foundry-clean-text-vendor — the narration text pass left this repository,
 * and this is the proof that what left is what arrived, and that it has not
 * moved since.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-05: the narration text cleanup MOVES INTO THE FOUNDRY ENGINE as
 * a third ledger action beside translate and simplify, named "Clean text".
 * Foundry becomes the owner of `NORMALIZER_VERSION` and
 * `PUNCTUATION_SPEC_VERSION` and the source the `orpheus-finetune` training repo
 * vendors from.
 *
 * That ownership is worth nothing unless the handover can be PROVED, and a pair
 * of commit messages on the other side is not a proof this side can run.
 *
 * ── TWO ASSERTIONS, because there are two different questions ───────────────
 *
 * **1. THE HANDOVER.** At Foundry's vendor commits — `f2e3c2d` for the pass's
 * own ten files, `770480d` for the three leaves it imports — every file is
 * byte-identical to BookForge at `0f962d5f`. That is the anchor
 * `check_vendored.py` and `PROVENANCE.json` on the training side pin to, and it
 * is the sentence "not one byte changed" made checkable.
 *
 * **2. THE SHIPPED SNAPSHOT.** At `9f4ee4e` — the Foundry commit
 * `foundry-app/` is vendored from, which is the code this app actually runs
 * against — eight of the thirteen are STILL byte-identical, and the other five
 * were changed by one commit (`215294a`) that says exactly what it did to each.
 * Those five are pinned by sha256 here, with the reason beside them. So the
 * documented port passes and a later, undocumented edit fails — which is the
 * only distinction that matters, and the one a plain "are they identical" check
 * cannot draw.
 *
 * A REGENERATED PIN IS A DECISION, not a chore. If this keeper fails on a file
 * in tier 2, the answer is to read Foundry's commit and decide whether the
 * change is a port or a rule move; a rule move means the corpora and the renders
 * normalize differently and `NORMALIZER_VERSION` should have moved with it.
 *
 * ── What is compared, and why by name ───────────────────────────────────────
 *
 * Both sides are read out of GIT, never off a working tree:
 *
 *   - BookForge's copies at `0f962d5f`, the commit Foundry's vendor message
 *     names as its source. Reading them from git is what lets this keeper keep
 *     working after those files are DELETED from this working tree — the whole
 *     point of the move is that they are not here any more, and history is where
 *     the anchor lives.
 *   - Foundry's copies read with `git -C <foundry> show`, so the assertion does
 *     not depend on the state of that checkout's working tree (which has its own
 *     session moving in it) and cannot be fooled by an uncommitted edit.
 *
 * EVERY PAIR IS SPELLED OUT. A glob over `src/clean/` would silently stop
 * checking a file the day it was renamed, and a rename is precisely the event
 * this exists to catch. The map is the contract.
 *
 * ── The one normalization ───────────────────────────────────────────────────
 *
 * CR is stripped from both sides and nothing else is touched. BookForge has
 * `core.autocrlf=true`; git stores both sides LF-normalized, so this is belt and
 * braces rather than a loosening — but a byte comparison that failed only on
 * Windows because of a line ending would be a keeper nobody trusts, and an
 * untrusted keeper gets skipped.
 *
 * ── When the Foundry checkout is not here ───────────────────────────────────
 *
 * It SKIPS BY NAME and exits 0. This suite asserts a fact about two repositories
 * and one of them is not vendored into this one; a machine with no Foundry
 * checkout cannot answer the question, and failing there would mean the keeper
 * set is red on every machine but Owen's. The skip says which paths were tried,
 * so "it passed" and "it did not run" are never the same line.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** BookForge's commit the pass was vendored FROM — Foundry's `f2e3c2d` names it. */
const BOOKFORGE_ANCHOR = '0f962d5f';

/**
 * WHAT TIER 2 IS ASKED ABOUT — the commit THE BINARY REPORTS.
 *
 * THIS WAS A FIXED COMMIT UNTIL 2026-09-13 AND THAT WAS THE BUG. It read
 * `const FOUNDRY_SHIPPED = '9f4ee4e'` — a snapshot from 2026-09-05 — and by the
 * time anyone looked, Foundry was **46 commits past it, 7 of them touching
 * `src/clean/`**. So a keeper whose stated question is "does the code we ship
 * still hold the rules we handed over" was answering it about an engine nobody
 * runs, and passing.
 *
 * It passed through a real divergence. Foundry's `SPOKEN_AS_WORD` lost `covid`
 * (its copy was hard-coded; ours reads `caps_acronyms.json`), so `foundry
 * clean-text` ACCEPTED an edit spelling COVID letter by letter while this
 * repo's identical pass REFUSED it — two implementations of ONE pass, both
 * stamping `n6`, disagreeing about what the validator forbids. This keeper
 * existed precisely to catch that and could not see it.
 *
 * THE DIAGNOSIS, from the Foundry session that found the second half: a keeper
 * anchored to a commit **is the same shape as the bug it guards** — a copy of a
 * fact kept current by hand, so it drifts silently, and it is most silent
 * exactly when it matters. Pinning was never the mechanism; the DECISION is
 * (see "A REGENERATED PIN IS A DECISION" above). A fixed anchor removed the
 * moment at which anyone decides.
 *
 * ── WHY THE BINARY AND NOT THE CHECKOUT ────────────────────────────────────
 *
 * The first fix asked `git -C <foundry> rev-parse HEAD`. That is better than a
 * constant and still wrong, because the checkout is not what runs: BookForge
 * spawns an INSTALLED BINARY (`resolveFoundryPath`), which may be older than the
 * checkout, newer than it, or the only foundry on a machine that has no checkout
 * at all. Asking the checkout answers a question about a directory nobody
 * executes.
 *
 * `foundry --version` prints `foundry <ver> (<short sha>)`. The sha is injected
 * at release time (`tools/release-build.sh`, `--define FOUNDRY_GIT_COMMIT`) and
 * inlined into the executable, so it is the identity of the bytes that will
 * actually run. That is the anchor.
 *
 * A BUILD WITH NO SHA IS "CANNOT VERIFY", NEVER "USE THE CHECKOUT". A dev build
 * (`bun run src/cli.ts`) prints `foundry <ver>` with no parenthesis, and
 * foundry's `version.ts` is explicit that this is the truth about that build
 * rather than a missing value. Falling back to the checkout's HEAD there would
 * re-create the exact hazard this fix removes, and would do it precisely on a
 * developer machine — where the checkout is most likely to be ahead of the
 * binary. So it fails, saying which binary could not identify itself.
 *
 * `FOUNDRY_HEAD_OVERRIDE` pins the anchor for one run, to bisect a failure or to
 * check a specific commit. Deliberately an env var and not a constant: a
 * constant is what got us here.
 */
function foundryShipped(repo) {
  const override = process.env['FOUNDRY_HEAD_OVERRIDE']?.trim();
  if (override) return { rev: override, source: 'FOUNDRY_HEAD_OVERRIDE' };

  const binary = foundryBinary(repo);
  if (binary === null) {
    throw new Error(
      'no foundry binary to ask. This keeper checks the commit the BINARY '
      + 'reports, because that is what BookForge spawns — a checkout may be '
      + 'ahead of it, behind it, or absent.\n'
      + 'Set FOUNDRY_CLI (the same variable electron/foundry-bridge.ts reads), '
      + 'or FOUNDRY_HEAD_OVERRIDE to check a specific commit.',
    );
  }

  let printed;
  try {
    printed = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`${binary} --version failed: ${err.message}`);
  }

  // `foundry 1.2.0 (7fbe763)` -> `7fbe763`. Short form, same as the pins carry.
  const match = /\(([0-9a-f]{7,40})\)/.exec(printed);
  if (match === null) {
    throw new Error(
      `${binary} reports "${printed}" and names no commit, so THIS KEEPER CANNOT `
      + 'VERIFY IT.\n'
      + 'That is the honest answer for a build made without '
      + '--define FOUNDRY_GIT_COMMIT (a `bun run src/cli.ts` dev build), and it is '
      + 'NOT a reason to fall back to the checkout: the checkout is most likely to '
      + 'be ahead of the binary on exactly the machine where this happens, which '
      + 'is the hazard this anchor exists to remove.\n'
      + 'Build a release binary, or set FOUNDRY_HEAD_OVERRIDE if you know which '
      + 'commit it is.',
    );
  }
  return { rev: match[1], source: `${binary} --version` };
}

/**
 * The foundry BookForge would spawn, by the same rule
 * `electron/foundry-bridge.ts::resolveFoundryPath` uses — the env var first,
 * then the component registry. The registry needs electron, which this script
 * does not have, so the env var and the conventional build output are what is
 * reachable here; a machine using a managed install must name it explicitly.
 */
function foundryBinary(repo) {
  const fromEnv = process.env['FOUNDRY_CLI']?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const built = path.join(
    repo ?? foundryRepo(),
    'dist',
    process.platform === 'win32' ? 'foundry-windows-x64.exe' : 'foundry',
  );
  return fs.existsSync(built) ? built : null;
}

/** Foundry's two verbatim-copy commits. Tier 1 is asserted at these. */
const VENDOR_PASS = 'f2e3c2d';
const VENDOR_LEAVES = '770480d';

/**
 * THE MAP, one entry per file, BookForge's path → Foundry's.
 *
 * The first ten are the doctrine's own Files table — the five modules, the word
 * list, the two prompts and the two shared fixtures. The last three are the
 * transitive leaves `770480d` added when it found the import graph was not
 * empty: `tts-punctuation` needs `normalizeQuotes`, `tts-number-rules` needs the
 * number words, `tts-number-normalizer` needs `hasLetter`/`firstJsonObject`, and
 * `ai-cleanup-prepass` re-exports `isWrapHyphenBreak` from `line-join`. So the
 * anchor is the two commits together and this map is both of them.
 *
 * `shipped` says what tier 2 expects:
 *   'carried'          — still byte-identical at FOUNDRY_SHIPPED.
 *   { sha256, why }    — ported by `215294a`; pinned, with what it did.
 *   'replaced'         — the file is GONE at FOUNDRY_SHIPPED, on purpose.
 */
const FILES = [
  {
    ours: 'electron/tts-punctuation.ts',
    theirs: 'src/clean/tts-punctuation.ts',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'electron/tts-number-rules.ts',
    theirs: 'src/clean/tts-number-rules.ts',
    vendoredAt: VENDOR_PASS,
    shipped: {
      sha256: '2987477971d52a22bb069badc5f491d404a62075094044a8de5a260be6a9678c',
      why: 'the type-only `epub-processor.js` import retargeted to `./targets.js`, and the '
        + 'unreferenced `VOLUME_TOKEN` deleted (noUnusedLocals is on there). No rule moved.',
    },
  },
  {
    ours: 'electron/tts-number-normalizer.ts',
    theirs: 'src/clean/tts-number-normalizer.ts',
    vendoredAt: VENDOR_PASS,
    shipped: {
      sha256: 'aae1de6d6955b555c3c944f43432226eb4c02286be66cb8035851217f8f03205',
      why: 'the type-only `epub-processor.js` import retargeted to `./targets.js`; '
        + '`askAboutEach` exported so the engine\'s door is a third caller rather than a second '
        + 'copy of the retry rules; `normalizeNarrationNumbers` deleted (291 lines, all about a '
        + 'document tree, replaced by src/clean/run.ts); the unreferenced `droppedWords` and '
        + '`READING_STRUCTURE` deleted. REPINNED 2026-09-13 at foundry HEAD for cd89ee7, which '
        + 'made clean-text ask in PARALLEL (translate\'s worker pool, DEFAULT_CLEAN_CONCURRENCY '
        + '= 4). VERIFIED a port and not a rule move rather than taken on the commit message: '
        + 'its three hunks touch only the constant block after NORMALIZER_VERSION and the body '
        + 'of `askAboutEach`, which is the DRIVER. No rule table, no validator, no '
        + '`ruleRewrites`/`settleByRules`/`validateNumberEdits` logic is in the diff. '
        + 'Temperature stays 0 and the retry rules re-ask at the same settings, so the requests '
        + 'overlap and the text does not. No validator and no disposition moved.',
    },
  },
  {
    ours: 'electron/tts-spoken-forms.ts',
    theirs: 'src/clean/tts-spoken-forms.ts',
    vendoredAt: VENDOR_PASS,
    shipped: {
      sha256: '9d7282b611effbef1c11e251db8a64d1b5a174677ff89d819dbc6c435a966d33',
      why: 'the English word list is IMPORTED rather than read with `fs` + `__dirname` '
        + '(electron ships a directory, foundry ships ONE FILE, so a readFileSync beside the '
        + 'module names a path that exists in the checkout and nowhere on a user\'s machine); '
        + 'the laziness and the named refusal are kept. REPINNED 2026-09-13 at foundry 7fbe763, '
        + 'which added `covid` to SPOKEN_AS_WORD. That is a CONFORMANCE fix, not a rule move: '
        + '`n6` has meant "with COVID" since BookForge 77ea83d0 (2026-09-06) created '
        + 'caps_acronyms.json as THE ONE list, and foundry\'s hard-coded copy — ported one day '
        + 'EARLIER — was behind the spec it already claimed. Until this fix the two '
        + 'implementations of one pass, both stamping n6, disagreed about what the validator '
        + 'refuses: foundry ACCEPTED an edit spelling COVID letter by letter and BookForge '
        + 'refused it. So NORMALIZER_VERSION correctly did NOT move — a bump would assert the '
        + 'rules changed when what changed is that one copy was wrong about rules that did not. '
        + 'No reading table moved.',
    },
  },
  {
    ours: 'electron/narration-text-pass.ts',
    theirs: 'src/clean/narration-text-pass.ts',
    vendoredAt: VENDOR_PASS,
    shipped: 'replaced',
    // It was the EPUB driver — the DOM walk, `writeNarrationEpub`, the gate — and
    // the engine drives a BOOK FILE instead. `punctuationSpans` and `nodeHolding`
    // are in src/clean/punctuate.ts line for line with their arguments; the
    // orchestration around them is src/clean/run.ts. Asserting byte-identity on
    // it at the shipped snapshot would assert something Foundry never claimed —
    // but it IS in tier 1, because the handover carried it verbatim first.
  },
  {
    ours: 'electron/data/english-words.json',
    theirs: 'src/clean/data/english-words.json',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'electron/prompts/tts-number-normalize.txt',
    theirs: 'src/clean/prompts/tts-number-normalize.txt',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'electron/prompts/tts-narration-text.txt',
    theirs: 'src/clean/prompts/tts-narration-text.txt',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'tools/fixtures/text-normalization-cases.json',
    theirs: 'test/clean/fixtures/text-normalization-cases.json',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'tools/fixtures/scripture-readings.json',
    theirs: 'test/clean/fixtures/scripture-readings.json',
    vendoredAt: VENDOR_PASS,
    shipped: 'carried',
  },
  {
    ours: 'electron/ai-cleanup-prepass.ts',
    theirs: 'src/clean/ai-cleanup-prepass.ts',
    vendoredAt: VENDOR_LEAVES,
    shipped: {
      sha256: '5762923d330ecf2cdca248c7b8a85796aa4678c8b9241b2b0e552902fedd0570',
      why: '`from \'../shared/text/line-join\'` retargeted to `./line-join.js` (the file landed '
        + 'flat; that repo has no shared/text/), and the unreferenced `countOccurrences` deleted.',
    },
  },
  {
    ours: 'electron/number-expansion.ts',
    theirs: 'src/clean/number-expansion.ts',
    vendoredAt: VENDOR_LEAVES,
    shipped: 'carried',
  },
  {
    ours: 'shared/text/line-join.ts',
    theirs: 'src/clean/line-join.ts',
    vendoredAt: VENDOR_LEAVES,
    shipped: 'carried',
  },
];

/**
 * The two version constants, which are the semantic anchor under all of it.
 *
 * A port that retargets an import and deletes dead code cannot move these; a
 * change that moves a rule MUST. So reading them off both sides is the cheapest
 * available check that the transform is the same transform, and it fails loudly
 * on the one class of drift the sha pins would otherwise merely report as "some
 * bytes differ".
 */
const VERSIONS = [
  {
    name: 'NORMALIZER_VERSION',
    ours: 'electron/tts-number-normalizer.ts',
    theirs: 'src/clean/tts-number-normalizer.ts',
    pattern: /NORMALIZER_VERSION[^=]*=\s*'([^']+)'/,
    expected: 'n6',
  },
  {
    name: 'PUNCTUATION_SPEC_VERSION',
    ours: 'electron/tts-punctuation.ts',
    theirs: 'src/clean/tts-punctuation.ts',
    pattern: /PUNCTUATION_SPEC_VERSION[^=]*=\s*'([^']+)'/,
    expected: 's1',
  },
];

/** Where a Foundry checkout lives on the machines this repo is worked on. */
function foundryRepo() {
  const declared = process.env['FOUNDRY_REPO']?.trim();
  const candidates = declared
    ? [declared]
    : [
      path.join('C:', 'Users', 'tellt', 'Projects', 'foundry'),
      path.join(os.homedir(), 'Projects', 'foundry'),
      '/Volumes/Callisto/Projects/foundry',
    ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.git'))) return { repo: candidate, tried: candidates };
  }
  return { repo: null, tried: candidates };
}

/** One file out of one commit, as bytes, with CR stripped. Null when absent. */
function blob(repo, rev, file) {
  try {
    const out = execFileSync('git', ['-C', repo, 'show', `${rev}:${file}`], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Buffer.from(out.toString('binary').replace(/\r/g, ''), 'binary');
  } catch {
    return null;
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function requireCommit(repo, rev, what) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', `${rev}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    assert.fail(
      `${what}'s anchor commit ${rev} is not in ${repo}. This keeper compares commits and cannot `
      + 'read one of them; fetch it rather than treating the absence as a pass.',
    );
  }
}

function main() {
  const bookforge = path.join(__dirname, '..');
  const { repo: foundry, tried } = foundryRepo();

  if (foundry === null) {
    console.log(
      'SKIP test-foundry-clean-text-vendor — no Foundry checkout on this machine. '
      + `Tried: ${tried.join(', ')}. Set FOUNDRY_REPO to point at one.`,
    );
    return;
  }

  // Every anchor must RESOLVE before anything is compared. A missing commit
  // would otherwise read as thirteen missing files, which names the wrong
  // problem: a shallow clone or an unfetched Foundry is not a drifted copy.
  requireCommit(bookforge, BOOKFORGE_ANCHOR, 'BookForge');
  const shipped = foundryShipped(foundry);
  const FOUNDRY_SHIPPED = shipped.rev;
  for (const rev of [VENDOR_PASS, VENDOR_LEAVES, FOUNDRY_SHIPPED]) {
    requireCommit(foundry, rev, 'Foundry');
  }

  const problems = [];
  let handover = 0;
  let carried = 0;
  let pinned = 0;
  let replaced = 0;

  for (const entry of FILES) {
    const { ours, theirs, vendoredAt, shipped } = entry;

    const mine = blob(bookforge, BOOKFORGE_ANCHOR, ours);
    if (mine === null) {
      problems.push(
        `TIER 1 ${ours}: not in BookForge at ${BOOKFORGE_ANCHOR}. The map names a path that never `
        + 'existed there, so this keeper is describing a handover that did not happen.',
      );
      continue;
    }

    // ── Tier 1: the handover, at Foundry's own verbatim-copy commit ──────────
    const atVendor = blob(foundry, vendoredAt, theirs);
    if (atVendor === null) {
      problems.push(`TIER 1 ${theirs}: not in Foundry at ${vendoredAt}, where the copy was made.`);
    } else if (!mine.equals(atVendor)) {
      problems.push(
        `TIER 1 ${ours} -> ${theirs} @${vendoredAt}: ${mine.length} bytes here, ${atVendor.length} `
        + 'there, and they differ. The vendor commit claims it changed not one byte.',
      );
    } else {
      handover += 1;
    }

    // ── Tier 2: the snapshot this app ships against ──────────────────────────
    const atShip = blob(foundry, FOUNDRY_SHIPPED, theirs);

    if (shipped === 'replaced') {
      if (atShip !== null) {
        problems.push(
          `TIER 2 ${theirs} @${FOUNDRY_SHIPPED}: this keeper records it as REPLACED by the engine's `
          + 'own driver, and it is present. Either the port was reverted or this record is stale.',
        );
      } else {
        replaced += 1;
      }
      continue;
    }

    if (atShip === null) {
      problems.push(
        `TIER 2 ${theirs} @${FOUNDRY_SHIPPED}: gone. A file the engine still needs was renamed or `
        + 'removed, and nothing here says why.',
      );
      continue;
    }

    if (shipped === 'carried') {
      if (mine.equals(atShip)) {
        carried += 1;
      } else {
        problems.push(
          `TIER 2 ${ours} -> ${theirs} @${FOUNDRY_SHIPPED}: carried verbatim at ${vendoredAt} and `
          + `edited since (${mine.length} bytes here, ${atShip.length} there). Read Foundry's commit: `
          + 'if a rule moved, NORMALIZER_VERSION or PUNCTUATION_SPEC_VERSION should have moved with '
          + 'it and the corpora must be re-vendored. If it is a port, pin it here with its reason.',
        );
      }
      continue;
    }

    const actual = sha256(atShip);
    if (actual === shipped.sha256) {
      pinned += 1;
    } else {
      problems.push(
        `TIER 2 ${theirs} @${FOUNDRY_SHIPPED}: sha256 ${actual}, pinned ${shipped.sha256}. This file `
        + `was ported by 215294a and pinned here (${shipped.why}) — it has changed AGAIN since, and `
        + 'nothing in this repository says what changed.',
      );
    }
  }

  // ── The semantic anchor ───────────────────────────────────────────────────
  for (const version of VERSIONS) {
    const read = (repo, rev, file) => {
      const buf = blob(repo, rev, file);
      if (buf === null) return null;
      const match = version.pattern.exec(buf.toString('utf8'));
      return match === null ? null : match[1];
    };
    const here = read(bookforge, BOOKFORGE_ANCHOR, version.ours);
    const there = read(foundry, FOUNDRY_SHIPPED, version.theirs);
    if (here !== version.expected || there !== version.expected) {
      problems.push(
        `${version.name}: BookForge ${BOOKFORGE_ANCHOR} says ${here}, Foundry ${FOUNDRY_SHIPPED} `
        + `says ${there}, and this keeper expects ${version.expected} on both. The version is what `
        + 'a stamped book, a cached copy and a training corpus all key off; a mismatch means two '
        + 'programs are reading text by different rules while claiming the same name.',
      );
    }
  }

  assert.deepStrictEqual(
    problems, [],
    'The Foundry engine\'s copy of the narration text pass does not match this repository:\n  '
    + problems.join('\n  '),
  );

  assert.strictEqual(handover, FILES.length, 'every file must be checked at its vendor commit');
  assert.strictEqual(carried + pinned + replaced, FILES.length);
  console.log(
    `PASS test-foundry-clean-text-vendor — handover: ${handover}/${FILES.length} byte-identical to `
    + `bookforge ${BOOKFORGE_ANCHOR} at foundry ${VENDOR_PASS}/${VENDOR_LEAVES}. `
    + `Shipped (${FOUNDRY_SHIPPED}): ${carried} carried verbatim, ${pinned} ported and pinned, `
    + `${replaced} replaced by the engine's own driver. n6/s1 agree on both sides. (${foundry})`,
  );
}

main();
