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
  'test-crucible-engine-routing',
  'test-crucible-connect-code',
  'test-crucible-module-backend',
  // The two facts found with two owners and nothing comparing them on
  // 2026-09-13 (crucible/docs/ARCHITECTURE.md R1): the caps fold's keep-set,
  // which narrator and Listen read DIFFERENT subsets of out of one JSON — "Nasa"
  // on Listen, "NASA" in the m4b, and "Wwii" in both — and the Higgs safe band,
  // where a silent overlay override let thirdreich advertise a 600-1000 range
  // for four days after it was measured at 500-700.
  'test-one-fact-one-owner',
  'test-higgs-engine',
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
  /*
   * THREE SUITES WERE RETIRED HERE ON 2026-09-15, with the local narrator spawn
   * (docs/LEGACY-REMOVAL.md). Named rather than silently dropped, for the same
   * reason 'test-orpheus-argv-snapshot' is named above: a suite that vanishes
   * from a list looks like it was never there.
   *
   *   'test-higgs-doctor-arms'  — the two Higgs doctors and the dispatcher that
   *     chose between them. `higgsDoctor()` and `higgsEnvironmentRefusal()` are
   *     deleted: the engine runs on a Crucible server, which answers for its own
   *     environment. Its two defects are recorded in docs/LEGACY-REMOVAL.md — a
   *     Mac shown "WSL distribution" as the reason it could not narrate, and the
   *     mirror bug, `return null` on darwin having checked NOTHING. That second
   *     one is the durable lesson and outlives the file: AN UNCHECKED PASS IS AS
   *     BAD AS A WRONG REFUSAL, and it is the quieter of the two.
   *
   *   'test-serve-spawn-env'    — the Listen server's 33-variable spawn, pinned
   *     against a baseline from the commit before the narrator cut-over. Its
   *     subject was `buildSpawnPlan` in orpheus-worker-pool.ts; there is no
   *     local Listen server. The VARIABLES are not lost — every one of them,
   *     with its measured value and the reason for it, is in
   *     docs/LEGACY-REMOVAL.md's appendix, which is where they matter now: as
   *     the specification Crucible's recipes are checked against.
   *     `tools/serve-spawn-extract.js` and `tools/smoke-serve-spawn.js` went
   *     with it. `tools/snapshots/serve-spawn-base.json` is KEPT as data, like
   *     orpheus-argv-base.json.
   *
   *   'test-narrator-log-strings' — the four matchers that read the render
   *     worker's stdout (PROGRESS_LINE_RE, GENERATION_ACTIVITY_RE, the two
   *     MODEL_LOAD ones, REPAIR_START_RE). There is no worker and no stdout; a
   *     Crucible render's progress arrives as the server's own job events. The
   *     suite's argument was that each matcher fails SILENTLY and in the wrong
   *     direction — a progress line that stops matching freezes the watchdog's
   *     clock and kills a worker that was rendering perfectly — and that is
   *     worth remembering the next time anything here parses a log to decide
   *     whether a process is alive.
   */
  'test-no-e2a-doors',
  // THE REPO IS PUBLIC (Owen, 2026-09-18: "I don't want anything to make it out
  // on the internet if it doesn't belong there — passwords, file paths, etc.").
  // A machine's name or address is a fact owned by that machine's config, never
  // by source or by a doc a stranger reads, so this greps every tracked text
  // file for the operator's hostnames, LAN and tailnet addresses, home paths and
  // credential shapes, and fails by name with file:line.
  'test-no-machine-addresses',
  // PHASE 15's deletion, pinned the same way. Ollama, Claude and OpenAI left
  // BookForge entirely (Owen: "they dont have ollama fallbacks or cloud anything
  // at all") — an Ollama server, an Anthropic key and an OpenAI key are UPSTREAMS
  // configured on the ENGINE, and a class reaches one by being ROUTED there. A
  // deletion that size comes back one helper at a time, so every door is named:
  // the two transports, the model lists, the key stores, the provider pickers,
  // the IPC channels, and the property that no BookForge-owned file ever holds
  // a key. It also names the two files of the legacy spawn layer that still
  // dial an Ollama for VRAM eviction and the number pass — they go with that
  // layer, and the list going empty is how you know it went.
  'test-no-cloud-doors',
  // And the Enhance tab's deletion, pinned the same way. Owen dropped Resemble
  // Enhance whole on 2026-09-14 ("drop and remove the enhance page and the
  // corresponding crucible route. it's unnecessary"), so it neither became a
  // job type nor stayed a local env. Half this suite forbids: the bridge, the
  // env component, the thirteen IPC channels, the route, the rail entry. The
  // other half INSISTS — "enhance" means three unrelated things here, and a
  // grep-and-delete pass aimed at the tab would silently take the hiss
  // separator and the RVC voice pass with it.
  'test-no-enhance-doors',
  // And the legacy local-render layer's deletion, pinned the same way again
  // (2026-09-15, docs/LEGACY-REMOVAL.md). `routing.legacyLocalRender` was the ONE
  // switch that rendered on this machine instead of on a Crucible server, and
  // every GPU door carried a `legacyLocal` arm beside its Crucible one. Both are
  // gone, and a layer that size comes back one option at a time. Half this suite
  // forbids: the field, the setter, the IPC channel, the five venue-arm
  // spellings, the door option. The other half INSISTS — a record on disk that
  // still carries the key must be READ and stripped rather than refused; an old
  // queue row assigned to the deleted narrator must HOLD by name rather than be
  // re-decided onto another card; the in-app GPU bench row and `epub-align`
  // survive, because that act is UNMIGRATED and not legacy (ROLLOUT_PLAN §B7);
  // and Orpheus stays NAMEABLE in the Listen picker.
  'test-no-legacy-venue-doors',
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
  // WHICH MACHINE the figures came from. Owen ran one book on both cards on
  // 2026-09-15 and the two records were indistinguishable — 89 chunks, 301
  // sentences, 42,059 characters each, and nothing saying where. Every rate in
  // a record is a property of the card as much as of the book, so this suite
  // pins the venue onto the records that know it (TTS, cleanup, both analyses,
  // translation), pins the absence as unrepairable on the ones that do not
  // (RVC's local urvc spawn, the deterministic TTS-prep pass), and — with the
  // reserved `local` identity being erased the same day — pins that no name is
  // ever special-cased or mapped to a prettier one.
  'test-analytics-venue',
  // The generation step on somebody else's card (rollout item 2.4), against a
  // FAKE Crucible — the real one needs the card. It pins the five things that
  // would otherwise be found at 3 a.m. on a real book: the whole book goes up
  // in ONE job (a chapter at a time looks identical until you watch the
  // percentage), the SERVER's fraction is what the bar reports, one ledger
  // record per chunk carrying the engine's own verdict, `<index>.flac` under
  // the local naming, and a 409 server_busy that FAILS the render naming the
  // holder instead of quietly taking this machine's GPU.
  'test-crucible-render',
  // WHOSE NUMBERS A BOOK IS PACKED TO (2026-09-15). The engine owns the voice's
  // facts and the client owns the chunking, so the ceiling, the floor and the
  // pace come from the VENUE's `GET /v1/voices` row and never from this
  // machine's catalog — which on Windows was the `served` arm's block whatever
  // machine the render was bound for, and which is how Owen's Mac render was
  // refused `chunk_too_long` before a second of audio. Against a fake stating
  // 800 while the local catalog states 900: the ceiling clamped to the cap, the
  // two refusals by name (a voice the venue does not advertise, a row with no
  // cap), the target clamp, the voice document prep packs against, and a chunk
  // over the cap refused HERE with nothing submitted.
  'test-crucible-venue-band',
  // A render on a Crucible server never enters WSL (2026-09-14): the session
  // is host-native from the start whatever the engine's toggle says, the prep
  // runs in the tools env (measured before it spawns), the SHIPPED completion
  // tail never calls the normaliser for it, and the scratch-root refusal is
  // reached BEFORE a legacy WSL prep rather than after a finished render.
  'test-crucible-render-session',
  // The ONE job helper every Crucible door shares (tier 3, 2026-09-14), and the
  // two doors built on it. Against a fake speaking the real routes — uploads as
  // multipart, SSE with ids and Last-Event-ID, artifacts with sidecars, DELETE.
  // `test-crucible-job` pins the conversation itself: inputs cross as blobs and
  // the submit names them, the SERVER's fraction and `warming` reach the caller,
  // artifacts land with provenance or in memory from done's list, every refusal
  // by name and none retried (server_busy WITH the holder's line, a 4xx by the
  // server's code, 401, unreachable, protocol), a failed job and a cancelled one
  // as their own classes, cancel = DELETE with what landed kept (R6), attachTo
  // uploads nothing. `test-crucible-asr` pins "Generate sentences" travelling:
  // the whisper-size table with no default, the media-tag sentinels → `auto`,
  // the cue grouping rule for rule with the local script, the m4b under its own
  // extension, the VTT at the local path, refusals BEFORE the upload where the
  // server can be asked, and the venue door (legacy → local and says so; the
  // caller's name wins). `test-crucible-align` pins forced alignment to the
  // seam narrator owns past: qwen3 → qwen3-aligner and whisperx refused by
  // name, the spoken reading from the session's own record with marker-only and
  // audio-less chunks named, one job with <index>.flac inputs, cues and
  // alignment.json landing in the session, and `runCoverageAlign`'s venue
  // routing — including the Crucible run failing BY NAME for the owed narrator
  // door rather than quietly shipping no coverage report.
  'test-crucible-job',
  'test-crucible-asr',
  'test-crucible-align',
  // The LEASE (Owen, 2026-09-14: "Models should always be unloaded when we're
  // done with them. Every time."). A Crucible now clears the card the moment no
  // job, no lease, no session and no chat hold it — and a chat holds NOTHING, so
  // every chat-shaped run this app makes is a sequence of requests the server
  // sees as idle between. The chat door also never loads, so without a lease the
  // next chunk is not slow, it is refused `model_not_resident` and the book dies
  // at chunk 2 of 600. This suite is therefore about the ways the lease could
  // quietly not be held: taken once for a whole act rather than per request,
  // heartbeated at a third of its ttl, released on success, throw, cancel and
  // quit alike, a 404 on release read as the no-op it is, a 404 on a heartbeat
  // read as a server that RESTARTED and answered with a new lease rather than a
  // log line, and `409 model_leased` reaching the reader with the holder's name
  // so a queue row holds instead of failing. It also pins the negative: the
  // one-job doors and the streaming door do NOT lease, because a job holds the
  // lane and a session holds the claim already — and for `tts`/`align` a lease
  // would make the server refuse the very job that took it.
  'test-crucible-lease',
  // AND ONE LEASE FOR A ROW OF THEM. A row that cleans and then simplifies took
  // two leases, and Owen's unload ruling means the model is gone in the gap —
  // so the second act is answered `model_not_resident` and the row dies between
  // two steps that both worked. Every check here is a way the lease could
  // quietly not be held across the seam, or be held across an hour of ffmpeg
  // that has no use for it.
  'test-crucible-row-lease',
  // The voice conversion on that same helper and that same fake (tier 3,
  // 2026-09-14). Its centre is an identity and a knob, each of which could be
  // lost with nothing failing: a voice has THREE spellings — BookForge's asset
  // id, the urvc folder name, Crucible's manifest id — none derivable from the
  // others, so the table is checked against the shipped catalog rather than
  // trusted; the per-conversion knobs arrive under the wire's own names with
  // ABSENCE preserved (an absent f0_method is what leaves urvc on its tuned
  // default); `batchSize` is refused by name because recycling is the server's
  // memory bound; and a job that ends `done` having converted fewer files than
  // it was given fails rather than handing assembly a gapped set.
  'test-crucible-rvc',
  // The denoise, same night, same fake: only the SEPARATOR moves — blocking
  // stays in the client — so the seam is one block in, the primary stem out, and
  // the primary is the one the SERVER named, never the one whose filename says
  // `(dry)`. A `done` with no primary and a primary the job never wrote are both
  // refused by name; `params` is empty ON PURPOSE and the check says so.
  'test-crucible-denoise',
  // The sentence re-roll, and the one knob that CANNOT travel: the local worker
  // spreads its takes across sampling temperatures and a `tts` render has no
  // sampling channel at all, so handing them over is a named refusal instead of
  // a job quietly sent without them. Plus one job per take at take 0 carrying
  // every named index, `take<k>/<index>.flac` under the local naming, and the
  // guard verdicts in the ledger keyed PER TAKE — three takes of one sentence
  // are three renders, not three chunks.
  'test-crucible-reroll',
  // The Listen path on somebody else's card (rollout tier 3): the three
  // streaming surfaces drive ONE scheduler, and behind it a Crucible streaming
  // session now stands beside the local narrator, chosen by the SAME venue
  // decision the render makes (the one legacy switch included). Against a
  // fake Crucible speaking the stream routes. It pins: open/say/close in
  // order and on the wire, audio to the consumer in order byte for byte,
  // every row in the ledger as crucible-stream / stream-unguarded with a
  // capped row delivered as is (Listen never re-rolls — ruling 3), and the
  // refusals — stream_session_open, server_busy with the SDK's busyLine,
  // voice_not_resident, engine_in_use, unreachable — by name, with the local
  // pool never started instead.
  'test-crucible-stream',
  // Which servers exist, and which one a render goes to — the two records the
  // Crucible Servers settings row writes (rollout items 2.1, 2.2). Both are
  // credential-adjacent and both are the kind of state whose defects are
  // silent: a registry that quietly replaced a corrupt file would lose every
  // token at once, a rank record that quietly pruned a name would lose a
  // machine's place, and a venue decision that quietly fell back to the local
  // narrator would take a GPU somebody else is using and finish the book in a
  // voice nobody chose. Neither suite needs a server, a card or the network.
  //
  // `test-crucible-servers` is also where the ABSENCE of the reserved name
  // `local` is pinned (Owen's ruling, 2026-09-15). Not by reading a comment:
  // it asks the registry what the word does and gets `unknown_server`, checks
  // that `LOCAL_SERVER_NAME` and `describeLocal` export nothing, that the
  // registry constructor takes a file and no local reader, and that no module
  // named `local` is emitted or imported. A reserved identity comes back as a
  // constant and a branch, so those are what is watched.
  'test-crucible-servers',
  'test-crucible-routing',
  // AND THE ONE-TIME MOVE OF THAT NAME OUT OF THIS MACHINE'S RECORDS. Four
  // files under `<userData>` could name it — the registry, the rank record, the
  // upstream record and the QUEUE — and a row left naming it would refuse
  // `unknown_server` for ever. So the migration is lossless or not made at all,
  // and this suite drives it over a copy of Owen's own records: every reference
  // rewritten in one pass, idempotent, finished rather than repeated after a
  // crash, and — the half that matters — every refusal asserted to leave all
  // four files BYTE-IDENTICAL, because "refused" and "half-applied" look the
  // same from a log line.
  'test-crucible-retire-reserved-name',
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
  // THE HOSTED half of that same seam, and the only suite in this list whose
  // subject is somebody else's SOURCE. `foundry-app/` is a vendored subtree, so
  // every claim BookForge makes about what the hosted window can do is a fact
  // with two owners — and on 2026-09-14 one of them changed and the other did
  // not: foundry gave `runEngine` a per-run environment, the re-vendor brought
  // it in, and the refusal went on quoting `env: process.env` for ten hours.
  // This reads the subtree instead of remembering it: the engine spawn still
  // takes an overlay (losing it would send BookForge's OWN text acts
  // unauthenticated), the job seam still carries none, and the vendored
  // registry still cannot resolve a credential hosted — the last of which is a
  // TRIPWIRE that goes red on the re-vendor with the instructions on it, which
  // is the point. Plus the registry BookForge hands that window under Owen's
  // one-owner ruling: priority order, disabled entries kept and marked, ONE
  // kind of row wherever the machine is, a name that will not resolve omitted
  // and RECORDED, and a call before the first reading refused by name rather
  // than answered with an empty list a window cannot tell from "you have none".
  'test-foundry-hosted-crucible-seam',
  // The module file BookForge posts to a Crucible, and the one property that
  // matters about it: it is a COPY. `shared/crucible/bookforge.module.json` is
  // GENERATED in the crucible repo from its own manifests
  // (`scripts/gen-modules.py`, PHASE13-OPERATOR.md section 5.4) and vendored
  // here byte for byte — which replaced `BOOKFORGE_JOB_TYPES` and the printed
  // pull list in `electron/crucible/install.ts`, two hand-kept restatements of
  // ids the manifests already own. A copy with nothing comparing it to its
  // source is R1's shape, so this compares them, and it checks the shape the
  // server validates a module by (only `tts` names a narrator engine; the five
  // subject kinds) so a bad entry is found here and not halfway through an
  // operator's progress bar. Skips the byte comparison BY NAME on a machine
  // with no crucible checkout.
  'test-crucible-module-file',
  // COORDINATION, and the button that is not there (crucible
  // docs/PHASE14-ENVPACKS.md section 4a, 2026-09-14). "Set up for BookForge"
  // is deleted: presence of the app is the request, so every connect makes
  // sure that engine has what BookForge needs. The defect this guards is the
  // obvious implementation — posting the idempotent module on every connect —
  // which is CORRECT and still wrong, because a Crucible runs one task at a
  // time: two apps starting together collide on `task_busy`, and a book
  // rendering refuses its own app with `server_busy` over a task whose every
  // entry would have come back `skipped`. So the read comes first and is
  // pinned here at ZERO posts, beside the three answers a post can get that
  // are each a different act — `task_busy` FOLLOWED rather than re-posted,
  // `server_busy` waited out with the holder verbatim and a settle read off
  // the server's own `accepts_work`, and a refusal about the REQUEST failing
  // ONCE by name and remembered. Plus the surface: the button's label is gone
  // from every renderer source, the wizard's connected face offers nothing to
  // press, and every job type the module asks for has words a person can read.
  'test-crucible-coordinate',
  'test-crucible-connections',
  // PHASE 15: the engine's own settings document, driven through the REAL SDK
  // against a fake server. This suite used to keep a dated seam alive — its first
  // check asserted that `vendor/crucible-client-0.6.0.tgz` still lacked the four
  // methods `electron/crucible/settings-wire.ts` stood in for, so that the day it
  // grew them the red would be the instruction rather than a mystery. It grew
  // them; the seam is deleted, the check with it, and what is left is the door:
  // a key is write-only both ways, one PUT configures an upstream AND routes to
  // it, a Test does not store what it tested, and a `llama-windows` engine
  // answers for the five WSL-only classes with ONE sentence so a screen says it
  // once. Section 4's TRIPWIRE — which asserted, on purpose, that the vendored
  // SDK refused a capability document in which no row carries `route` — FIRED
  // on 2026-09-14 and is now the plain check §3.3 always described: such a
  // server predates the field and every class on it is local. Nothing in
  // BookForge changed for it, which is the dividend of never having worked the
  // defect around.
  'test-crucible-settings-seam',
  // THE CONNECT CODE ON THIS MACHINE, and the one thing BookForge's reader
  // still does differently from the SDK's. Split out of the seam suite when the
  // Phase 15 SDK shipped and that seam was deleted:
  // `electron/crucible/pairing-file.ts` did NOT go with it, because the SDK's
  // reader is async (a packaging rule of theirs) while `discoverCrucible` is
  // synchronous (an architectural constraint of ours). Its OTHER two reasons —
  // the SDK's path rule omitting PHASE15 §3.6's Windows case, and an empty file
  // reading as "no engine" — were asserted here as tripwires, fired on the
  // 0.6.0 re-pack, and are now agreement checks: one rule, executed twice, with
  // the composed path and both refusals compared side by side.
  'test-crucible-pairing-file',
  // PHASE 15 §5.2, the half of it that reaches a person: "settings are the
  // engine's; the app draws a window". The suite above proves the wire; this
  // one proves the WINDOW. Four IPC doors — and the two new read/write ones
  // are `bookforge:crucible-engine-settings*` rather than `crucible:settings`, because
  // the vendored Foundry owns that name and a duplicate `ipcMain.handle`
  // stops the app booting. It drives the main-process doors against the fake
  // (one PUT that configures an account AND routes a class to it, a Test that
  // stores nothing, a refusal that keeps its code AND the dotted path naming
  // the control it is about), and it EXECUTES the wording file — transpiled,
  // fed a real `llama-windows` capability document — to prove the five
  // WSL-only classes collapse into one line, which is what §3.3's shared
  // sentence is for. The renderer's half is a SOURCE pin and says so in its
  // header: an Angular component cannot be required from node, so what is
  // pinned is that the key box is bound to a draft the one draw function
  // clears, that no key reaches `settings.service.ts`, and that Test is drawn
  // before Save.
  'test-crucible-settings-window',
  // The FIFTH act, and the one that is not a text act (rollout tier 3,
  // 2026-09-14). Page reading moves onto Crucible as an ENDPOINT rather than as
  // a job, because `pages` is a capability class whose `job_type` is `llm` —
  // there is no `vlm-pages` job type and no `crucible/jobs/pages/`, and this
  // suite checks both of those against the crucible checkout rather than
  // trusting them. Its centre is a URL and a routing fact. foundry composes the
  // page route's URL by a DIFFERENT rule from the text route's — verbatim
  // `/chat/completions` against `normaliseVllmEndpoint`'s appended `/v1` — so
  // the page base carries its own version segment and both foundry rules are
  // re-read out of foundry's source. And `dots-ocr` has no `mlx-darwin` block on
  // purpose, so a Mac venue must refuse in a way that reads as "page reading is
  // the PC's", with both ways forward, rather than as a fault — checked against
  // the manifest's own shape so it cannot pass on a premise that stopped being
  // true. Plus the credential in the spawn's environment and nowhere printable,
  // no load door at all, and the ONE legacy switch keeping today's WSL vLLM.
  'test-crucible-pages',
  // THE INSTALL STORY (2026-09-14): the setup wizard and Settings offer to
  // install a Crucible here or point at one elsewhere. Its centre is a SEAM —
  // `@crucible/bootstrap` 0.5.0 is written and ships as an asset of a Crucible
  // release nobody has cut, so the package is deliberately not a dependency and
  // `electron/crucible/install.ts` is typed against its real `.d.ts` instead.
  // The failure this guards is that seam quietly becoming a placeholder: the
  // loader must refuse by the package's OWN code (`bootstrap_not_installed`)
  // carrying the command that clears it, the driven door must refuse as well as
  // the button being disabled, and both must wear ONE sentence. Beside it the
  // package is really vendored and really imported; Windows installs ONE way
  // and it is the host's loopback door (driven over a scripted runner and a
  // scripted door, so nothing spawns, downloads or elevates); the plan carries
  // NO shell to paste, because that was a second copy of an installer the
  // package owns; and the four doors' states, including the card that must
  // name the Crucible a run is going to rather than "this machine's GPU (WSL)".
  'test-crucible-install-seam',
  // ...and taking one off again. `crucible uninstall` is the ENGINE's verb;
  // what is pinned here is that the door is LOCAL ONLY (`uninstall_not_local`
  // for anything else — an engine is uninstalled on the machine it is on),
  // that the weights are KEPT unless asked otherwise and that "kept" is
  // reported with its size, that the dry run is the same plan the real run
  // performs, and that an unreadable document is refused rather than drawn as
  // an empty list that looks like success.
  'test-crucible-uninstall',
  'test-narration-modal-voice-never-substituted',
  'test-stream-engine-availability',
  'test-session-engine-provenance',
  // 'test-assembly-after-wsl-normalize' was here until 2026-09-15, and the file
  // is gone with it. Its whole subject was `normalizeWslSessionToWindows`, which
  // copied a session off ext4 after a legacy WSL render and repointed prepInfo —
  // deleted with the local spawn layer (docs/LEGACY-REMOVAL.md). No render this
  // app can construct writes a session into the guest any more, so there is
  // nothing to normalise and nothing to repoint.
  //
  // ITS LESSON IS KEPT BECAUSE IT IS NOT ABOUT WSL: a repointing that updates
  // three fields of a record and not the fourth fails SILENTLY when the fourth
  // is the one a downstream door reads. What made it invisible was the other
  // half — mediainfo answers a path past 260 characters with a SILENT 0.0
  // duration, so the book assembled WRONG instead of failing. Any code that
  // rewrites a set of paths should be asked which reader takes which field.
  'test-wsl-sweep-serve-exclusion',
  'test-extension-typecheck',
  // PHASE 16: the browser extension talks to a Crucible with no BookForge in
  // between, which puts the Listen text path in TWO bundles built by two
  // toolchains. The failure is silent by construction — a split that differs by
  // one character makes a resumed block splice one row's audio under another
  // row's text — so the FUNCTION BODIES are compared byte for byte rather than
  // the imports. It also compares the one number the shared file could not
  // import: the Crucible read-ahead depth against the local pool's ramp width.
  'test-listen-text-one-source',
  // And the two columns of the plan's table (§0), by name. The left one has to
  // be present in the extension before BookForge's TTS server button can go;
  // the right one has to stay absent, which is the half that rots, because a
  // dropped control comes back one helpful commit at a time.
  'test-extension-option-columns',
  // The extension's own connect door: one pasted `crucible://` line, a device
  // code, and telling "that is not a Crucible" from "that address is wrong".
  // It existed and was run BY NOBODY until 2026-09-17, which is exactly what
  // the list's own guard above is for — a keeper nothing runs is a keeper that
  // has stopped keeping, and this one passed the whole time, which is the way
  // that goes unnoticed.
  'test-extension-pairing',
  // A backtick inside a template's own comment ENDS the template literal, and
  // the errors then point at unrelated lines. It happened three times on
  // 2026-09-17 -- two HTML comments and one CSS comment in styles: [...] --
  // because every other comment in this codebase quotes identifiers that way.
  'test-no-backticks-in-templates',
  // The main process may only import what the PACKAGED app ships. `tsc` and
  // every keeper resolve against the checkout's node_modules, where a build
  // tool's transitive dependency has been hoisted to the top — so an import
  // nobody declared works everywhere except the one place that matters. It
  // reached Owen as "Cannot find module '@xmldom/xmldom'" from the installed
  // app, with the package present in node_modules and absent from package.json.
  'test-no-undeclared-runtime-deps',
  // …and step 8 itself: BookForge's TTS server, deleted (Owen, 2026-09-15: "there
  // shouldnt be tts server logic in bookforge anymore at all, including the
  // settings"). Same two-column shape, from the other side: half forbids the
  // relay, the module, the `tts-api:*` IPC pair, the nav-rail button and the
  // Settings section's voice pickers; half INSISTS the carried rows are still in
  // the extension, because deleting BookForge's copy is only correct while the
  // extension has them. A third half names the three things a tidy-up takes by
  // accident — the tab recorder's endpoint, the Streaming tab on the scheduler,
  // and `src/app/core/listen/` staying uncreated.
  'test-no-tts-server-doors',
  // THE ZERO-SHOT CLIP, through both clients and the module they share. A
  // `zeroshot` voice is the base weights plus somebody's recording, so the
  // failure this pins is the quietest one in the whole pipeline: a clone
  // conditioned on the wrong clip, or on no transcript, is a whole book in a
  // subtly wrong voice REPORTED AS SUCCESS. It executes
  // `shared/crucible/voice-reference.ts` (the RIFF/WAVE, 30-second, 32 MiB
  // and blank-transcript refusals, in the server's own words, before a
  // megabyte crosses a tailnet), source-pins the extension's picker and
  // refusal the way the suite above does, drives BookForge's four
  // `zeroshot-*` rows through a real socket to a fake Crucible to prove the
  // catalog's BOOK-EXACT transcript is what lands in `params.reference`, and
  // carries ONE tripwire: the 0.6.0 SDK drops `resident.reference` from
  // `/v1/activity`, so both clients read that one field themselves, and the
  // day it is modelled the check goes red naming the two functions to delete.
  'test-zeroshot-reference',
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
  // HOW MANY BOOKS ARE IN FLIGHT, AND WHERE. One slot set per machine
  // (crucible `docs/PHASE7-LANES.md` §2.4). The defects are silent in both
  // directions: too few slots and a second registered server is never used at
  // all — a whole night of one card idle — and too many and two venues over
  // one 3090 Ti start together, which looks like a working queue until both
  // runs OOM.
  'test-queue-slot-sets',
  // THE QUEUE'S GPU DIAL AND THE PENDING BAND
  // (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`). Where the dial's value lives — its
  // own record, refused rather than replaced when corrupt — plus the bench's
  // grouping and the fact that Pending and the live queue partition the runs
  // exactly. The defects it defends are silent: a dial reset to `any` by a
  // rename starts sending books to a card the operator steered away from, and a
  // staged book that leaked into the live queue would commit a GPU nobody had
  // pressed Send on. The PRECEDENCE table itself is driven in
  // `test-queue-wait-for`, beside the routing it defers to.
  'test-queue-gpu-dial',
  // WHICH MACHINES CAN SPEAK WHICH VOICE, and the two different authorities that
  // answer it. The picker used to ask THIS machine's disk — a box that, in
  // orchestrator mode, renders nothing — so it greyed out voices the engine could
  // speak and offered voices it could not. It now asks the servers.
  //
  // The half that must never regress silently is ROUTING. A voice only one server
  // serves LOCKS the venue to it (Owen, 2026-09-15), so if an unreachable Mac
  // counted as "the Mac does not have this voice", a voice both machines serve
  // would present as 3090-only the moment the Mac slept and pin a book to the PC
  // with nobody choosing it. Every screen would look healthy.
  //
  // The other half is the exception that proves it: the four zero-shot voices are
  // `clips = "from-request"`, so BookForge uploads the bytes off its own disk and
  // the LOCAL check is the right one for exactly those. Both are pinned here so a
  // later change cannot quietly merge two questions that have two answers.
  'test-voice-inventory',
  // WHAT `build:electron` COPIES, AND WHAT IT MUST. Eleven source paths in one
  // shell line, none of them checked — so a directory deleted in a refactor sits
  // there until somebody runs a full build and gets a bare "cp: no such file or
  // directory" five minutes in. That is how electron/scripts/higgs went when the
  // local spawn layer was deleted: tsc clean, keepers green, build broken.
  //
  // The other direction is the quiet one and is asserted from the RUNTIME side:
  // text-server.ts resolves serve_text_vllm.sh through a candidate that walks UP
  // out of dist/ into the checkout, so a dev run finds it whether or not the
  // build copied it — while a packaged app, whose `files` is dist/** alone, has
  // no checkout to walk into. Present-in-the-checkout is not the requirement;
  // copied-into-dist is.
  'test-build-copies',
  // A RENDER ON ANOTHER MACHINE HOLDS NO CARD HERE. `acquireGpuForJob` took this
  // machine's GPU lease for EVERY render until 2026-09-15, including ones bound
  // for the Mac: resolveTtsDeviceArg answers from this box's hardware and knows
  // nothing about the venue. The lock was held correctly, for a job that did not
  // want it — AI cleanup and epub-align queued behind a render happening
  // somewhere else, and the Ollama models were evicted to free VRAM nothing here
  // would use. Nothing errored and nothing logged it.
  //
  // The gate tests WHICH server, never merely whether the venue is crucible: a
  // Crucible server can BE this machine (the WSL engine on the PC), and that
  // render does use this card. Pinned because `GenerationVenue` has one member,
  // so the wrong spelling is now always true and would skip the lease for local
  // renders too.
  'test-gpu-lease-venue',
  // WHERE EACH STEP OF A BOOK RUNS. §4.4 — every step of one book runs on the
  // machine the book was assigned — and the failure is SILENT by construction:
  // §4's safety default is that an undeclared step does not travel, so a
  // missing `machines()` reads as a working queue while a book rendered on the
  // Mac does its RVC, its hiss pass and its alignment on this card. One of
  // those took a fine-tune's card at 00:50 on 2026-09-14.
  'test-queue-step-travel',
  // AND THE PASS STEPS, which travelled last and by a different road: a pass
  // config nests its provider under `simplify`/`translate`, so every reader of
  // "whose model is this" was looking at a top-level field that is never
  // there — and `processing-passes.ts` expanded the provider block BY HAND,
  // with no `crucible` arm at all. Also pins which MODEL each act leases,
  // which is what stops a row holding the 9B's lease into a step that must
  // load the 27B.
  'test-queue-pass-travel',
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
  // The THIRD named exception to "deterministic text fixes are for Listen only"
  // (Owen, 2026-09-14: "i want to deterministically expand bible book names …
  // it's a mess"). Its negative corpus is the feature: "Rev. Martin Luther
  // King", "Col. Sanders", "my ex.", "Ch. 3:7" and "Act 3:2" all print a token
  // the table knows and must come out byte for byte. Also the invariant that
  // makes it safe — every name it produces is STILL detected as a reference, so
  // renaming the book cannot unprotect the digits.
  'test-bible-books',
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
  // THE NARRATION PICKER OFFERS HIGGS AND ONLY HIGGS (2026-09-14). Beside the
  // suite above rather than inside it because the question is different: that one
  // is the general retired-id doctrine (load it, display it, refuse to run it),
  // this one is the NARROWING — the picker's list, and the shipped defaults that
  // had to move with it. It exists because Owen's "higgs is the frontier" ruling
  // was written into every doc in the repo and into none of the code, so the
  // narrate modal went on offering Orpheus FIRST for a month, and the only thing
  // that caught it was Owen opening the dialog.
  'test-narration-engine-retirement',
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
  // 'test-worker-completion-throw' was here until 2026-09-15, and the file is
  // gone with it: its six checks drove the WSL copy-failure path inside
  // `checkAllWorkersComplete`, and both the copy and the worker `close` handlers
  // that called it are deleted (docs/LEGACY-REMOVAL.md).
  //
  // ITS LESSON IS KEPT AND IS NOT ABOUT WSL EITHER. A function called as a
  // FLOATING PROMISE, in a process that installs no `unhandledRejection`
  // handler, sends a throw NOWHERE: no completion event was emitted, the session
  // was never removed from `activeSessions` so the queue row sat at
  // "Assembling…" forever with no timeout, `session.completionError` — the only
  // carrier a headless run has — was never set, and the GPU lease was never
  // released, so every later job waited out its full timeout. The comment that
  // claimed an enclosing `catch` covered it was wrong by about a hundred and
  // eighty lines, and only brace-counting showed it. Wherever a tail is invoked
  // without `await`, the throw is the thing to ask about.
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
