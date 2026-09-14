#!/usr/bin/env node
/**
 * BOOKFORGE HAS NO ENHANCE TAB, AND NO RESEMBLE ENHANCE AT ALL.
 *
 *   node tools/test-no-enhance-doors.js
 *
 * Owen, 2026-09-14 (`docs/EXTENSION-TO-CRUCIBLE-PLAN.md` §3): *"drop and remove
 * the enhance page and the corresponding crucible route. it's unnecessary."*
 *
 * So Resemble Enhance did not become a Crucible job type and did not stay a
 * local env — it LEFT. The page, its route and rail entry, `enhance-bridge.ts`,
 * `components/resemble-env.ts`, the `enhance:*` IPC channels, the `enhance.*`
 * block in `tool-paths.ts` and the three python scripts only that bridge ran
 * are gone, and no `enhance` job type is ever built on the server side either.
 *
 * ── WHY A GREP IS THE RIGHT TEST HERE ──────────────────────────────────────
 *
 * Written in the shape of `test-no-e2a-doors.js` and `test-no-cloud-doors.js`,
 * for their reason: a deletion this size comes back one helper at a time.
 * Somebody wants a one-file audio cleaner, writes `enhanceFile()`, and a year
 * later the app has a second speech engine, a fourth conda env to publish and
 * a page nobody ruled on. Every door is therefore pinned BY NAME, so its
 * return is a red test naming the thing rather than a review nobody ran.
 *
 * ── AND ONE HALF OF THIS FILE IS NOT ABOUT ABSENCE ─────────────────────────
 *
 * "Enhance" means THREE unrelated things in this codebase and only one of them
 * was the tab. A future cleanup that greps the word and deletes what it finds
 * would take out the hiss separator and the RVC pass with it. So the second
 * half asserts those are still HERE: `denoise` with its four consumers, and
 * RVC voice enhancement end to end. A test that only forbids is a test that
 * invites the wrong fix.
 */
'use strict';
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
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/**
 * Every TS source under `electron/`, `shared/` and `src/`, with comments
 * stripped.
 *
 * Comments go for the reason the other two doors-tests give: the history is
 * written down on purpose — several files explain what the deleted thing DID —
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
function hits(needle) {
  return FILES.filter((f) => f.code.includes(needle)).map((f) => f.file);
}

function exists(rel) {
  return fs.existsSync(path.join(REPO, rel.split('/').join(path.sep)));
}

console.log('BookForge has no Enhance tab');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The files that WERE the tab
// ─────────────────────────────────────────────────────────────────────────────

const DELETED_FILES = {
  'electron/enhance-bridge.ts':
    'the bridge itself — decode → separate → denoise → enhance, per file, with its own '
    + 'cache, its own session list and its own WSL launch mode.',
  'electron/components/resemble-env.ts':
    'the 3.47 GB managed conda env the bridge resolved. It is not published as a component '
    + 'any more; the release asset is history, not a door.',
  'electron/scripts/enhance_cli.py':
    'the Resemble Enhance CLI the bridge spawned.',
  'electron/scripts/enhance_spectral_blend.py':
    'the magnitude-interpolation blend between the raw and enhanced voice.',
  'electron/scripts/install_deepspeed_stub.py':
    'the deepspeed import stub that existed only so resemble-enhance would load.',
  'src/app/features/enhance/enhance.component.ts':
    'the page.',
  'AUDIO_ENHANCEMENT.md':
    'its setup document.',
};

for (const [file, what] of Object.entries(DELETED_FILES)) {
  check(`${file} is gone`, () => {
    assert.ok(!exists(file),
      `${file} is back. It was ${what}\n`
      + 'Owen dropped Resemble Enhance on 2026-09-14; whatever this is for, it is not that.');
  });
}

check('src/app/features/enhance/ holds nothing at all', () => {
  assert.ok(!exists('src/app/features/enhance'),
    'src/app/features/enhance/ exists again. The feature folder went with the page — a '
    + 'stylesheet or a service left behind there is the page coming back one file at a time.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The IPC seam
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Thirteen channels crossed it. They are listed one by one rather than matched
 * with a prefix regex so that a reader can see the size of what left, and so a
 * single one coming back names itself.
 */
const DELETED_CHANNELS = [
  'enhance:pick-files', 'enhance:pick-export-path', 'enhance:readiness',
  'enhance:probe-file', 'enhance:get-cache', 'enhance:set-overrides',
  'enhance:process', 'enhance:stop', 'enhance:clear-cache',
  'enhance:clear-cache-by-key', 'enhance:list-sessions', 'enhance:list-active',
  'enhance:export', 'enhance:progress',
];

check(`no enhance:* IPC channel is wired (${DELETED_CHANNELS.length} checked)`, () => {
  const back = [];
  for (const channel of DELETED_CHANNELS) {
    const where = hits(channel);
    if (where.length > 0) back.push(`${channel} (${where.join(', ')})`);
  }
  assert.strictEqual(back.length, 0, `these channels are back: ${back.join('; ')}`);
});

check('no channel named enhance: exists under any spelling', () => {
  /*
   * The list above is what WAS there. This catches a fourteenth — a new verb on
   * the same namespace, which is the shape the tab would come back in.
   */
  const offenders = FILES
    .filter((f) => /['"`]enhance:[a-z-]+['"`]/.test(f.code))
    .map((f) => f.file);
  assert.strictEqual(offenders.length, 0,
    `the enhance: IPC namespace is in use again in: ${offenders.join(', ')}. `
    + 'RVC voice enhancement has its own channels (rvc:start-enhancement, '
    + 'rvc:stop-enhancement) and the denoise pass runs as a queue job — neither needs this.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Every deleted symbol and module reference, by name
// ─────────────────────────────────────────────────────────────────────────────

const DELETED = {
  'the bridge, as an import target': [
    'enhance-bridge', 'enhanceReadiness', 'probeEnhanceInput', 'getEnhanceCacheEntry',
    'setEnhanceOverrides', 'runEnhanceProcessing', 'stopEnhanceProcessing',
    'clearEnhanceCache', 'clearEnhanceCacheByKey', 'listEnhanceSessions',
    'listActiveEnhanceJobs', 'exportEnhanceMix',
  ],
  'the Resemble env component': [
    'resemble-env', 'resembleEnvComponent', 'RESEMBLE_ENV_ID', 'resemble_enhance',
    'resemble-enhance',
  ],
  'the tool-paths config block': [
    'EnhanceConfig', 'getEnhanceConfig', 'EnhanceLaunchMode', 'EnhanceParams',
    'EnhanceParamValue',
  ],
  'the wire types the renderer mirrored': [
    'EnhanceCacheEntry', 'EnhanceProcessConfig', 'EnhanceProcessParams',
    'EnhanceOverridesPatch', 'EnhanceExportConfig', 'EnhanceProgress', 'EnhanceSession',
    'ActiveEnhanceJob', 'EnhanceStems', 'EnhanceStemAvailability', 'EnhanceMethod',
    'RvcEnhanceSettings', 'ReprocessScope',
  ],
  'the renderer service methods': [
    'enhanceAudioUrl', 'enhancePickFiles', 'enhancePickExportPath', 'enhanceProbeFile',
    'enhanceGetCache', 'enhanceSetOverrides', 'enhanceProcess', 'enhanceListSessions',
    'enhanceListActive', 'enhanceClearCache', 'enhanceClearCacheByKey', 'enhanceStop',
    'enhanceExport', 'onEnhanceProgress', 'EnhanceComponent',
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
      + 'Resemble Enhance is not in this application. If a one-file audio cleaner is wanted '
      + 'again, it is a Crucible job type and a ruling, not a bridge and a 3.47 GB env.');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The page has no way in
// ─────────────────────────────────────────────────────────────────────────────

check('there is no /enhance route', () => {
  const routes = FILES.find((f) => f.file === 'src/app/app.routes.ts');
  assert.ok(routes !== undefined, 'src/app/app.routes.ts is gone');
  assert.ok(!/path:\s*'enhance'/.test(routes.code),
    "src/app/app.routes.ts declares path: 'enhance' again. The page it lazy-loaded does "
    + 'not exist, so this route can only be a new one.');
});

check('the nav rail has no Enhance entry', () => {
  const shell = FILES.find((f) => f.file === 'src/app/app.ts');
  assert.ok(shell !== undefined, 'src/app/app.ts is gone');
  assert.ok(!/route:\s*'\/enhance'/.test(shell.code),
    "src/app/app.ts routes a rail item at '/enhance' again.");
  assert.ok(!/id:\s*'enhance'/.test(shell.code),
    "src/app/app.ts has a nav item with id 'enhance' again.");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WHAT STAYS — denoise is a different thing, and it has four consumers
// ─────────────────────────────────────────────────────────────────────────────

/*
 * `denoise` is the HISS SEPARATOR, and it was never the Enhance tab's alone.
 * The ruling says so in as many words. Its removal by a future grep-and-delete
 * pass would be silent — narration would simply stop being cleaned — so its
 * presence is asserted here, next to the deletion that could take it.
 */
const DENOISE_KEPT = {
  'electron/crucible/denoise.ts': 'the job, through Crucible',
  'electron/denoise-bridge.ts': 'the local separator spawn',
  'electron/denoise-job.ts': 'the queue row',
  'electron/chapter-closer.ts': 'consumer',
  'electron/clipforge-chain.ts': 'consumer (roformer_denoise)',
  'electron/coverage-align-job.ts': 'consumer',
};

for (const [file, role] of Object.entries(DENOISE_KEPT)) {
  check(`${file} is still here — ${role}`, () => {
    assert.ok(exists(file),
      `${file} is gone. denoise is the hiss separator, NOT the Enhance tab: the plan's own `
      + 'Enhance row says "the `denoise` job type and subject STAY". If it was deleted as '
      + 'part of an Enhance cleanup, that cleanup went too far.');
  });
}

check('the denoise job type is still spelled on the Crucible seam', () => {
  const where = hits("'denoise'");
  assert.ok(where.length > 0,
    "no source names the 'denoise' job type any more. Crucible still offers it and four "
    + 'call sites still need it.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WHAT STAYS — RVC voice enhancement is the other thing the word means
// ─────────────────────────────────────────────────────────────────────────────

const RVC_KEPT = {
  'electron/rvc-bridge.ts': 'the convert spawn',
  'electron/rvc-job.ts': 'the queue row',
  'electron/components/rvc-env.ts': 'the env (which also carries audio-separator for denoise)',
  'electron/components/cuda-rvc.ts': 'the GPU overlay',
  'electron/components/rvc-voice-components.ts': 'the downloadable voices',
  'electron/crucible/rvc.ts': 'the job, through Crucible',
};

for (const [file, role] of Object.entries(RVC_KEPT)) {
  check(`${file} is still here — ${role}`, () => {
    assert.ok(exists(file),
      `${file} is gone. "RVC enhancement" shares a word with the Enhance tab and nothing `
      + 'else: it is the post-narration voice conversion, it has its own settings, its own '
      + 'queue step kind and its own Crucible job.');
  });
}

check("the rvc-enhancement step kind is still in the queue's vocabulary", () => {
  const where = hits("'rvc-enhancement'");
  assert.ok(where.length >= 2,
    "'rvc-enhancement' is named in fewer than two sources. It is a queue step kind with "
    + `words and timings of its own; found in: ${where.join(', ') || 'nothing'}.`);
});

check('the rvcEnhancement* settings survive', () => {
  for (const setting of ['rvcEnhancementEnabled', 'rvcEnhancementVoiceId']) {
    assert.ok(hits(setting).length > 0,
      `${setting} is gone. The narration defaults own it, and it has nothing to do with `
      + 'Resemble Enhance.');
  }
});

check("the narration modal still has its own 'enhance' tab, which is the two GPU passes", () => {
  const modal = FILES.find((f) =>
    f.file === 'src/app/features/studio/components/narration-modal/narration-modal.component.ts');
  assert.ok(modal !== undefined, 'the narration modal is gone');
  assert.ok(/NarrationTab\s*=\s*'tts' \| 'assembly' \| 'enhance'/.test(modal.code),
    "the narration modal's tab union no longer carries 'enhance'. That tab is where the "
    + 'user puts denoise and the RVC pass in an order — a third meaning of the word, and '
    + 'not the deleted page.');
});

console.log(`\nno Enhance doors: ${failures === 0 ? 'all clear' : `${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
