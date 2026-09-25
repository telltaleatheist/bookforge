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
 * ── THREE ASSERTIONS, because there are three different questions ───────────
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
 * **3. THE ONE-DOOR FREEZE** (`checkFrozenSinceOneDoor`, added 2026-09-13 with
 * the `83d7b66` re-vendor). Foundry's Wave 60 rewrote how a text act TALKS to a
 * server — `src/translate/ollama.ts` deleted, `transport.ts` in its place, the
 * runner rewritten — and claimed in `#foundrynotes` that the three `tts-*`
 * leaves came through it *"byte-identical to 969dd96"*. Tiers 1 and 2 cannot
 * check that claim: tier 1 asks about a commit eight days older, and tier 2
 * asks whether bytes equal a pin, which a rewrite that happened to reproduce
 * the pinned bytes would also satisfy. Tier 3 asks the claim itself — no
 * change to those three files across the rework — so the freeze is asserted
 * rather than believed.
 *
 * A REGENERATED PIN IS A DECISION, not a chore. If this keeper fails on a file
 * in tier 2, the answer is to read Foundry's commit and decide whether the
 * change is a port or a rule move; a rule move means the corpora and the renders
 * normalize differently and `NORMALIZER_VERSION` should have moved with it.
 *
 * ── THE DECISION OF 2026-09-13, cd89ee7 → 83d7b66 (foundry v1.3.0) ──────────
 *
 * The re-vendor to `83d7b66` moved the shipped anchor across 21 Foundry
 * commits. All thirteen files in the map below were read over that range
 * (`git log cd89ee7..83d7b66 -- <path>`, one path at a time — a single log over
 * `src/clean/` would have lumped the driver's commits in with the leaves').
 * TWELVE OF THE THIRTEEN HAVE AN EMPTY LOG. Not one pin was regenerated, and
 * that is the finding rather than the absence of one: `646e8a1` is the biggest
 * engine commit since the handover and it left the rules alone.
 *
 * The thirteenth is `src/clean/tts-spoken-forms.ts`, moved by exactly two
 * commits, and NEITHER is a rule move:
 *
 *   - `7fbe763` — `covid` added to `SPOKEN_AS_WORD`.
 *   - `969dd96` — `wwi` and `wwii` added.
 *
 * Both are CONFORMANCE FIXES: they close divergences from
 * `python/narrator/text/caps_acronyms.json`, which is this side's authority for
 * that list and had each word FIRST. The two copies now agree, which is why
 * this file has no sha pin at all and is checked by value — see
 * `checkSpokenAsWordAgreement`, which is the thing that caught both.
 *
 * RULING OWED (recorded rather than decided, because it is Owen's and he is
 * asleep): a word entering the acronym list DOES change what the validator
 * accepts, and `NORMALIZER_VERSION` stayed at `n6` through both. The argument
 * for leaving it is that the list is data this side owns and Foundry mirrors,
 * so the version names the TRANSFORM and not the vocabulary — and re-keying
 * every cached record and re-vendoring every corpus for one acronym would be a
 * very expensive way to say "COVID". The argument against is that two books
 * cleaned either side of `7fbe763` stamp `n6` and are not the same text. Left
 * as it stands; both copies agreeing is what this keeper can enforce, and it
 * does.
 *
 * ── THE DECISION OF 2026-09-14, 83d7b66 → 12b065d (the 4beb88b re-vendor) ────
 *
 * The re-vendor to `4beb88b` moved the shipped anchor again — and it moved it
 * to `12b065d`, NOT to `4beb88b`, because the anchor is the commit the BINARY
 * reports and `dist/foundry-windows-x64.exe` answers `foundry 1.3.0 (12b065d)`.
 * That is the mechanism working as designed rather than a lag: the release
 * build was taken mid-range, and `git diff 12b065d 4beb88b -- src/clean
 * test/clean` is empty, so nothing this keeper asks about differs between the
 * commit the app was copied from and the commit the engine was built from.
 *
 * All thirteen files were read over `83d7b66..12b065d`, one path at a time.
 * TWELVE HAVE AN EMPTY LOG. The thirteenth is
 * `src/clean/tts-number-normalizer.ts`, moved by exactly one commit —
 * `76444fb`, "a cloud provider is a door for the text acts" — and the whole of
 * its diff against this file is ONE WORD INSIDE A DOCBLOCK:
 *
 *     - * above this line is shared by both doors unchanged: the rules, ...
 *     + * above this line is shared by every door unchanged: the rules, ...
 *
 * Anthropic joins OpenAI and Ollama, so "both doors" had stopped being true of
 * the sentence that counts them. `both doors` and `every door` are the same
 * nine characters, which is why the file is 122,131 bytes on both sides and
 * only the sha moved.
 *
 * VERDICT: PORT, and the weakest kind there is — not one byte outside a
 * comment, no rule table, no validator, no prompt, no constant. `n6` was right
 * to stay where it is, and this is the case the doctrine's "a rule move means
 * NORMALIZER_VERSION should have moved with it" was written to let through.
 * Repinned below with that reason.
 *
 * `ONE_DOOR_BASELINE` MOVED WITH IT, 969dd96 → 76444fb, and that is the second
 * half of the same decision rather than a way to make tier 3 green. The
 * baseline's stated rule is "it moves the next time Foundry legitimately
 * changes one of these"; `76444fb` IS that change, so the freeze is now
 * asserted from the last commit that touched any of the three. Nothing is
 * loosened: the range `969dd96..76444fb` that the old baseline covered
 * contained exactly this one comment edit and no other movement in the three
 * files, and tier 2 still pins the same file by content sha256 either way.
 *
 * ── THE DECISION OF 2026-09-14 (evening), 12b065d → 8fcc27a: THE FIRST
 *    RE-VENDOR THAT RAN THE OTHER WAY ─────────────────────────────────────────
 *
 * Every movement this keeper had seen until tonight was FOUNDRY's: they ported
 * an import, deleted dead code, reworked a runner. Tonight BOOKFORGE moved
 * first. `9df3d93a` added class 2b to `electron/prompts/tts-narration-text.txt`
 * — scripture book names are said in full and never shortened back — and
 * Foundry's `8fcc27a` copied that file across byte-for-byte, its subject line
 * saying so: *"vendored from BookForge 9df3d93a"*.
 *
 * The keeper went red and the failure named the wrong thing: *"carried verbatim
 * at f2e3c2d and edited since (7049 bytes here, 8178 there)"*. IT WAS NOT A
 * LINE-ENDING ARTEFACT (both sides are the same git blob,
 * `67cb805e997d071fab45ad51e806cf57db08f5fa`, and `blob()` strips CR anyway),
 * NOT A HEADER FOUNDRY ADDS (their vendor commit is `1 file changed, 2
 * insertions(+)`, the same two lines as ours), AND NOT CONTENT DRIFT. The two
 * live copies are IDENTICAL. What differed was the commit this keeper was
 * comparing Foundry against: `BOOKFORGE_ANCHOR`, frozen at the 2026-09-05
 * handover, which is 7,049 bytes and pre-dates class 2b by nine days.
 *
 * So `'carried'` — "still byte-identical to BookForge at the HANDOVER" — had
 * quietly become a claim this repository can falsify on its own, by editing its
 * own file. That is a fourth state, and neither of tier 2's other answers fits
 * it: `'carried'` is now false, and a bare `{sha256}` pin would record the new
 * bytes while SAYING NOTHING about whose bytes they are — it would go green on a
 * Foundry-authored edit that this side never made, as long as somebody repinned.
 * The pin is the wrong half of the assertion when the interesting fact is
 * PROVENANCE.
 *
 * ── The fourth answer: `{ revendoredFrom, sha256, why }` ────────────────────
 *
 * It asserts THREE things, and the sha is the least of them:
 *
 *   1. Foundry's copy at the shipped commit is byte-identical to BOOKFORGE'S
 *      COPY AT THE NAMED COMMIT. This is tier 1's question — "what left is what
 *      arrived" — asked again about the second handover, and it is LIVE: it
 *      reads both repositories, so a Foundry-side edit fails it no matter what
 *      number is written below.
 *   2. Its sha256 equals the pin. Belt and braces on (1), and the reason the
 *      anchor cannot creep: moving `revendoredFrom` forward means regenerating a
 *      number and writing why beside it, which is the DECISION the doctrine at
 *      the top of this file demands.
 *   3. BookForge AT HEAD still equals `revendoredFrom`. This is the alarm for
 *      the state the keeper could not express tonight — our prompt moved on and
 *      Foundry has not followed — and it is red on purpose. `foundry
 *      clean-text` is what runs a book, so while the two differ THEIR copy is
 *      the live behaviour and ours is a file that describes nothing. That is
 *      the COVID incident's exact shape (see `checkSpokenAsWordAgreement`), and
 *      "a re-vendor is owed" is a sentence `9df3d93a`'s own commit message had
 *      to write in prose because this keeper had nowhere to put it.
 *
 * VERDICT on the class-2b move itself: it is a RULE ADDITION, in a prompt, and
 * `NORMALIZER_VERSION` did NOT move — deliberately. The two constants name the
 * DETERMINISTIC transform (`tts-number-normalizer.ts`, `tts-punctuation.ts`);
 * `tts-narration-text.txt` is instruction to a model, whose output is judged by
 * the validators those constants version, and class 2b adds no reading the
 * validator did not already accept — `tools/test-prompt-examples.js` runs every
 * pair it states through that validator, 88/88. A prompt that asks for readings
 * the rules already ruled is not a rule move. (`tts-number-normalize.txt`, the
 * half the `orpheus-finetune` corpora vendor, was left alone for the same
 * reason and is still `'carried'`.)
 *
 * Nothing else moved on either side: `git log 12b065d..8fcc27a` touches exactly
 * one of the thirteen, and `git log 0f962d5f..HEAD` on this side touches four —
 * `tts-number-rules.ts`, `tts-spoken-forms.ts`, `narration-text-pass.ts` and
 * this prompt — of which only this prompt is checked against our anchor by
 * bytes at the shipped tier. The other three are pinned, checked by value, or
 * recorded as replaced, which is why they did not fail with it.
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
 * ── THE DECISION OF 2026-09-24, 12b065d/8fcc27a → a1138f6: n7 AND n8, AND
 *    THIS SIDE FOLLOWED ────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-24, asked whether to port Foundry's n7/n8 into BookForge's copy:
 * *"yes."* The first time a RULE MOVE crossed this keeper — both earlier
 * decisions were ports — and it crossed in Foundry's direction, which is why
 * this keeper records a new kind of entry (`resynced`, below).
 *
 * What moved, read commit by commit over `76444fb..a1138f6` (the range tier 3
 * reported), one path at a time:
 *
 *   - `ea2ebb2`, `a5f6c46`, `dccc144`, `fdba761` — `tts-number-normalizer.ts`
 *     only, and DRIVER-ONLY: every hunk sits in `askAboutEach`, `askForEdits`,
 *     `normalizeTextBlocks`, the `AskOutcome`/`NumberNormalizationRecord`
 *     interfaces and a new `ModelServerFacts` receipt type — answers recorded
 *     where they land, a busy card waited on, the pool sized by the server, the
 *     log reworded. No rule table and no validator body. n6 was right to stay
 *     through them; nothing here had been recorded, which is what the old
 *     binary anchor (8ee48b7) hid.
 *   - `b3337c3`, **n7** — "valid fixes are no longer thrown away": an edit whose
 *     find a NEIGHBOUR prints is CARRIED there; a number printed twice is read
 *     at every place; `rejoinsSplitWord` ("fini sh" → "finish"). A RULE MOVE,
 *     and Foundry moved `NORMALIZER_VERSION` n6 → n7 with it.
 *   - `cf38ea2`, **n8** — "the model judges a year, code spells it": a bare
 *     four-digit number in 1100–2099 with no comma/currency/unit is a YEAR read
 *     in pair form by the RULES; year ranges read whole; the validator re-spells
 *     a model's year reading. A RULE MOVE; n7 → n8. It also moved the number
 *     prompt and the shared fixtures (year cases model → rules, `changed_in`).
 *
 * WHAT THIS SIDE DID: a THREE-WAY MERGE into `electron/tts-number-rules.ts`,
 * `tts-number-normalizer.ts`, `tts-spoken-forms.ts` (base foundry `b3337c3^`,
 * theirs `cf38ea2`, ours this repository) — so BookForge's own post-handover
 * changes (Listen's shared exports, the ONE acronym list) survive — and the
 * prompt and fixture taken byte-for-byte (this side never changed them after
 * the handover). `NORMALIZER_VERSION` is `n8` on both sides, which is the whole
 * point: `narration-text-readiness.ts` compares a book's stamp against this
 * repository's constant, and a book cleaned by the vendored engine (n8) was
 * about to be called stale by an n6 constant.
 *
 * WHAT IS DELIBERATELY NOT HERE: n7's CARRIED lives in Foundry's POOLED driver,
 * and this copy keeps its SERIAL driver (the legacy local narration path, not
 * the pass that cleans a book — that is `foundry clean-text`). The merged file
 * says so where the code would be. So the two implementations share every RULE
 * and every VALIDATOR verdict and differ in one DRIVER behaviour; the stamp is
 * about the rules, and the rules agree.
 *
 * ORPHEUS-FINETUNE OWES A RE-VENDOR (its PROVENANCE pins the old n6 files, and
 * both Foundry commits say so). Not done from here: that repository is not this
 * keeper's.
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
const { skipLine } = require('./keeper-skip.js');

/** BookForge's commit the pass was vendored FROM — Foundry's `f2e3c2d` names it. */
const BOOKFORGE_ANCHOR = '0f962d5f';

/**
 * WHAT TIER 2 IS ASKED ABOUT — the Foundry commit that CARRIES THE ENGINE THIS
 * APP RUNS.
 *
 * THIS WAS A FIXED COMMIT UNTIL 2026-09-13 AND THAT WAS THE BUG. It read
 * `const FOUNDRY_SHIPPED = '9f4ee4e'` — a snapshot from 2026-09-05 — and by the
 * time anyone looked, Foundry was 46 commits past it, 7 of them touching
 * `src/clean/`, so this keeper answered its question about an engine nobody ran
 * — and passed through a real divergence (`SPOKEN_AS_WORD` lost `covid` on one
 * side only). A keeper anchored to a hand-kept commit is the same shape as the
 * bug it guards.
 *
 * From 2026-09-13 to 2026-09-24 the anchor was the commit a downloaded BINARY
 * printed in `foundry --version` — `resolveFoundryPath`, the `foundry-cli`
 * add-on, `FOUNDRY_CLI_PATH`. All of that is gone: the engine is VENDORED with
 * foundry-app as `foundry-app/engine/foundry-engine.cjs` (Foundry's
 * tools/build-engine.mjs), and electron/foundry-bridge.ts and the hosted window
 * both run exactly that file. Its `--version` stamp is `src <digest>`, a digest
 * of the sources rather than a commit, so it cannot be looked up by name.
 *
 * SO THE ANCHOR IS DERIVED FROM THE BYTES. The bundle's git blob id is asked of
 * Foundry's history (`git log --find-object`), and the anchor is the newest
 * commit whose `app/engine/foundry-engine.cjs` IS that blob. That is exact, not
 * approximate: the bundle is committed, and Foundry's own suite
 * (test/engine-bundle.test.ts) fails any commit where it is not what that
 * commit's `src/` builds to — and the build stamp is a digest of every input,
 * comments included, so identical bundle bytes mean identical sources. Nothing
 * here is kept current by hand, and nothing reads a prose table.
 *
 * NOT FOUND IS A REFUSAL. A vendored bundle no Foundry commit carries was built
 * from an uncommitted tree (or the checkout is behind), and answering about any
 * other commit would be the hazard this anchor exists to remove.
 *
 * `FOUNDRY_HEAD_OVERRIDE` pins the anchor for one run, to bisect a failure or to
 * check a specific commit. Deliberately an env var and not a constant: a
 * constant is what got us here.
 */
function foundryShipped(repo) {
  const override = process.env['FOUNDRY_HEAD_OVERRIDE']?.trim();
  if (override) return { rev: override, source: 'FOUNDRY_HEAD_OVERRIDE' };

  const bundle = path.join(__dirname, '..', 'foundry-app', 'engine', 'foundry-engine.cjs');
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `the vendored Foundry engine is missing (${bundle}). It is part of the foundry-app/ copy `
      + '(foundry-app/VENDORED.md), so this checkout is incomplete.',
    );
  }
  const rev = vendoredEngineCommit(repo, bundle);
  if (rev === null) {
    throw new Error(
      `no commit in the Foundry checkout at ${repo} carries ${bundle} byte for byte, so THIS `
      + 'KEEPER CANNOT SAY WHICH SOURCES THE APP RUNS. Either the vendored bundle was built from '
      + 'an uncommitted tree, or that checkout has not fetched the commit it came from. Fetch '
      + 'Foundry, or set FOUNDRY_HEAD_OVERRIDE if you know which commit it is.',
    );
  }
  return { rev, source: 'the vendored foundry-app/engine bundle' };
}

/**
 * The newest Foundry commit whose `app/engine/foundry-engine.cjs` is exactly the
 * vendored bundle's bytes, or null. `--find-object` lists every commit that ADDED
 * or REMOVED that blob; the ones where the path still holds it are the carriers.
 */
function vendoredEngineCommit(repo, bundle) {
  const id = execFileSync('git', ['hash-object', '--no-filters', bundle], { encoding: 'utf8' }).trim();
  const touched = execFileSync('git', [
    '-C', repo, 'log', '--all', '--format=%H', `--find-object=${id}`, '--', 'app/engine/foundry-engine.cjs',
  ], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const commit of touched) {
    let at;
    try {
      at = execFileSync('git', ['-C', repo, 'rev-parse', `${commit}:app/engine/foundry-engine.cjs`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
    if (at === id) return commit.slice(0, 7);
  }
  return null;
}

/** Foundry's two verbatim-copy commits. Tier 1 is asserted at these. */
const VENDOR_PASS = 'f2e3c2d';
const VENDOR_LEAVES = '770480d';

/**
 * TIER 3 — the last commit that touched the text pass's own rules, and the
 * three files that must not have moved since.
 *
 * `969dd96` is `fix(clean): SPOKEN_AS_WORD gains wwi/wwii` (2026-09-13 17:51),
 * the second of the two conformance fixes the VALUE check below narrates. It is
 * the baseline because the very next engine commit, `646e8a1`, is the ONE
 * INFERENCE DOOR rework: 1,296 insertions and 1,802 deletions across 25 files,
 * `src/translate/ollama.ts` deleted outright, `src/clean/runner.ts` rewritten.
 * A rework that size is exactly the event that carries an unnoticed edit into a
 * rule table, and Foundry's own handoff note makes the negative claim in as
 * many words: *"`tts-number-normalizer.ts`, `tts-spoken-forms.ts`,
 * `tts-punctuation.ts` are byte-identical to 969dd96."*
 *
 * NOTE WHAT IS **NOT** ASSERTED HERE, because the obvious phrasing is wrong:
 * "the three tts-* leaves are byte-identical to BookForge's anchor". Only
 * `tts-punctuation.ts` is (it is `carried` in the map above).
 * `tts-number-normalizer.ts` was PORTED by `215294a` and again by `cd89ee7` and
 * can never be byte-identical to `0f962d5f` again; `tts-spoken-forms.ts` is
 * deliberately checked by VALUE and not by bytes at all. Asserting byte
 * identity against our anchor would therefore either fail on a documented port
 * or have to be weakened until it asserted nothing. The freeze against
 * Foundry's OWN last rule commit is the assertion that survives contact with
 * both of those facts.
 *
 * The baseline moves the next time Foundry legitimately changes one of these —
 * and moving it is a DECISION, on the same terms as a regenerated pin: read the
 * commit, and if a rule moved, `NORMALIZER_VERSION` must move with it.
 */
/*
 * MOVED 2026-09-14, 969dd96 → 76444fb, as a DECISION and not to clear a red
 * keeper. `76444fb` is the next commit after `969dd96` that touched any of the
 * three, it touched exactly one of them, and what it touched was a comment (see
 * "THE DECISION OF 2026-09-14" in the header). The baseline is therefore still
 * "the last commit that legitimately changed one of these", which is what makes
 * the freeze mean something; the alternative — pinning the baseline at 969dd96
 * forever and whitelisting the file — would have converted a freeze into a list
 * of exceptions, which is how this keeper's fixed anchor went wrong in the
 * first place.
 */
/*
 * MOVED 2026-09-24, 76444fb → cf38ea2, with the n7/n8 decision in the header:
 * `cf38ea2` is the last commit that legitimately changed any of the three
 * (normalizer and spoken-forms; punctuation has not moved since the handover),
 * so the freeze is asserted from there. Nothing is loosened — every commit in
 * `76444fb..cf38ea2` touching them was read and is named in that decision.
 */
/*
 * MOVED 2026-09-24 (evening), cf38ea2 → 4d67274, as a DECISION: `4d67274` is n9,
 * a RULE MOVE, read in full. Two n8 rule defects Pursuit of Power's run measured
 * (a day range read as a stray day and a date; "£803.11.0" read as pounds and
 * pence), fixed per Owen's ruling that the rules are examples for the model and
 * not deterministic logic: both shapes are detected and closed to every rule, the
 * prompt carries their readings, and the validator grants a pre-decimal sum one
 * more join and no word for its zero part. NORMALIZER_VERSION moved n8 → n9 with
 * it, and this side took the same diff.
 */
/*
 * MOVED 2026-09-24 (night), 4d67274 → 3025407, as a DECISION: `3025407` is n10,
 * read in full. The unit a cleanup asks about became a SENTENCE (a driver change
 * in run.ts/triage.ts, not in these files), and in these files ONLY the prompts'
 * wording moved: TARGET is "usually one sentence", and the number prompt's
 * blanket "leave roman numerals as printed" now defers to the narration
 * prompt's class 6. No rule and no validator moved; NORMALIZER_VERSION went
 * n9 → n10 because a prompt is part of the transform. This side took the same diff.
 */
/*
 * MOVED 2026-09-24 (late), 3025407 → c04e4a2, as a DECISION: `c04e4a2` is n11,
 * read in full. A RULE MOVE in the validator (a lone numeral after a ruler's
 * name, more ruler names in tts-spoken-forms, a clock's zero minutes, proven-exact
 * readings off the rewrite budget, and `policy.gate`) and in both prompts (the
 * examples the n10 runs showed were missing). NORMALIZER_VERSION n10 → n11, and
 * this side took the same diff.
 */
/*
 * MOVED 2026-09-25, c04e4a2 → 571d57f, as a DECISION: `571d57f` is n12, read in
 * full: the prompts only (a "WHAT YOU NEVER CHANGE" section, citations read by
 * example) and the version constant. This side took the same diff.
 */
/*
 * MOVED 2026-09-25, 571d57f → f168809, as a DECISION: `f168809` is n13, read in
 * full. In these files only the version constant and one validator change (an
 * edit touching inline markup stays refused with the gate off) moved; the
 * cleanup prompt itself moved to a new file, `src/clean/prompts/tts-clean-text.txt`,
 * which the engine embeds and this repository does not carry.
 */
/* MOVED 2026-09-25, f168809 → 2c5edfc (n14), read in full: the version constant and its comment only in these files; the rules moved in the engine's own prompt file. */
/* MOVED 2026-09-25, 2c5edfc → 9c2aa68 (n15), read in full: the light gate — the normalizer imports src/clean/light-gate.ts (carried here as electron/light-gate.ts, byte-identical) and applies it under policy.gate 'light'. */
/* MOVED 2026-09-25, 9c2aa68 → f57402c (n16), read in full: the version constant and its comment only in these files; the prompt moved in the engine's own file. */
const ONE_DOOR_BASELINE = 'f57402c';
const FROZEN_SINCE_BASELINE = [
  'src/clean/tts-number-normalizer.ts',
  'src/clean/tts-spoken-forms.ts',
  'src/clean/tts-punctuation.ts',
];

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
 *   'carried'                        — still byte-identical to BookForge at
 *                                      BOOKFORGE_ANCHOR.
 *   { sha256, why }                  — Foundry ported it; pinned, with what it
 *                                      did.
 *   { revendoredFrom, sha256, why }  — BOOKFORGE moved and Foundry followed:
 *                                      byte-identical to BookForge at that
 *                                      LATER commit, sha-pinned, and this side
 *                                      must not have moved on again since.
 *   'replaced'                       — the file is GONE at FOUNDRY_SHIPPED, on
 *                                      purpose.
 *   { resynced, sha256, why }        — FOUNDRY moved and this side FOLLOWED:
 *                                      Foundry's copy is pinned by sha, and this
 *                                      repository's working copy must be
 *                                      byte-identical to it (CR-stripped).
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
      sha256: '1369200c27da3eab0e8d760fc543927913154100ea032730465920ca40f958b1',
      why: 'the type-only `epub-processor.js` import retargeted to `./targets.js`, and the '
        + 'unreferenced `VOLUME_TOKEN` deleted (noUnusedLocals is on there). No rule moved. '
        + 'REPINNED 2026-09-24 for cf38ea2 (n8): the YEAR rules (pair form, whole ranges, period '
        + 'prefixes, comma-grouped stays cardinal) and the guard fixes the replay exposed — a '
        + 'RULE MOVE, NORMALIZER_VERSION n8, and this repository\'s copy was 3-way merged to '
        + 'match (see "THE DECISION OF 2026-09-24"). '
        + 'REPINNED 2026-09-24 (evening) for 4d67274 (n9): day ranges and pre-decimal sums are '
        + 'detected and closed for the model. A RULE MOVE, and this side took the same diff.',
    },
  },
  {
    ours: 'electron/tts-number-normalizer.ts',
    theirs: 'src/clean/tts-number-normalizer.ts',
    vendoredAt: VENDOR_PASS,
    shipped: {
      sha256: 'f4de273e58ecf72bdb67b0f7f44a9c4388a1ff0cbaa3ea8880d8547d75455ad7',
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
        + 'overlap and the text does not. No validator and no disposition moved. '
        + 'STILL GOOD at 83d7b66 (the v1.3.0 release commit) — the pin was NOT regenerated for '
        + 'it, because `git log cd89ee7..83d7b66 -- src/clean/tts-number-normalizer.ts` is empty: '
        + 'the one-door rework (646e8a1) changed how the runner TALKS to a server, never what '
        + 'this file decides. Asserted rather than read off that log by tier 3 below. '
        + 'REPINNED 2026-09-14 for the 4beb88b re-vendor, whose binary reports 12b065d. '
        + '`git log 83d7b66..12b065d -- <this file>` names ONE commit, 76444fb (the cloud '
        + 'provider door), and its entire diff here is one word inside a docblock: "shared by '
        + 'both doors unchanged" became "shared by every door unchanged", because Anthropic '
        + 'made the door count three. Same nine characters, so the file is 122,131 bytes before '
        + 'and after and only the sha moved. A PORT with not one byte outside a comment — no '
        + 'rule, no validator, no prompt, no constant — so n6 was right to stay. '
        + 'REPINNED 2026-09-24 at cf38ea2 (identical at a1138f6), after reading every commit in '
        + '76444fb..cf38ea2: four DRIVER-only commits (ea2ebb2, a5f6c46, dccc144, fdba761) and '
        + 'two RULE MOVES, b3337c3 (n7) and cf38ea2 (n8), which moved NORMALIZER_VERSION to n8. '
        + 'This repository\'s copy was 3-way merged to n8 and keeps its serial driver without '
        + 'n7\'s CARRIED — see "THE DECISION OF 2026-09-24". '
        + 'REPINNED 2026-09-24 (evening) for 4d67274 (n9): NORMALIZER_VERSION n9, and a pre-decimal '
        + 'sum gets one more joining word and no word for its zero part. Same diff here. '
        + 'REPINNED 2026-09-24 (night) for 3025407 (n10): the version constant and its '
        + 'comment only. Same diff here. '
        + 'REPINNED 2026-09-24 (late) for c04e4a2 (n11): a lone ruler numeral, the clock zero '
        + 'minutes, proven-exact readings off the budget, and policy.gate. Same diff here. '
        + 'REPINNED 2026-09-25 for 571d57f (n12): the version constant and its comment. Same diff here. '
        + 'REPINNED 2026-09-25 for f168809 (n13): the version constant and markup never edited with the '
        + 'gate off. Same diff here. REPINNED 2026-09-25 for 2c5edfc (n14): the version constant '
        + 'and its comment. Same diff here. REPINNED 2026-09-25 for 9c2aa68 (n15): the light gate. '
        + 'Same diff here.',
    },
  },
  {
    ours: 'electron/tts-spoken-forms.ts',
    theirs: 'src/clean/tts-spoken-forms.ts',
    vendoredAt: VENDOR_PASS,
    // NOT sha-pinned any more. `checkSpokenAsWordAgreement` below is this file's
    // shipped-tier check instead, and the reason is the whole point of the
    // exercise — see that function.
    shipped: null,
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
    shipped: {
      resynced: '571d57f',
      sha256: 'a5350150375b734605a17079dcaf0d543a33216913bb11e22a68e942575705a1',
      why: 'n8 (cf38ea2) moved the prompt with the year rules, and this side took it '
        + 'byte-for-byte on 2026-09-24 — see "THE DECISION OF 2026-09-24". n9 (4d67274) added '
        + 'the day-range and pre-decimal-sum examples, taken byte-for-byte the same evening. n10 '
        + '(3025407) worded TARGET for a sentence and made roman numerals defer to class 6, '
        + 'taken byte-for-byte the same night. n11 (c04e4a2) added the point-time and decimal '
        + 'examples, taken byte-for-byte. n12 (571d57f) reads citations by example, taken byte-for-byte.',
    },
  },
  {
    ours: 'electron/prompts/tts-narration-text.txt',
    theirs: 'src/clean/prompts/tts-narration-text.txt',
    vendoredAt: VENDOR_PASS,
    shipped: {
      resynced: '571d57f',
      sha256: '05302f4f795730a656da865da6fe7e7cdc8e7b331411b03cb0f112bbb3f7d5a3',
      why: 'RESYNCED 2026-09-24 (night) for 3025407 (n10): Foundry worded it for a TARGET that '
        + 'is usually one sentence (four phrases: "one passage … usually a single sentence", '
        + '"in the TARGET", "PREVIOUS or NEXT passage", "most passages"), and this side took it '
        + 'byte-for-byte. n11 (c04e4a2) added the ruler-numeral and spaced-hyphen examples, and n12 (571d57f) the '
        + '"WHAT YOU NEVER CHANGE" section, taken '
        + 'byte-for-byte. What it was before: '
        + 'THE FIRST RE-VENDOR THAT RAN THE OTHER WAY — see "THE DECISION OF 2026-09-14 '
        + '(evening)" in the header. BookForge `9df3d93a` added CLASS 2b, "scripture book names '
        + 'are said in FULL, always, and are never shortened", because the deterministic pass '
        + 'expands every citation it is certain of and the model was never told not to abbreviate '
        + 'one back. Foundry `8fcc27a` copied that file across byte-for-byte and its subject says '
        + 'so: "vendored from BookForge 9df3d93a". Both commits are one file changed and two '
        + 'insertions, both sides are git blob 67cb805e997d071fab45ad51e806cf57db08f5fa, and '
        + 'this sha256 is '
        + 'that blob CR-stripped. The 7049-vs-8178 failure that produced this entry was NOT '
        + 'line endings and NOT drift: it was `carried` comparing Foundry against '
        + 'BOOKFORGE_ANCHOR, a 2026-09-05 commit that pre-dates class 2b. '
        + 'NORMALIZER_VERSION deliberately stayed at n6: the constants version the DETERMINISTIC '
        + 'transform and its validator, this file is instruction to a model, and class 2b asks '
        + 'for no reading that validator did not already accept — tools/test-prompt-examples.js '
        + 'runs all 88 of the prompt\'s stated pairs through it. A prompt asking for rules '
        + 'already ruled is not a rule move.',
    },
  },
  {
    ours: 'tools/fixtures/text-normalization-cases.json',
    theirs: 'test/clean/fixtures/text-normalization-cases.json',
    vendoredAt: VENDOR_PASS,
    shipped: {
      resynced: 'cf38ea2',
      sha256: '644ec9df7725dd3585f2d858e9c365ba10e7f2eec94aa971040c42165ea0a877',
      why: 'n8 (cf38ea2) moved the year cases from the model to the rules (`changed_in`), and '
        + 'this side took the fixture byte-for-byte on 2026-09-24 — see "THE DECISION OF '
        + '2026-09-24".',
    },
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
    // n6 → n8 on 2026-09-24: Foundry's b3337c3 (n7) and cf38ea2 (n8), followed
    // here by the 3-way merge in "THE DECISION OF 2026-09-24".
    // n8 → n9 the same evening: Foundry 4d67274, taken here as the same diff.
    // n9 → n10 the same night: Foundry 3025407 (the sentence unit's prompt wording).
    // n10 → n11 later that night: Foundry c04e4a2 (examples; the gate switch).
    // n11 → n12: Foundry 571d57f (never-change section; citations read).
    // n12 → n13: Foundry f168809 (one short prompt; markup stays unedited).
    // n13 → n14: Foundry 2c5edfc (three broad rules in the clean-text prompt).
    // n14 → n15: Foundry 9c2aa68 (the light gate).
    // n15 → n16: Foundry f57402c (years, rulers, transl./ed., month-first ranges).
    expected: 'n16',
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

/**
 * `src/clean/tts-spoken-forms.ts` is checked by VALUE, not by bytes, and this is
 * the third time that decision has been forced.
 *
 * THE HISTORY, because it is the argument. Foundry's `SPOKEN_AS_WORD` is a
 * hard-coded array; ours is `caps_acronyms.json`, the file whose own `_comment`
 * calls itself *"THE ONE ACRONYM LIST, read by THREE code paths so they can never
 * drift"*. The two have now diverged twice:
 *
 *   1. 2026-09-06 — `covid` was in the JSON and not in Foundry's copy. Both
 *      stamped `n6`. Foundry's validator ACCEPTED an edit spelling COVID letter
 *      by letter and ours REFUSED it, and because text processing is Foundry's at
 *      runtime, the live behaviour was the permissive one. Nothing downstream
 *      could tell the two results apart.
 *   2. 2026-09-13 — `wwi` and `wwii` went into the JSON (an all-caps heading was
 *      being narrated "Wwii") and not into Foundry's copy. The same divergence,
 *      by the same mechanism, eight weeks later.
 *
 * A SHA PIN CANNOT TELL A CONFORMANCE FIX FROM A RULE MOVE, which is the only
 * distinction anybody cares about here. It went red on Foundry 969dd96 — a commit
 * that ADDED `wwi`/`wwii` and thereby made the two copies AGREE. The pin's own
 * comment narrated incident (1) at length and then repinned; repinning again
 * would have been the third recurrence of a defect this keeper exists to catch,
 * written directly underneath the paragraph describing the second.
 *
 * WHY THE CHECK LIVES HERE AND NOT IN FOUNDRY. Foundry-pc-1, 2026-09-13:
 * *"Foundry CANNOT read caps_acronyms.json at runtime (single binary, no
 * checkout), so 'read the JSON' is not a shape that exists here."* That is
 * correct and it settles ownership — a single-file binary cannot open a file in
 * somebody else's repository, so the comparison has to be made by the side that
 * can see both. This side can.
 *
 * So: parse the set out of Foundry's source, compare it as a SET to the JSON's
 * `spokenAsWord`, lower-cased, and fail on a difference IN EITHER DIRECTION. An
 * addition on either side that the other has not got is the defect, whichever
 * side added it.
 */
function checkSpokenAsWordAgreement(atShip) {
  const source = atShip.toString('utf8');
  // The literal, as Foundry writes it: `export const SPOKEN_AS_WORD: ... = new
  // Set([ 'nasa', ... ]);`. Anchored on the NAME rather than on a line number or
  // a shape, because the name is the contract and the formatting is not.
  const block = /SPOKEN_AS_WORD[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (block === null) {
    return 'TIER 2 src/clean/tts-spoken-forms.ts: no `SPOKEN_AS_WORD = new Set([...])` literal '
      + 'found. Either it was renamed or it is now built some other way — and this keeper cannot '
      + 'compare a set it cannot find. Do not delete this check to make it pass: the two copies '
      + 'have silently diverged twice already (COVID 2026-09-06, WWI/WWII 2026-09-13).';
  }
  const theirs = new Set(
    [...block[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => (m[1] ?? m[2]).toLowerCase()),
  );
  const ours = new Set(
    require('../python/narrator/text/caps_acronyms.json').spokenAsWord.map((w) => w.toLowerCase()),
  );
  const missingThere = [...ours].filter((w) => !theirs.has(w)).sort();
  const extraThere = [...theirs].filter((w) => !ours.has(w)).sort();
  if (missingThere.length === 0 && extraThere.length === 0) return null;

  return 'TIER 2 src/clean/tts-spoken-forms.ts: SPOKEN_AS_WORD and caps_acronyms.json.spokenAsWord '
    + 'DISAGREE, and both sides stamp the same NORMALIZER_VERSION.\n      '
    + (missingThere.length ? `Foundry is MISSING: ${missingThere.join(', ')}. ` : '')
    + (extraThere.length ? `Foundry has EXTRA: ${extraThere.join(', ')}. ` : '')
    + '\n      Because all text processing is Foundry\'s at runtime, the LIVE behaviour is '
    + 'whichever side is more permissive, and nothing downstream can tell the two results apart. '
    + 'This is the COVID incident (2026-09-06) and the WWI/WWII one (2026-09-13) recurring. Fix '
    + 'the list, not this keeper.';
}

/**
 * TIER 3, run against the commit the vendored engine came from. Returns a list of
 * problems, which is empty when the freeze holds.
 *
 * IT IS SKIPPED BY NAME WHEN THE BASELINE IS NOT AN ANCESTOR of the shipped
 * commit, and never silently. An engine older than `969dd96` — a deliberate `FOUNDRY_HEAD_OVERRIDE` bisect — is being
 * asked a question about a future it cannot have reached, and answering
 * "changed" there would name the wrong defect. Tiers 1 and 2 still run on it.
 */
function checkFrozenSinceOneDoor(foundry, shippedRev) {
  let descends = false;
  try {
    execFileSync('git', [
      '-C', foundry, 'merge-base', '--is-ancestor', ONE_DOOR_BASELINE, shippedRev,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    descends = true;
  } catch {
    descends = false;
  }
  if (!descends) {
    return {
      problems: [],
      note: `TIER 3 skipped — ${shippedRev} does not descend from ${ONE_DOOR_BASELINE}`,
      frozen: 0,
    };
  }

  const problems = [];
  let frozen = 0;
  for (const file of FROZEN_SINCE_BASELINE) {
    const before = blob(foundry, ONE_DOOR_BASELINE, file);
    const after = blob(foundry, shippedRev, file);
    if (before === null) {
      problems.push(
        `TIER 3 ${file}: absent at the baseline ${ONE_DOOR_BASELINE}. The baseline names a path `
        + 'that was not there, so this check is describing a freeze of nothing.',
      );
      continue;
    }
    if (after === null) {
      problems.push(
        `TIER 3 ${file} @${shippedRev}: gone. Tier 2 will have said so too; this line says it was `
        + `still present at ${ONE_DOOR_BASELINE}, so it was removed by the range in between.`,
      );
      continue;
    }
    if (before.equals(after)) {
      frozen += 1;
    } else {
      problems.push(
        `TIER 3 ${file}: changed between ${ONE_DOOR_BASELINE} and ${shippedRev} `
        + `(${before.length} bytes then, ${after.length} now). Foundry's handoff note claims these `
        + 'three came through the one-door rework untouched. Read the commits in '
        + `\`git -C <foundry> log ${ONE_DOOR_BASELINE}..${shippedRev} -- ${file}\` and DECIDE: a `
        + 'port keeps the transform and gets recorded beside the pin above; a rule move means '
        + 'NORMALIZER_VERSION or PUNCTUATION_SPEC_VERSION should have moved with it and every '
        + 'stamped book, cached record and training corpus keyed off the old one is now lying.',
      );
    }
  }
  return { problems, note: null, frozen };
}

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
    console.log(skipLine(
      'no Foundry checkout on this machine. '
      + `Tried: ${tried.join(', ')}. Set FOUNDRY_REPO to point at one.`,
    ));
    return;
  }

  // Every anchor must RESOLVE before anything is compared. A missing commit
  // would otherwise read as thirteen missing files, which names the wrong
  // problem: a shallow clone or an unfetched Foundry is not a drifted copy.
  requireCommit(bookforge, BOOKFORGE_ANCHOR, 'BookForge');
  for (const entry of FILES) {
    const from = entry.shipped?.revendoredFrom;
    if (from) requireCommit(bookforge, from, `BookForge (re-vendor source for ${entry.ours})`);
  }
  const anchor = foundryShipped(foundry);
  const FOUNDRY_SHIPPED = anchor.rev;
  for (const rev of [VENDOR_PASS, VENDOR_LEAVES, ONE_DOOR_BASELINE, FOUNDRY_SHIPPED]) {
    requireCommit(foundry, rev, 'Foundry');
  }

  const problems = [];
  let handover = 0;
  let carried = 0;
  let pinned = 0;
  let replaced = 0;
  let agreed = 0;
  let revendored = 0;
  let resynced = 0;

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

    if (shipped === null) {
      // The one file checked by VALUE rather than by bytes. See
      // `checkSpokenAsWordAgreement`.
      const trouble = checkSpokenAsWordAgreement(atShip);
      if (trouble === null) agreed += 1;
      else problems.push(trouble);
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

    if (shipped.resynced) {
      // FOUNDRY moved and this side followed. Two questions: has Foundry moved
      // AGAIN (the pin), and does this checkout still carry what it followed?
      // The WORKING COPY, not HEAD — a keeper checks the checkout as it stands,
      // and a resync is asserted before it is committed as well as after.
      const actualSha = sha256(atShip);
      if (actualSha !== shipped.sha256) {
        problems.push(
          `TIER 2 ${theirs} @${FOUNDRY_SHIPPED}: sha256 ${actualSha}, pinned ${shipped.sha256} `
          + `(resynced from ${shipped.resynced}: ${shipped.why}). Foundry moved it AGAIN since this `
          + 'side followed; read the commit and decide whether to follow again.',
        );
        continue;
      }
      const onDisk = Buffer.from(
        fs.readFileSync(path.join(bookforge, ours)).toString('binary').replace(/\r/g, ''), 'binary');
      if (!onDisk.equals(atShip)) {
        problems.push(
          `TIER 2 ${ours}: recorded as RESYNCED from Foundry ${shipped.resynced} and this `
          + `repository's copy (${onDisk.length} bytes) no longer equals Foundry's `
          + `(${atShip.length} bytes). Somebody edited the followed copy here; the rule it `
          + 'carries is Foundry\'s, so the edit belongs there.',
        );
        continue;
      }
      resynced += 1;
      continue;
    }

    if (shipped.revendoredFrom) {
      // BOOKFORGE moved and Foundry followed. Three questions, in the order
      // that names the defect best: whose bytes, then the pin, then whether
      // this side has moved on again since.
      const source = blob(bookforge, shipped.revendoredFrom, ours);
      if (source === null) {
        problems.push(
          `TIER 2 ${ours}: recorded as re-vendored from BookForge ${shipped.revendoredFrom} and `
          + 'the file is not in this repository at that commit. The record names a handover that '
          + 'did not happen.',
        );
        continue;
      }
      if (!source.equals(atShip)) {
        problems.push(
          `TIER 2 ${ours} -> ${theirs} @${FOUNDRY_SHIPPED}: recorded as vendored BYTE-FOR-BYTE `
          + `from BookForge ${shipped.revendoredFrom} (${source.length} bytes) and Foundry's copy `
          + `is ${atShip.length} bytes and differs. This is Foundry-side drift on a file this `
          + 'repository authored: read their commit and DECIDE — a port gets recorded beside the '
          + 'pin here, a rule move means the two programs now read text by different rules while '
          + 'stamping the same NORMALIZER_VERSION.',
        );
        continue;
      }
      const actualSha = sha256(atShip);
      if (actualSha !== shipped.sha256) {
        problems.push(
          `TIER 2 ${theirs} @${FOUNDRY_SHIPPED}: sha256 ${actualSha}, pinned ${shipped.sha256}. `
          + `The bytes still match BookForge ${shipped.revendoredFrom}, so BOTH SIDES MOVED `
          + 'TOGETHER and only this pin was left behind — which means a re-vendor happened and '
          + 'nobody made the decision this pin exists to force. Read the commit, then repin with '
          + 'the reason beside it.',
        );
        continue;
      }
      const atHead = blob(bookforge, 'HEAD', ours);
      if (atHead === null) {
        problems.push(
          `TIER 2 ${ours}: gone from BookForge at HEAD, while Foundry still ships a copy vendored `
          + `from ${shipped.revendoredFrom}. Deleting the source of a vendored file is a decision `
          + 'and nothing here records it.',
        );
        continue;
      }
      if (!atHead.equals(source)) {
        problems.push(
          `TIER 2 ${ours}: A RE-VENDOR IS OWED. This repository's copy at HEAD (${atHead.length} `
          + `bytes) is no longer what Foundry was vendored from at ${shipped.revendoredFrom} `
          + `(${source.length} bytes), and Foundry @${FOUNDRY_SHIPPED} still carries the copy it `
          + 'took from that commit. '
          + '`foundry clean-text` is what runs a book, so THEIR copy is the live behaviour and '
          + 'this side\'s file currently describes nothing — the COVID incident\'s exact shape. '
          + 'Get it vendored, then move `revendoredFrom` and the sha256 here with the reason.',
        );
        continue;
      }
      revendored += 1;
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
    /*
     * THIS SIDE'S VERSION IS READ FROM THE WORKING COPY, not from
     * BOOKFORGE_ANCHOR. Until 2026-09-24 both said n6 and the difference was
     * invisible; the anchor is the 2026-09-05 HANDOVER commit and says n6 for
     * ever, so reading it there would assert a fact about a file this
     * repository no longer ships. What a stamped book is checked against at
     * runtime (`narration-text-readiness.ts`) is the constant as it stands.
     */
    const hereText = fs.readFileSync(path.join(bookforge, version.ours), 'utf8');
    const hereMatch = version.pattern.exec(hereText);
    const here = hereMatch === null ? null : hereMatch[1];
    const there = read(foundry, FOUNDRY_SHIPPED, version.theirs);
    if (here !== version.expected || there !== version.expected) {
      problems.push(
        `${version.name}: BookForge (working copy) says ${here}, Foundry ${FOUNDRY_SHIPPED} `
        + `says ${there}, and this keeper expects ${version.expected} on both. The version is what `
        + 'a stamped book, a cached copy and a training corpus all key off; a mismatch means two '
        + 'programs are reading text by different rules while claiming the same name.',
      );
    }
  }

  // ── Tier 3: the one-door freeze ───────────────────────────────────────────
  const freeze = checkFrozenSinceOneDoor(foundry, FOUNDRY_SHIPPED);
  problems.push(...freeze.problems);

  assert.deepStrictEqual(
    problems, [],
    'The Foundry engine\'s copy of the narration text pass does not match this repository:\n  '
    + problems.join('\n  '),
  );

  assert.strictEqual(handover, FILES.length, 'every file must be checked at its vendor commit');
  assert.strictEqual(carried + pinned + replaced + agreed + revendored + resynced, FILES.length);
  console.log(
    `PASS test-foundry-clean-text-vendor — handover: ${handover}/${FILES.length} byte-identical to `
    + `bookforge ${BOOKFORGE_ANCHOR} at foundry ${VENDOR_PASS}/${VENDOR_LEAVES}. `
    + `Shipped (${FOUNDRY_SHIPPED}): ${carried} carried verbatim, ${pinned} ported and pinned, `
    + `${revendored} re-vendored FROM this repo at a later commit and pinned, `
    + `${resynced} resynced FROM Foundry and pinned, `
    + `${replaced} replaced by the engine's own driver, ${agreed} checked by VALUE. `
    + `${VERSIONS.map((v) => v.expected).join('/')} agree on both sides. `
    + (freeze.note ?? `${freeze.frozen}/${FROZEN_SINCE_BASELINE.length} frozen since `
      + `${ONE_DOOR_BASELINE}. `)
    + `(${foundry}; anchor from ${anchor.source})`,
  );
}

if (require.main === module) main();

/**
 * `vendoredEngineCommit` is exported so tools/test-keeper-runner.js can drive the
 * anchor's derivation against a scratch repository, without a Foundry checkout.
 */
module.exports = { vendoredEngineCommit };
