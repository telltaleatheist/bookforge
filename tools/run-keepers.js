#!/usr/bin/env node
/**
 * Run the keeper suites this phase must keep green, and print one line each.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/run-keepers.js
 *
 * Not a test itself — a runner, so the whole set can be checked in one command
 * on a shell that will not take a for-loop.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * REFUSE A STALE BUILD BEFORE RUNNING A SINGLE SUITE.
 *
 * The suites load COMPILED modules out of dist/electron, so a source-green tree
 * with an old dist reports red — and the failure names the test, which is the
 * wrong end to start debugging from (it cost a real debugging round on
 * 2026-08-18, on both machines' account). Newest source mtime vs newest compiled
 * mtime is a cheap honest proxy: tsc rewrites its outputs on every run, so a
 * compile that happened after the last edit always wins this comparison.
 */
function newestMtime(root, extension) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  walk(root);
  return newest;
}

const repo = path.join(__dirname, '..');
const newestSource = Math.max(
  newestMtime(path.join(repo, 'electron'), '.ts'),
  newestMtime(path.join(repo, 'shared'), '.ts'),
  newestMtime(path.join(repo, 'packages', 'quire', 'src'), '.ts'),
);
const newestCompiled = newestMtime(path.join(repo, 'dist', 'electron'), '.js');
if (newestCompiled === 0) {
  console.error(
    'dist/electron holds no compiled output, and the keepers load compiled modules. '
    + 'Run: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
if (newestSource > newestCompiled) {
  console.error(
    'dist/electron is older than the TypeScript sources, so the keepers would test a build '
    + 'that no longer matches the code. Run: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

const SUITES = [
  // The two facts found with two owners and nothing comparing them on
  // 2026-09-13 (crucible/docs/ARCHITECTURE.md R1): the caps fold's keep-set,
  // which narrator and Listen read DIFFERENT subsets of out of one JSON — "Nasa"
  // on Listen, "NASA" in the m4b, and "Wwii" in both — and the Higgs safe band,
  // where a silent overlay override let thirdreich advertise a 600-1000 range
  // for four days after it was measured at 500-700.
  'test-one-fact-one-owner',
  'test-higgs-engine',
  // The TWO Higgs doctors and the platform dispatch between them. Separate from
  // test-higgs-engine because that suite is about the engine id, the catalog and
  // the spawn; this one is about which environment a machine is asked about, and
  // it drives every platform as a fixture.
  'test-higgs-doctor-arms',
  // The wsl.exe argv trap: a script handed to wsl.exe without --exec is run
  // through the distro's default shell, which expands every $ before bash sees
  // it. That silently made the Higgs doctor report a correctly patched env as
  // missing both patches (measured 2026-09-05). Half of this suite is pure and
  // runs everywhere; the live half is win32-and-wsl-gated and skips by name.
  'test-wsl-script-invocation',
  // 'test-orpheus-argv-snapshot' was here until 2026-09-04, and the file itself is
  // gone as of 2026-09-05. It pinned the five ebook2audiobook command lines; Phase
  // 3 replaced all five, so its anchors named code that no longer exists and it
  // could not run at all — a test nobody can run is worse than no test, because it
  // looks like coverage in a directory listing. Superseded by
  // test-narrator-argv-snapshot. Its BASELINE is kept, as data:
  // tools/snapshots/orpheus-argv-base.json, described in that directory's README.
  'test-narrator-argv-snapshot',
  'test-serve-spawn-env',
  'test-narrator-log-strings',
  'test-no-e2a-doors',
  // The coverage policy is declared in two languages — narrator's
  // engine_profiles.py and shared/queue/coverage-policy.ts. It stopped deciding
  // whether a run aligns on 2026-09-07 (that is a stage of the run now), and
  // still says which engines narrator considers AUDITED — the flag stamped into
  // every report, and a divergence means the same card reads two ways.
  'test-coverage-policy-mirror',
  // The audit REPORTS and never blocks (Owen, 2026-09-05). A regression here is
  // silent in the worst way: a book with 36 minutes of good audio becomes
  // unassemblable again because one row decided to fail on what it found.
  'test-coverage-audit-reports',
  // What the guard decided about a chunk, and the two ways to lose it silently:
  // reading "we were not told" as "it was fine", and knowing the ladder's words
  // on this side so they can drift from what the ladder actually did. Both are
  // live — `hole` was found missing from the written verdict list on 2026-09-13
  // while the Crucible half was being wired, and the pinned @crucible/client
  // discards `guard` inside readChunk(), which this suite MEASURES rather than
  // assumes. Before it, a guard fire's only record was a WARN line in a shared
  // daily text file (ARCHITECTURE.md R4).
  'test-chunk-guard-ledger',
  // The generation step on somebody else's card (rollout item 2.4), against a
  // FAKE Crucible — the real one needs the card. It pins the five things that
  // would otherwise be found at 3 a.m. on a real book: the whole book goes up
  // in ONE job (a chapter at a time looks identical until you watch the
  // percentage), the SERVER's fraction is what the bar reports, one ledger
  // record per chunk carrying the engine's own verdict, `<index>.flac` under
  // the local naming, and a 409 server_busy that FAILS the render naming the
  // holder instead of quietly taking this machine's GPU.
  'test-crucible-render',
  // Which servers exist, and which one a render goes to — the two records the
  // Crucible Servers settings row writes (rollout items 2.1, 2.2). Both are
  // credential-adjacent and both are the kind of state whose defects are
  // silent: a registry that quietly replaced a corrupt file would lose every
  // token at once, a rank record that quietly pruned a name would lose a
  // machine's place, and a venue decision that quietly fell back to the local
  // narrator would take a GPU somebody else is using and finish the book in a
  // voice nobody chose. Neither suite needs a server, a card or the network.
  'test-crucible-servers',
  'test-crucible-routing',
  // The four TEXT acts on somebody else's card (rollout item 2.6). Its centre
  // is a credential and a name: the bearer token must be in the spawn's
  // environment and in NOTHING a log or a command line can carry, and a
  // simplify must never tell the server it is a translate (Owen's ruling,
  // 2026-09-13 — a bench showing the wrong act name is worse than one showing
  // none, and crucible refuses an act it does not know). It also pins the two
  // refusals that keep a book honest: a model that is not resident stops the
  // run BEFORE any spawn and never loads one on somebody's card, and an engine
  // that cannot address a Crucible says so rather than 404ing an hour in.
  'test-crucible-text-acts',
  'test-narration-modal-voice-never-substituted',
  'test-stream-engine-availability',
  'test-session-engine-provenance',
  'test-assembly-after-wsl-normalize',
  'test-wsl-sweep-serve-exclusion',
  'test-extension-typecheck',
  'test-gpu-ownership',
  'test-editor-state-store',
  'test-family-lifecycle',
  'test-working-copy-remint',
  'test-working-copy-lifecycle',
  'test-ledger-lifecycle',
  'test-narration-pairing',
  'test-pass-lifecycle',
  'test-pass-diff',
  'test-narration-deletions',
  'test-book-block-category',
  'test-chapter-heading-insert',
  'test-book-block-text',
  'test-element-text-edit',
  'test-layout-neutral-edit',
  'test-book-path-routing',
  'test-book-chapter-titles',
  'test-book-chapter-add',
  'test-narration-carry',
  'test-writer-attribute-safety',
  'test-element-uid-stamp',
  'test-legacy-layout-state',
  'test-epub-provenance-lifecycle',
  'test-processing-chain',
  'test-queue-engine',
  // Which project a session-consuming row is about, and the session a narration
  // hands the row behind it. Both halves of the 2026-09-12 Starcraft failure: a
  // Foundry-ordered run has no `projectId`, and the assembly chained under one
  // refused a project it was carrying in its own config.
  'test-chained-assembly-project',
  // WHICH MACHINE A BOOK RENDERS ON. A named server is an instruction, so the
  // defects this defends are silent by construction: a row re-routed onto
  // slower hardware overnight, a default that manufactures a choice nobody
  // made, and a 409 read as a failure — each of which looks like a working
  // queue right up until the audio is in the wrong voice or the night is gone.
  'test-queue-wait-for',
  'test-queue-bench',
  // The only thing that knows what is happening inside an MLX decode. Its
  // rowsRetiredInCall is added to a user-visible chunk count (2026-09-11), so a
  // carry that survives the wrong batch boundary counts chunks twice — and the
  // carry rule is invisible from the call site, which only reads the field.
  'test-mlx-batch-progress',
  'test-derived-sentences',
  // The assembly seals THIS RUN'S transcript, chosen by stem, and its finalize
  // resolves whatever the body does. Both halves of the 2026-09-07 hang.
  'test-assembly-transcript-seal',
  'test-assembly-prepare-progress',
  'test-narration-chain',
  'test-chapter-gap',
  'test-alignable-text',
  'test-sentence-abbreviations',
  'test-text-normalization',
  // The Listen packer's ramp. One sentence per Higgs row put a render's worth of
  // latency on every sentence boundary; packing to the band from the first chunk
  // would stall playback instead. Both failures are silent — the listener hears a
  // gap on a machine that is working perfectly — so the ramp inequality itself is
  // asserted over every chunk of every fixture.
  'test-listen-chunks',
  'test-narration-reading-law',
  // The arbiter that starts and stops the text-pass vLLM (Owen, 2026-09-08:
  // "build that piece"). Every branch is driven through the module's injected
  // deps — no GPU, no WSL, no weights — plus the agreements it cannot fake: the
  // launcher's port and dtype knobs, and the doors that bracket their spawns.
  'test-text-server',
  'test-narration-clean-text-door',
  'test-narration-text-readiness',
  'test-prompt-examples',
  'test-narration-text-two-family',
  'test-tts-number-rules',
  'test-tts-number-normalizer',
  'test-cli-narration-prep',
  // The wire, per CLI command: the adapter requires the COMPILED bridge and
  // calls the exact symbol the app's queue step calls. See
  // docs/CLI_PARITY_AUDIT.md for the table it defends.
  'test-cli-parity',
  // The model-picking doors on the render commands (2026-09-12): a checkpoint, a
  // sampling value and a band reach the settings object, and every flag that
  // belongs to the other engine / the other arm / the other door is refused BY
  // NAME. It drives the wrapper with --dry-run; no GPU, no model, no library.
  'test-cli-flags',
  'test-library-lock',
  'test-job-timing',
  // The throughput window itself: burst engines (Higgs lands 32 rows at once)
  // measured 15x fast while the window ended at `now` instead of at the last
  // landing. See the file's header for the live evidence.
  'test-rate-window',
  'test-vlm-convert-plan',
  'test-vlm-convert-attach',
  'test-foundry-host',
  'test-foundry-host-nodes',
  'test-foundry-host-status',
  'test-foundry-host-queue',
  'test-foundry-progress',
  // The narration text pass left this repository for the Foundry engine (Owen,
  // 2026-09-05). These two hold the two halves of what that leaves behind: that
  // what was handed over is what arrived and has not drifted since, and that the
  // stamp the engine WRITES is still readable by the reader BookForge KEPT — a
  // writer and a reader of one JSON object in two repositories, neither of which
  // compiles against the other. Both skip by name on a machine with no Foundry.
  'test-foundry-clean-text-vendor',
  'test-foundry-narration-stamp',
  // 'test-foundry-narrate-form' was here until 2026-08-26. It kept
  // electron/foundry-narrate-form.ts — the static field description Foundry drew
  // Narrate's dialog from — and both went together when the dialog came back to
  // BookForge's own window. The half of that press worth keeping, which of a
  // project's exports it means, is test-foundry-narrate-target below.
  'test-foundry-narrate-target',
  'test-foundry-landing',
  'test-foundry-adopt',
  'test-foundry-export-landing',
  // cli/clean-lines-step.js — a file of training lines through `foundry clean-text`
  // in one process, written back by position. Drives an injected engine; no foundry needed.
  'test-clean-lines',
  'test-legacy-migration',
  'test-legacy-bilingual-manifest',
  'test-retired-engine-settings',
  'test-ipc-collision',
  'test-derivation-cache',
  'test-versions-page-data',
  'test-cover-thumbnails',
  'test-bookshelf-ids',
  'test-bookshelf-standalone',
  'test-bookshelf-queue-routes',
  'test-bookshelf-stream-teardown',
  'test-cli-exit-drain',
  // ── The three silent-output defects of 2026-09-13, one check each (R1) ────
  //
  // A working copy is an exploded DIRECTORY, so `extname(p) !== '.epub'` said
  // "not a book" about every book in the library and the CLI's text pass did
  // nothing, in silence: digits narrated as printed and struck-out passages read
  // aloud. Also holds the other half — a project renders through the PROJECT
  // pass, which is the only route that re-cuts the copy carrying the strikes.
  'test-cli-narration-text-gate',
  // A failed manifest registration logged and then resolved SUCCESS: the m4b on
  // disk, `outputs.audiobook` never set, nothing listed anywhere, "Reassembly
  // complete!" on the row.
  'test-reassembly-registration-failure',
  // `normalizeWslSessionToWindows` throws by design and had no enclosing try, in
  // a function called as a floating promise from four places, in a process with
  // no unhandledRejection handler: the row sat at "Assembling…" forever and the
  // GPU lease was never released. Drives the SHIPPED tail, lifted.
  'test-worker-completion-throw',
  // ── THE 30 THAT WERE NEVER RUN (2026-09-13) ──────────────────────────────
  //
  // A census found 92 of the 121 `tools/test-*.js` files listed here and 29 not,
  // and THREE of the unlisted ones had been red since 2026-08-12 with nothing
  // anywhere saying so: two fixtures too small to reach their own real claim
  // after the analysis page box widened (c2413c06), and a guard that crashed on
  // import and ran zero checks. An unrun guard in a directory listing looks like
  // coverage and is not — crucible/docs/ARCHITECTURE.md R2. So the default is
  // now that a `test-*.js` file IS listed here, and a suite that cannot run on
  // some machine SKIPS BY NAME with exit 0 rather than being left out.
  //
  // Every one below was measured green on the PC before it was added.
  //
  // The two that paginate a real book under Electron. Their fixtures had to be
  // widened to reach their own assertions again.
  'test-analyzer-exploded-book',
  'test-quire-cache-identity',
  // Pagination in full. SKIPS BY NAME when BOOKFORGE_KA_EPUB does not point at
  // the Killing America EPUB — the one fixture here that is not in the repo, and
  // a regression test that names three specific plates, so no other book will do.
  'test-quire',
  // The EPUB container seam and what is read out of the markup.
  'test-epub-container',
  'test-epub-markup-categories',
  'test-epub-provenance',
  'test-exploded-working-copy',
  'test-document-binding',
  // The library's write paths: moving an artifact into place, deleting, resetting.
  'test-artifact-movement',
  'test-deletion-write-path',
  'test-reset-book',
  'test-retired-passes',
  'test-version-family',
  'test-render-beside-recording',
  'test-session-authorship',
  // The editor and the text it is shown.
  'test-editor-layout',
  'test-display-run-merge',
  'test-chapter-openings',
  'test-simplify-blocks',
  'test-listen-text',
  // The VLM half — all three are the part of the feature that is worth proving
  // with no GPU and no server: what is banked, what is planned, what is promised.
  'test-vlm-readings-bank',
  'test-vlm-endpoint',
  'test-vlm-eta',
  // Components, upgrades and the GPU arbiter's ANSWER (pure — nothing is spawned
  // and nothing touches a card).
  'test-component-upgrades',
  'test-qwen-align-env',
  'test-gpu-arbiter',
  'test-clean-step-door',
  'test-foundry-manifest-version',
  'test-tab-recorder',
  // Drives a REAL narrator refusal through a REAL python to prove the reason
  // reaches the user. SKIPS BY NAME where the tools env is not installed.
  'test-narrator-refusal-surfacing',
];

/**
 * EVERY `tools/test-*.js` IS LISTED, OR THE LIST SAYS WHY NOT.
 *
 * The whole lesson of the 2026-09-13 census is that a guard nobody runs cannot
 * go red, so leaving one off this list is not a neutral act. This makes that
 * impossible to do silently: a new `test-*.js` file that is not in SUITES fails
 * the run by name, and the only way past it is to add it — or to give it the
 * skip shape (`SKIP: <reason>`, exit 0) and add it anyway.
 */
const onDisk = fs.readdirSync(__dirname)
  .filter((f) => /^test-.*\.js$/.test(f))
  .map((f) => f.replace(/\.js$/, ''));
const unlisted = onDisk.filter((f) => !SUITES.includes(f));
const listedButGone = SUITES.filter((s) => !onDisk.includes(s));

/** A suite that could not run says so on a line of its own and exits 0. */
const SKIP_RE = /^SKIP:\s*(.+)$/m;

let failed = 0;
const skipped = [];
for (const suite of SUITES) {
  const file = path.join(__dirname, `${suite}.js`);
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    ok = false;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const skip = ok ? SKIP_RE.exec(out) : null;
  if (skip) {
    skipped.push({ suite, why: skip[1].trim() });
    console.log(`SKIP  ${suite.padEnd(32)} ${skip[1].trim().slice(0, 120)}`);
    continue;
  }
  const tally = out.trim().split('\n').filter((l) => /passed/.test(l)).pop() || out.trim().split('\n').pop();
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${suite.padEnd(32)} ${(tally || '').trim()}`);
  if (!ok) console.log(out.split('\n').filter((l) => /^FAIL|^ {6}/.test(l)).join('\n'));
}

if (unlisted.length) {
  failed++;
  console.log(`FAIL  ${'(the list itself)'.padEnd(32)} ${unlisted.length} guard(s) exist in tools/ `
    + 'and are run by nobody — add them to SUITES, or give them the SKIP shape and add them:');
  for (const name of unlisted) console.log(`      ${name}`);
}
if (listedButGone.length) {
  failed++;
  console.log(`FAIL  ${'(the list itself)'.padEnd(32)} ${listedButGone.length} name(s) in SUITES `
    + 'have no file — a suite was renamed or deleted and the list was not:');
  for (const name of listedButGone) console.log(`      ${name}`);
}

const ran = SUITES.length - skipped.length;
console.log(`\n${ran} suite(s) ran, ${skipped.length} skipped, ${failed} failing.`);
for (const s of skipped) console.log(`  skipped: ${s.suite} — ${s.why}`);
console.log(failed === 0 ? '\nALL KEEPERS GREEN' : `\n${failed} SUITE(S) FAILING`);
process.exitCode = failed === 0 ? 0 : 1;
