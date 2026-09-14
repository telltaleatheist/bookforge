/**
 * THE APP IS A WINDOW ONTO THE ENGINE'S SETTINGS — and holds none of them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-settings-window.js
 *
 * crucible `docs/PHASE15-HOST.md` §5.2: *"Each app's AI/engine settings
 * section and its wizard's AI step draw the engine's settings document (3.1)
 * for the selected server and write through with PUT /v1/settings (3.2). The
 * app holds nothing: no key, no route, no model list. A key field is empty on
 * every draw (write-only) with the hint beside it."* And: *"There is no Save
 * button that writes an app file and syncs later."*
 *
 * `test-crucible-settings-seam.js` already proves the MAIN-PROCESS half of
 * that against a fake server. This suite is about the half that reaches a
 * person: the four IPC doors that carry the document across, and the panel
 * that draws it.
 *
 * ── WHY HALF OF THIS IS A SOURCE PIN, AND WHY THAT IS NOT A DODGE ─────────
 *
 * The panel is an Angular component (`ai-setup-wizard.component.ts`). It is
 * compiled by `ng build` into a bundle, it imports through the `@shared/*`
 * path alias, it is a class decorated with a template, and NONE of that can be
 * `require`d from node — there is no dist/renderer module to load and no DOM
 * to mount it in. A keeper that wanted to press its buttons would need a
 * browser harness this repo does not have and would not be a keeper any more.
 *
 * So the renderer's half is pinned by READING ITS SOURCE, and the three
 * properties chosen are the three that a future edit could break silently:
 *
 *   · the key box is bound to a draft that the one draw function CLEARS, so
 *     "empty on every draw" is a property of the code and not a discipline;
 *   · no key reaches `settings.service.ts` — the panel writes nothing to the
 *     app's own store, which is the whole of "the app holds nothing";
 *   · **Test appears before Save** in the template, because Test-before-Save
 *     is an order of operations and a screen that offered them the other way
 *     round would teach the wrong one.
 *
 * A source pin cannot prove behaviour, and these three do not pretend to. What
 * they do is make the deletion of a load-bearing line a red test rather than a
 * code review nobody ran — the same job `test-no-cloud-doors.js` does for the
 * doors that left.
 *
 * Everything that CAN be executed is executed: the words file is transpiled
 * and called with a real capability document that a real fake server served,
 * and the main-process doors are driven over a real socket.
 *
 * No GPU, no model, no network beyond a loopback fake, no registry file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const ts = require('typescript');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, settingsRoutes,
  WSL_ONLY_CLASSES, WSL_ONLY_REASON,
} = require('./fake-crucible.js');

const SEAM = path.join(REPO, 'dist', 'electron', 'crucible', 'settings-wire.js');
if (!fs.existsSync(SEAM)) {
  console.log('SKIP: dist/electron/crucible/settings-wire.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

installElectronStub('bf-crucible-settings-window-');

const seam = require(SEAM);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));

const realGetServer = servers.getServer;
const fakesByName = new Map();
servers.getServer = function getServerWithFakes(name) {
  const fake = fakesByName.get(name);
  if (!fake) return realGetServer(name);
  return { name, url: fake.url, token: 'test-token-abcd', source: 'registry' };
};
let registered = 0;
function nameFake(url) {
  const name = `window-fake${registered += 1}`;
  fakesByName.set(name, { url });
  return name;
}

async function withFake(behaviour, fn) {
  const door = settingsRoutes(behaviour);
  const fake = await startFakeCrucible((req, res, ctx) => door.handle(req, res, ctx));
  const name = nameFake(fake.url);
  try {
    await fn({ name, door, fake });
  } finally {
    await fake.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The words file, EXECUTED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load `crucible-words.ts` into this process.
 *
 * It is renderer TypeScript, but unlike a component it is a plain module of
 * pure functions over the wire shapes — no decorator, no template, no DOM —
 * and `unavailableGroups` is the one function §3.3 makes a behavioural
 * promise about ("the same sentence for all five so an app shows it once").
 * A source pin could see the `find` call and could not see the collapse, so
 * this transpiles the file and calls it.
 *
 * The one rewrite is the `@shared/*` alias, which is `tsconfig`'s and not
 * node's; it points at exactly the module `dist/` already holds.
 */
function loadWords() {
  const file = path.join(REPO, 'src', 'app', 'features', 'settings', 'components', 'crucible-words.ts');
  const source = fs.readFileSync(file, 'utf-8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  }).outputText;
  const shim = new Module(file, null);
  shim.filename = file;
  shim.paths = Module._nodeModulePaths(path.dirname(file));
  const req = (specifier) => {
    if (specifier.startsWith('@shared/')) {
      return require(path.join(REPO, 'dist', specifier.replace('@shared/', 'shared/')));
    }
    return shim.require(specifier);
  };
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', js);
  fn(shim.exports, req, shim, file, path.dirname(file));
  return shim.exports;
}

const words = loadWords();

// ─────────────────────────────────────────────────────────────────────────────
// The sources this suite reads
// ─────────────────────────────────────────────────────────────────────────────

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf-8');
const MAIN = read('electron', 'main.ts');
const PRELOAD = read('electron', 'preload.ts');
const FACADE = read('src', 'app', 'core', 'services', 'electron.service.ts');
const PANEL = read('src', 'app', 'features', 'ai-setup', 'ai-setup-wizard.component.ts');

/**
 * THE FOUR CHANNELS, SPELLED ONCE HERE.
 *
 * `crucible:settings` is NOT among them and must never be: the vendored
 * Foundry registers that name for its own Servers card
 * (`foundry-app/IPC-CHANNELS.md`), two `ipcMain.handle` calls of one name in
 * one Electron main process throw at registration, and BookForge would not
 * start with that window mounted. `tools/test-ipc-collision.js` is the keeper
 * that enforces the rule in general; this list is what this suite is about.
 */
const CHANNELS = [
  'crucible:engine-settings',
  'crucible:engine-settings-write',
  'crucible:upstream-test',
  'crucible:capability',
];

const { check, summary } = makeChecker();

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. The four doors exist, and all three layers of each are wired
  // ───────────────────────────────────────────────────────────────────────────

  await check('main registers all four channels, and never the name Foundry owns', () => {
    for (const channel of CHANNELS) {
      assert.ok(MAIN.includes(`ipcMain.handle('${channel}'`),
        `electron/main.ts does not register ${channel}. The settings window has no supply `
        + 'without it: §5.2 gives the panel a read, a write and a test, and the capability read '
        + 'it re-draws from.');
    }
    assert.ok(!MAIN.includes("ipcMain.handle('crucible:settings'"),
      'main.ts registers `crucible:settings`, which the vendored Foundry also registers '
      + '(foundry-app/IPC-CHANNELS.md). A duplicate ipcMain.handle throws at registration and '
      + 'BookForge will not start with the Foundry window mounted. Ours are crucible:engine-*.');
  });

  await check('the preload declares and implements the three new methods', () => {
    // THE METHOD NAMES AND THE CHANNEL NAMES DIFFER, exactly as they already
    // do for `add`/`crucible:add-server`, and for the same reason. Both sides
    // are checked because the skew is deliberate and a half-applied rename is
    // the failure it invites.
    for (const method of ['engineSettings:', 'writeEngineSettings:', 'testUpstream:']) {
      const count = PRELOAD.split(method).length - 1;
      assert.ok(count >= 2,
        `electron/preload.ts names ${method} ${count} time(s). It belongs to BOTH halves of that `
        + 'file: the type surface the renderer is typed against, and the implementation that '
        + 'invokes the channel.');
    }
    for (const channel of CHANNELS.slice(0, 3)) {
      assert.ok(PRELOAD.includes(`ipcRenderer.invoke('${channel}'`),
        `electron/preload.ts never invokes ${channel}`);
    }
  });

  await check('ElectronService.crucible carries the three methods through to the preload', () => {
    for (const method of ['engineSettings:', 'writeEngineSettings:', 'testUpstream:']) {
      assert.ok(FACADE.includes(method),
        `electron.service.ts has no ${method} — the renderer cannot reach the door.`);
    }
    for (const method of ['engineSettings(', 'writeEngineSettings(', 'testUpstream(']) {
      assert.ok(FACADE.includes(`electron.crucible.${method}`),
        `electron.service.ts declares a ${method} that calls nothing on the bridge.`);
    }
  });

  await check('the panel calls all three, and stores none of what they carry', () => {
    for (const method of ['crucible.engineSettings(', 'crucible.writeEngineSettings(',
      'crucible.testUpstream(']) {
      assert.ok(PANEL.includes(`electron.${method}`),
        `the AI panel never calls ${method}; a window that cannot write is not a window.`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. `crucible:capability` carries the SIXTH field
  // ───────────────────────────────────────────────────────────────────────────

  await check('the capability projection carries `route`, and reads it through the seam', () => {
    /*
     * The handler projects a row field by field. `route` (§3.3) is the field
     * the SDK's own parser DROPS, and the queue's `[cloud]` lane is decided on
     * it — so a projection that listed the other five would put the drop back
     * one layer up, and the lane would never appear with nothing saying why.
     */
    const start = MAIN.indexOf("ipcMain.handle('crucible:capability'");
    assert.ok(start > 0, 'crucible:capability is gone');
    const block = MAIN.slice(start, start + 1800);
    assert.ok(/route:\s*row\.route/.test(block),
      'the crucible:capability projection no longer carries `route`. Every other field survives '
      + 'the map and that one does not, which is the exact failure the seam exists to fix.');
    assert.ok(block.includes('crucibleCapabilityWithRoutes'),
      'crucible:capability reads through CrucibleClient.capability() again. That parser builds a '
      + 'row out of five named fields and discards `route` silently, so the projection above '
      + 'would be copying a field that is always undefined.');
  });

  await check('a capability document crossing the seam really has a route on every row', async () => {
    await withFake({ routes: { simplify: 'openai/gpt-x' }, upstreams: { openai: { key: 'sk-zzzz' } } },
      async ({ name }) => {
        const record = await seam.crucibleCapabilityWithRoutes(name);
        for (const row of record.classes) {
          assert.ok(row.route === 'local' || row.route === 'upstream',
            `${row.capability} came across as ${JSON.stringify(row.route)}`);
        }
        assert.strictEqual(record.classes.find((c) => c.capability === 'simplify').route, 'upstream');
      });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. The round trip: read, write a key AND a route in ONE patch, read back
  // ───────────────────────────────────────────────────────────────────────────

  await check('ONE patch configures the account and routes the class, and the key never appears', async () => {
    const KEY = 'sk-ant-window-secret-Q7x2';
    await withFake({}, async ({ name, door }) => {
      const before = await seam.crucibleEngineSettings(name);
      assert.strictEqual(before.upstreams.anthropic.configured, false);
      assert.strictEqual(before.routes.translate.route, 'local');

      // The wizard's one press, on the wire: `{upstreams, routes}` together.
      // §3.2 applies upstreams, then routes, then validates — which is what
      // makes this ONE request rather than a key saved and a route attempted.
      const after = await seam.putCrucibleEngineSettings(name, {
        upstreams: { anthropic: { key: KEY } },
        routes: { translate: 'anthropic/claude-window-1' },
      });
      assert.strictEqual(door.settings.puts.length, 1, 'the panel sent more than one write');
      assert.strictEqual(after.routes.translate.route, 'upstream');
      assert.strictEqual(after.routes.translate.model, 'anthropic/claude-window-1');
      assert.strictEqual(after.upstreams.anthropic.configured, true);

      // The answer is the WHOLE document, so a re-read must agree with it —
      // which is what lets the panel draw the PUT's answer instead of a guess.
      const reread = await seam.crucibleEngineSettings(name);
      assert.deepStrictEqual(reread, after);

      // THE HINT IS RENDERED VERBATIM, leading ellipsis and all (crucible
      // c5482ff). The words file is where a person's sentence is composed, and
      // it must interpolate the hint without adding or removing a character.
      assert.strictEqual(after.upstreams.anthropic.keyHint, '…Q7x2');
      const line = words.upstreamStateWords('anthropic', after.upstreams.anthropic);
      assert.ok(line.includes('…Q7x2'),
        `the state line dropped or rewrote the engine's hint: ${line}`);
      assert.ok(!line.includes('……'), `the state line added a second ellipsis: ${line}`);

      // AND THE KEY NEVER CROSSED BACK. The fake records every byte it served
      // and is perfectly capable of holding a key, which is what makes this an
      // assertion rather than a restatement of the fake's shape.
      assert.ok(!JSON.stringify(after).includes(KEY), 'the document handed up carries the key');
      for (const served of door.settings.served) {
        assert.ok(!served.includes(KEY), `the engine served the key back: ${served.slice(0, 90)}`);
      }
      assert.ok(!JSON.stringify(reread).includes(KEY), 'a re-read carries the key');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Test stores nothing
  // ───────────────────────────────────────────────────────────────────────────

  await check('Test sends what was typed and the engine is not configured by it', async () => {
    await withFake({}, async ({ name, door }) => {
      const got = await seam.testCrucibleUpstream(name, 'openai', { key: 'sk-typed-not-saved' });
      assert.strictEqual(got.ok, true);
      assert.deepStrictEqual(door.settings.tests[0], { name: 'openai', body: { key: 'sk-typed-not-saved' } });
      assert.strictEqual(door.settings.puts.length, 0, 'Test wrote something');
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.upstreams.openai.configured, false,
        'the tested key was stored — then Test-before-Save is a label, not an order of events');
      // The list is the ACCOUNT's own, which is the only cloud model list this
      // app has: §2 says the server ships none and neither does BookForge.
      assert.deepStrictEqual(got.models, ['model-a', 'model-b', 'model-c']);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. A refusal keeps its name AND the control it is about
  // ───────────────────────────────────────────────────────────────────────────

  await check('a refusal crosses as its CODE and its FIELD, never as a sentence to parse', async () => {
    await withFake({}, async ({ name }) => {
      let caught = null;
      try {
        await seam.putCrucibleEngineSettings(name, { routes: { clean: 'openai/gpt-x' } });
      } catch (err) { caught = err; }
      assert.ok(caught !== null, 'routing to an unconfigured account was allowed');
      assert.strictEqual(caught.code, 'route_upstream_unconfigured');

      // THE PROJECTION IS WHAT THE IPC DOORS SEND UP. `details` is the
      // server's object verbatim and typed `unknown`; this turns it into the
      // four fields a panel draws, and `field` is the dotted path that decides
      // WHICH CONTROL the sentence sits beside (§3.2).
      const refusal = seam.crucibleSettingsRefusalOf(caught);
      assert.strictEqual(refusal.code, 'route_upstream_unconfigured');
      assert.strictEqual(refusal.field, 'upstreams.openai.key');
      assert.strictEqual(refusal.classes, null, 'a field that was not sent must not be invented');
      assert.ok(refusal.message.includes('openai'), refusal.message);
    });
  });

  await check('`upstream_in_use` keeps the classes, so the fix is on the screen', async () => {
    await withFake({
      refusePut: () => ({
        status: 400,
        code: 'upstream_in_use',
        message: 'two classes still name anthropic',
        details: { field: 'upstreams.anthropic', classes: ['translate', 'simplify'] },
      }),
    }, async ({ name }) => {
      let caught = null;
      try {
        await seam.putCrucibleEngineSettings(name, { upstreams: { anthropic: null } });
      } catch (err) { caught = err; }
      const refusal = seam.crucibleSettingsRefusalOf(caught);
      assert.strictEqual(refusal.code, 'upstream_in_use');
      assert.strictEqual(refusal.field, 'upstreams.anthropic');
      assert.deepStrictEqual(refusal.classes, ['translate', 'simplify']);
    });
  });

  await check('a refusal with no field comes up with field null, not with a guessed one', async () => {
    await withFake({ noSettingsDoor: true }, async ({ name }) => {
      let caught = null;
      try { await seam.crucibleEngineSettings(name); } catch (err) { caught = err; }
      const refusal = seam.crucibleSettingsRefusalOf(caught);
      assert.strictEqual(refusal.code, 'settings_door_absent');
      assert.strictEqual(refusal.field, null,
        'a refusal about the whole door was given a control to sit beside. It has none, and the '
        + 'panel says it at the top — which is the truth about it, not a gap to fill.');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Five identical reasons, ONE line (§3.3 — "so an app shows it once")
  // ───────────────────────────────────────────────────────────────────────────

  await check('unavailableGroups collapses the five WSL-only classes into one entry', async () => {
    await withFake({ backendKind: 'llama-windows' }, async ({ name }) => {
      // A REAL DOCUMENT FROM A REAL SERVER, not a literal written here: the
      // collapse is only meaningful if the five sentences really are byte-for-
      // byte identical on the wire, and a hand-written fixture would be this
      // suite asserting its own typing.
      const record = await seam.crucibleCapabilityWithRoutes(name);
      const groups = words.unavailableGroups(record);
      const wsl = groups.filter((g) => g.reason === WSL_ONLY_REASON);
      assert.strictEqual(wsl.length, 1,
        `the five WSL-only classes produced ${wsl.length} groups sharing their one sentence. `
        + '§3.3 gives them that sentence precisely so a screen says it once; a screen saying it '
        + 'five times is what this grouping exists to prevent.');
      assert.deepStrictEqual(wsl[0].capabilities.slice().sort(), WSL_ONLY_CLASSES.slice().sort());
      // And each class appears in exactly one group — a collapse that
      // duplicated a class would say the news twice in different words.
      const seen = groups.flatMap((g) => g.capabilities);
      assert.strictEqual(seen.length, new Set(seen).size, 'a class landed in two groups');

      // And the panel's own line names them in a person's words, with no
      // button, because none of the five can be routed to an account at all
      // (§1: only the four text classes route upstream).
      const notice = words.unavailableNoticeWords(wsl[0].capabilities);
      assert.ok(notice.includes('narration') && notice.includes('noise removal'),
        `the notice still prints contract vocabulary at somebody: ${notice}`);
      assert.ok(!/\b(tts|asr|rvc|denoise)\b/.test(notice), notice);
    });
  });

  await check('a class that is off for its OWN reason is its own group, with the offer', async () => {
    // A group of one is the honest shape and needs no branch at the call site.
    await withFake({ localModelFor: () => null }, async ({ name }) => {
      const record = await seam.crucibleCapabilityWithRoutes(name);
      const groups = words.unavailableGroups(record);
      const textGroup = groups.find((g) => g.capabilities.includes('translate'));
      assert.ok(textGroup !== undefined, 'a class with nothing that fits is not reported at all');
      const offer = words.unavailableOfferWords(['translate']);
      assert.ok(offer.includes('translating'), offer);
      for (const vendor of ['Anthropic', 'OpenAI', 'an Ollama server']) {
        assert.ok(offer.includes(vendor), `the offer does not name ${vendor}: ${offer}`);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. The RENDERER HALF — a source pin, for the reason in this file's header
  // ───────────────────────────────────────────────────────────────────────────

  await check('SOURCE PIN: the key box is bound to a draft that every draw clears', () => {
    assert.ok(/\[value\]="draftFor\(/.test(PANEL),
      'the credential input is no longer bound to the draft signal. §5.2: "A key field is empty '
      + 'on every draw (write-only) with the hint beside it" — a box bound to anything else '
      + 'could be bound to something that survives a draw.');
    const draw = /private redrawEngineSettings\([\s\S]*?\n  \}/.exec(PANEL);
    assert.ok(draw !== null, 'redrawEngineSettings is gone — it is the ONE function that puts a '
      + 'document on the screen, which is what makes the empty-key property structural.');
    assert.ok(/this\.upstreamDrafts\.set\(\{\}\)/.test(draw[0]),
      'the draw function no longer clears the credential drafts. A key would then survive a '
      + 'successful Save, a refusal, a re-read and a change of server.');
    assert.ok(/this\.redrawEngineSettings\(null\)/.test(PANEL),
      'changing the server no longer drops the document — a key typed for one engine would sit '
      + 'in a field pointed at a different one.');
  });

  await check('SOURCE PIN: no key reaches settings.service.ts, and nothing is saved app-side', () => {
    /*
     * §5.2: *"There is no Save button that writes an app file and syncs
     * later."* The panel keeps an AI provider choice in `SettingsService` and
     * always has (`updateAIConfig`), and that is a server NAME and a model id
     * — never a credential. This check is that the two never meet: no
     * `updateAIConfig` call in this file mentions a draft, a key or an
     * upstream.
     */
    // Comments are stripped, for the reason `test-no-e2a-doors.js` gives: the
    // history of the deleted key store is written down on purpose, and a test
    // that failed on its own explanation would teach people to delete
    // explanations.
    const code = PANEL
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
    const calls = code.match(/this\.settings\.update[A-Za-z]*\([^;]*\)/g) || [];
    assert.ok(calls.length > 0, 'the panel writes nothing to settings at all now — read this '
      + 'check before deleting it; it assumes the provider choice still lives there.');
    for (const call of calls) {
      assert.ok(!/draft|[Kk]ey|upstream|route/i.test(call),
        `a settings write mentions a credential or a route: ${call}`);
    }
    assert.ok(!/localStorage/.test(code), 'the panel reached for localStorage');
    // The engine's document has no home on this side: one signal, replaced on
    // every read, and nothing that persists it.
    assert.ok(/readonly engineSettings = signal<CrucibleEngineSettings \| null>\(null\)/.test(PANEL),
      'the engine document is no longer a plain signal — check what it became before trusting '
      + 'that the app still holds nothing.');
  });

  await check('SOURCE PIN: Test comes before Save, in the template as in the act', () => {
    const card = PANEL.indexOf('Accounts this engine can send work to');
    assert.ok(card > 0, 'the accounts block is gone');
    const test = PANEL.indexOf('(click)="testUpstreamAccount(name)"', card);
    const save = PANEL.indexOf('(click)="saveUpstream(name)"', card);
    assert.ok(test > 0 && save > 0, 'the Test and Save buttons are not both there');
    assert.ok(test < save,
      'Save is drawn before Test. Test-before-Save is an order of operations — Test sends the '
      + 'typed value WITHOUT storing it, so a person who presses left-to-right finds out whether '
      + 'a key works before the engine keeps it — and a screen that offers them the other way '
      + 'round teaches the wrong order.');
  });

  await check('SOURCE PIN: a refusal is drawn beside the control its `field` names', () => {
    assert.ok(/refusalFor\('routes\.' \+ act\)/.test(PANEL),
      'the route rows no longer show their own refusal. The dotted path exists so a no about '
      + '`routes.translate` appears under the translate row rather than at the top of a page '
      + 'with eight controls on it.');
    assert.ok(/refusalForUpstream\(name\)/.test(PANEL),
      'the account cards no longer show their own refusal.');
    assert.ok(/panelRefusal\(\)/.test(PANEL),
      'a refusal that names NO field has nowhere to go. It goes to the top, and that is a real '
      + 'case: settings_door_absent and settings_unreachable are about the door.');
  });

  await check('SOURCE PIN: the wizard step adds the offer, and both hosts draw the same panel', () => {
    const firstRun = read('src', 'app', 'features', 'first-run-setup', 'first-run-setup.component.ts');
    const settingsPage = read('src', 'app', 'features', 'settings', 'settings.component.ts');
    assert.ok(/<app-ai-setup-wizard \[embedded\]="true" \[wizard\]="true" \/>/.test(firstRun),
      'the first-run AI step no longer asks for the wizard face. §5.2 gives the wizard one extra '
      + 'thing — the reason a class is off and the offer to route it — and nothing else.');
    assert.ok(/<app-ai-setup-wizard \[embedded\]="true" \/>/.test(settingsPage),
      'Settings no longer mounts the same component. One component in both places is what §5.2 '
      + 'asks for; two would be two screens teaching two things about one document.');
    assert.ok(/readonly wizard = input\(false\)/.test(PANEL),
      'the wizard input is gone, so the two hosts cannot differ at all (or differ by something '
      + 'else — read it before deleting this check).');
    assert.ok(/@if \(wizard\(\)\) \{/.test(PANEL), 'the offer block is not gated on the wizard face');
    assert.ok(/unavailableGroups\(/.test(PANEL) || /unavailableOffers\(\)/.test(PANEL),
      'the offer block no longer groups by reason — it would say the WSL sentence five times.');
  });

  await check('SOURCE PIN: the one press tests first, then writes ONE patch with both halves', () => {
    const press = /async connectAndRoute\([\s\S]*?\n  \}/.exec(PANEL);
    assert.ok(press !== null, 'the one-press offer is gone (§5.2: "entering a key calls test, '
      + 'then one PUT that configures the upstream AND sets the route")');
    const body = press[0];
    const test = body.indexOf('testUpstream(');
    const write = body.indexOf('writeEngineSettings(');
    assert.ok(test > 0, 'the press no longer tests the key before storing it');
    assert.ok(write > test,
      'the press writes before it tests. A key the account rejects would then be stored and '
      + 'complained about afterwards.');
    assert.ok(/patch\.upstreams = /.test(body) && /routes: \{ \[act\]:/.test(body),
      'the press no longer sends the account and the route in ONE patch. Two writes leave a '
      + 'window with the key stored and the route not, which §3.2 exists to close.');
    assert.ok(/models\[0\]/.test(body) === false,
      'the press picks a model out of the account\'s list. That is this app choosing a model '
      + 'again — the second opinion the capability record exists to end. With no model named it '
      + 'says so and writes nothing.');
  });

  await check('SOURCE PIN: no vendor is named in the panel, and no cloud model list is shipped', () => {
    // The three names are the CONTRACT's vocabulary and live in the wire and
    // the words file (`tools/test-no-cloud-doors.js` allowlists exactly those).
    // A panel that spelled one would be branching on a vendor again.
    const bare = PANEL
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
    assert.ok(!/'(anthropic|openai|ollama)'/.test(bare),
      'the AI panel names an upstream as a value. It iterates CRUCIBLE_UPSTREAM_NAMES, and the '
      + 'words for them live in crucible-words.ts.');
    assert.ok(/CRUCIBLE_UPSTREAM_NAMES/.test(PANEL), 'the panel no longer reads the contract\'s list');
    assert.ok(/testedModels/.test(PANEL),
      'the only model ids this panel can offer come from a Test of the operator\'s own account '
      + '(§2: the server ships no cloud model list, and neither does this app).');
  });

  summary('crucible settings window');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
