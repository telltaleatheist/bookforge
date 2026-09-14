/**
 * BOOKFORGE HAS NO CLOUD DOORS, AND NO PROVIDER CODE AT ALL.
 *
 * Owen, 2026-09-14 (crucible `docs/PHASE15-HOST.md` §0): *"bookforge/foundry
 * gain a simple contract: send commands to the crucible server. period. they
 * dont have ollama fallbacks or cloud anything at all … one contract, one SDK,
 * one API, one communication method."*
 *
 * So Ollama, Claude and OpenAI left this application. They did not become
 * unreachable, or hidden behind a flag, or moved to a settings page nobody
 * opens: an Ollama server, an Anthropic key and an OpenAI key are UPSTREAMS
 * configured ON THE ENGINE (§2, §3.2), and a capability class reaches one by
 * being ROUTED there — a choice the operator makes once, on the server, before
 * any request, for every app that talks to it. This **overrules** the ruling
 * made the same morning that cloud keys live in Foundry's cloud card
 * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §3): the keys moved into the engine, and
 * Foundry's card became a window onto the same document.
 *
 * ── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
 *
 * The same job `test-no-e2a-doors.js` does for the e2a entry points, and it is
 * written in the same shape on purpose. A deletion this large comes back one
 * helper at a time: somebody needs a model list, writes a three-item array,
 * and six months later the app has a second opinion about which Claude exists.
 * Every door is therefore pinned BY NAME, so its return is a red test naming
 * the thing rather than a code review nobody ran.
 *
 * ── AND ONE PROPERTY THAT IS NOT ABOUT NAMES ──────────────────────────────
 *
 * §0: *"the app's own settings file never holds a key."* The last three checks
 * are about that: no source writes an API key to any BookForge-owned store, no
 * key crosses the IPC seam, and the only place the three vendor names appear
 * is the contract's own `CRUCIBLE_UPSTREAM_NAMES` — the list this app sends TO
 * the engine and never resolves itself.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

/**
 * Every TS source under `electron/`, `shared/` and `src/`, with comments
 * stripped.
 *
 * Comments go for the reason `test-no-e2a-doors.js` states: the history is
 * written down on purpose — several files explain what the deleted door DID —
 * and a test that fails on its own explanation teaches people to delete
 * explanations. NB no `$` on the line-comment pattern: this repo is
 * `core.autocrlf=true`, a split on '\n' leaves '\r', and `.` will not cross a
 * carriage return.
 */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'foundry-app') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const code = raw
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
        out.push({ file: path.relative(REPO, p).replace(/\\/g, '/'), code });
      }
    }
  };
  walk(path.join(REPO, 'electron'));
  walk(path.join(REPO, 'shared'));
  walk(path.join(REPO, 'src'));
  return out;
}

const FILES = sources();

/** Which files still contain `needle`, as repo-relative paths. */
function hits(needle, only) {
  return FILES
    .filter((f) => (only === undefined || only(f.file)) && f.code.includes(needle))
    .map((f) => f.file);
}

console.log('BookForge has no cloud doors');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The two modules that were the doors
// ─────────────────────────────────────────────────────────────────────────────

check('electron/cloud-credentials.ts is gone — the app reads nobody\'s key record', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'electron', 'cloud-credentials.ts')),
    'cloud-credentials.ts is back. It read Foundry\'s `cloudProviders` out of app-settings.json, '
    + 'which PHASE15 §0 overruled: the keys are the ENGINE\'s now.');
});

check('electron/ollama-capabilities.ts is gone — nothing here probes an Ollama', () => {
  assert.ok(!fs.existsSync(path.join(REPO, 'electron', 'ollama-capabilities.ts')),
    'ollama-capabilities.ts is back. An Ollama server is an upstream the engine is configured '
    + 'with; what it can do is the engine\'s question, asked through GET /v1/capability.');
});

check('src/.../ai-cleanup.service.ts is gone — the renderer has no Ollama client', () => {
  assert.ok(!fs.existsSync(path.join(
    REPO, 'src', 'app', 'features', 'audiobook', 'services', 'ai-cleanup.service.ts')),
  'ai-cleanup.service.ts is back. It listed models off a local Ollama and cleaned one chapter '
  + 'at a time; the cleanup a person runs is the EPUB pass, through the queue.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every deleted symbol, by name
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Grouped by what each group was, because a name coming back is only half the
 * news — the other half is which door it reopens.
 */
const DELETED = {
  'the two cloud transports': [
    'callClaude', 'callOpenAI', 'cleanChunkWithClaude', 'cleanChunkWithOpenAI',
    'analyzeChunkClaude', 'analyzeChunkOpenAI', 'translateWithClaude', 'translateWithOpenAI',
  ],
  'the Ollama transport': [
    'callOllama', 'cleanChunkWithOllama', 'analyzeChunkOllama', 'translateWithOllama',
    'generateEditListWithOllama', 'verifyOllamaGenerate', 'checkOllamaConnection',
    'getOllamaThinkFields', 'ollamaModelSupportsThinking', 'ollamaBaseUrl',
  ],
  'the cloud model lists': [
    'getClaudeModels', 'getOpenAIModels', 'fetchClaudeModels', 'CLAUDE_MODELS', 'OPENAI_MODELS',
    'claudeModels', 'openaiModels',
  ],
  'the key stores and their readers': [
    'claudeApiKey', 'openaiApiKey', 'hasClaudeKey', 'hasOpenAIKey', 'hasApiKeyForProvider',
    'cloudCredentialsFor', 'cloudCredentialsForAnalysis', 'cloudCredentialsForTranslation',
    'readCloudSlots', 'readCloudSlotsIn', 'requireCloudSlot', 'requireCloudSlotIn',
    'describeCloudSlots', 'cloudSettingsPath', 'cloudKindForProvider', 'CloudProviderKind',
    'CloudSlotView', 'CloudCredentialsError', 'cloudProviders',
  ],
  'the provider types and pickers': [
    'AnalysisProvider', 'isAnalysisProvider', 'ClaudeConfig', 'OpenAIConfig', 'OllamaConfig',
    'ClaudeContentBlock', 'sanitizeClaudeResponse', 'logClaudeResponseDiagnostic',
  ],
  'the one-chapter Ollama cleanup': [
    'cleanupText', 'cleanupChapterStreaming', 'AICleanupService',
  ],
  'the lease subject a row used to name': [
    // Deleted with the same ruling: the model is `capability.selected` on the
    // server the row was placed on, which a synchronous hook cannot ask for.
    'crucibleModelForAiStep',
  ],
};

for (const [what, names] of Object.entries(DELETED)) {
  check(`${what}: ${names.length} name(s), none of them back`, () => {
    const back = [];
    for (const name of names) {
      const where = hits(name);
      if (where.length > 0) back.push(`${name} (${where.join(', ')})`);
    }
    assert.strictEqual(back.length, 0,
      `these are back: ${back.join('; ')}.\n`
      + '        BookForge has no provider code (crucible PHASE15 §0). Whatever this was for, '
      + 'the engine already does it: a key is PUT to /v1/settings, a class is ROUTED to an '
      + 'upstream, and what an upstream offers comes from POST /v1/settings/upstreams/<n>/test.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. No vendor endpoint is ever composed here
// ─────────────────────────────────────────────────────────────────────────────

check('no source builds a URL to a cloud vendor', () => {
  for (const host of ['api.anthropic.com', 'api.openai.com', 'anthropic-version']) {
    const where = hits(host);
    assert.strictEqual(where.length, 0,
      `${host} is back in: ${where.join(', ')}. The ENGINE calls the upstream, on the `
      + 'operator\'s account, and translates the shape (PHASE15 §3.4). This app sends one '
      + 'OpenAI-shaped request to one Crucible.');
  }
});

check('no source hardcodes a cloud model id', () => {
  for (const id of ['claude-3-5-sonnet', 'claude-sonnet-4', 'gpt-4o', 'gpt-4-turbo']) {
    const where = hits(id);
    assert.strictEqual(where.length, 0,
      `${id} is back in: ${where.join(', ')}. §2: "the server does not ship a cloud model `
      + 'list" and neither does this app — the ids come from the upstream itself, through '
      + 'the engine\'s test route, at the moment they are shown.');
  }
});

/**
 * THE LEGACY LOCAL SPAWN LAYER'S OWN OLLAMA, and why it is not a provider.
 *
 * Two files still dial `localhost:11434`, and both belong to the layer that is
 * deleted WHOLE after Owen's in-app pass (crucible PHASE15 §6,
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md` §0b A2 — with ~250 GB of envs). Neither is a
 * text PROVIDER; neither is reachable from any AI door:
 *
 *  · `gpu-arbiter.ts` — `unloadOllamaModel`/`unloadOllamaModels`. It EVICTS an
 *    Ollama the user happens to be running on this machine so the legacy
 *    narrator spawn can have the card. It asks nothing of a model and gets no
 *    text back; it is VRAM arbitration, and its caller is
 *    `parallel-tts-bridge.ts`.
 *  · `tts-number-normalizer-runner.ts` — the number pass that runs between the
 *    narration cut and that same spawn, on this machine's own model. Its
 *    request MOVED here from `ai-bridge.ts` rather than being kept alive in a
 *    bridge that no longer has providers: one owner, dying with the layer that
 *    needs it. Its only caller is `parallel-tts-bridge.ts`.
 *
 * They are NAMED here rather than left as a hole in the pattern, so that a
 * THIRD file dialling 11434 is a red test, and so that the day the layer goes
 * this list goes empty rather than quietly staying true.
 */
const LEGACY_OLLAMA_FILES = [
  'electron/gpu-arbiter.ts',
  'electron/tts-number-normalizer-runner.ts',
];

check('no source dials an Ollama, except the legacy spawn layer\'s own two files', () => {
  /*
   * THE PORT IS THE TEST, and the paths are only evidence.
   *
   * `/api/tags` and `/api/generate` are Ollama's routes and they are also
   * perfectly ordinary strings: `bookshelf-server.ts` SERVES a `/api/tags` of
   * its own, about book tags, on BookForge's own HTTP server. A check that
   * failed on the path alone would be telling a true-sounding lie about a file
   * that has never heard of Ollama. So a file dials an Ollama when it names
   * the PORT — 11434, which nothing else in this codebase uses — and the paths
   * are checked only inside a file that does.
   */
  const dialers = hits('11434').filter((f) => !LEGACY_OLLAMA_FILES.includes(f));
  assert.strictEqual(dialers.length, 0,
    `these files name Ollama's port: ${dialers.join(', ')}. The only files allowed to dial one `
    + `are ${LEGACY_OLLAMA_FILES.join(' and ')}, and they go with the legacy spawn layer.`);
  for (const needle of ['/api/generate', '/api/show']) {
    const withPort = new Set(hits('11434'));
    const where = hits(needle).filter((f) => !LEGACY_OLLAMA_FILES.includes(f) && withPort.has(f));
    assert.strictEqual(where.length, 0, `${needle} against an Ollama is in: ${where.join(', ')}`);
  }
  for (const legacy of LEGACY_OLLAMA_FILES) {
    assert.ok(fs.existsSync(path.join(REPO, legacy)),
      `${legacy} is gone — delete it from this list too, and if the list is now empty, delete `
      + 'the exception and this check with it.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The provider union, and the IPC seam
// ─────────────────────────────────────────────────────────────────────────────

check('AIProvider is exactly crucible and local, in both places that spell it', () => {
  const wanted = "'crucible' | 'local'";
  for (const file of ['electron/ai-bridge.ts', 'src/app/core/models/ai-config.types.ts']) {
    const src = FILES.find((f) => f.file === file);
    assert.ok(src !== undefined, `${file} is gone`);
    assert.ok(new RegExp(`export type AIProvider\\s*=\\s*${wanted.replace(/[|]/g, '\\|')}`).test(src.code),
      `${file} does not declare AIProvider as ${wanted}`);
  }
  const pass = FILES.find((f) => f.file === 'shared/processing/pass-types.ts');
  assert.ok(/export type PassAiProvider\s*=\s*'crucible' \| 'local'/.test(pass.code),
    'PassAiProvider must stay a subset of AIProvider, and there are only two members left');
});

check('the IPC seam carries no credential and no cloud model list', () => {
  for (const channel of ['ai:get-claude-models', 'ai:get-openai-models', 'ai:check-connection',
    'ai:get-models', 'ai:cleanup-chapter', 'ai:cleanup-progress']) {
    const where = hits(channel);
    assert.strictEqual(where.length, 0, `${channel} is still wired in: ${where.join(', ')}`);
  }
  const preload = FILES.find((f) => f.file === 'electron/preload.ts');
  assert.ok(/checkProviderConnection: \(provider: AIProvider, crucibleServer\?: string\)/.test(preload.code),
    'checkProviderConnection grew an argument back. The middle one was `apiKey`, and there is '
    + 'no key on this side of the seam to put in it.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. No key is ever stored by BookForge
// ─────────────────────────────────────────────────────────────────────────────

check('nothing writes an API key into a BookForge-owned store', () => {
  /*
   * §0: *"BookForge's setup page writes the Anthropic key straight to the
   * engine and reads capability back; the app's own settings file never holds
   * a key."*
   *
   * The check is for a key reaching one of the app's OWN records — app-settings,
   * tool-paths, the queue's state file, the renderer's localStorage blob. A key
   * on its way to `PUT /v1/settings` is the point of the whole phase and is not
   * stored anywhere on the way past; the wire type that carries it
   * (`CrucibleEngineSettingsPatch`) is write-only by construction, which
   * `tools/test-crucible-settings-seam.js` proves against a fake that is
   * capable of holding one.
   */
  const stores = ['app-settings.json', 'tool-paths.json', 'bookforge-settings', 'queue-engine.json'];
  const keyish = /\b(apiKey|api_key|anthropicKey|openaiKey)\b/;
  const offenders = [];
  for (const f of FILES) {
    if (!keyish.test(f.code)) continue;
    if (!stores.some((store) => f.code.includes(store))) continue;
    offenders.push(f.file);
  }
  assert.strictEqual(offenders.length, 0,
    `these files name both a credential and one of BookForge's own stores: ${offenders.join(', ')}. `
    + 'A key lives in the engine\'s config.toml and nowhere else.');
});

check('the three vendor names appear only as the engine\'s upstream list', () => {
  /*
   * `anthropic`, `openai` and `ollama` survive in exactly one role: the names
   * the CONTRACT gives the three upstreams an engine can be configured with
   * (§1). BookForge sends them to the engine and resolves none of them, so the
   * only files that may spell them are the ones that describe that wire.
   */
  const allowed = new Set([
    // The contract's own vocabulary: the three names BookForge sends TO the
    // engine and resolves none of.
    'shared/crucible/settings-wire.ts',
    'electron/crucible/settings-wire.ts',
    'electron/crucible/routes.ts',
    'src/app/features/settings/components/crucible-words.ts',
    /*
     * READING A PERSISTED HISTORY IS NOT PROVIDER CODE.
     *
     * A queue row written before this build still says `claude`, and a details
     * panel's job is to say what actually ran. These three LABEL such a value
     * — `RETIRED_AI_PROVIDERS` and two `formatProvider`-shaped switches that
     * answer "OpenAI (retired)" — and none of them offers the choice, builds a
     * request or reads a key. Deleting the labels would not delete the rows;
     * it would make an old row print a bare `openai` at somebody.
     */
    'src/app/core/models/ai-config.types.ts',
    'src/app/features/queue/components/job-details/job-details.component.ts',
    'src/app/features/queue/components/job-step/job-step.component.ts',
  ]);
  const offenders = [];
  for (const f of FILES) {
    if (allowed.has(f.file)) continue;
    if (/'(anthropic|openai)'/.test(f.code)) offenders.push(f.file);
  }
  assert.strictEqual(offenders.length, 0,
    `these files name a vendor as a value: ${offenders.join(', ')}. The three upstream names are `
    + 'the engine\'s vocabulary; anything that branches on one here is provider code coming back.');
  /*
   * The three LABELLING files may name a vendor and may not act on one. A
   * `fetch` or an `apiKey` beside the label is the line.
   */
  for (const file of ['src/app/core/models/ai-config.types.ts',
    'src/app/features/queue/components/job-details/job-details.component.ts',
    'src/app/features/queue/components/job-step/job-step.component.ts']) {
    const src = FILES.find((f) => f.file === file);
    assert.ok(src !== undefined, `${file} is gone`);
    assert.ok(!/fetch\(|apiKey/.test(src.code),
      `${file} does more than LABEL a retired provider now — it acts on one.`);
  }
});

console.log(`\nno cloud doors: ${failures === 0 ? 'all clear' : `${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
