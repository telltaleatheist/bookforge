/**
 * WHERE THE QWEN3 FORCED ALIGNER LIVES ON THIS MACHINE — one resolver, for both
 * alignment doors.
 *
 * Owen, 2026-09-08 (via the Mac): *"good. go ahead and wire it up to alignment so
 * itll be used to align the chunks in app"* … *"for generate-sentences logic and
 * for normal post-render alignment"*. Two doors, therefore, and they must find
 * the same environment or a machine that can do one will mysteriously not do the
 * other — the same argument `whisperx-align-bridge.ts:resolveWhisperxEnvRoot()`
 * makes for its own pair, and the reason this is a function rather than a ladder
 * spelled twice:
 *
 *   * `coverage-align-job.ts` — `narrator align --backend qwen3`, the per-chunk
 *     coverage pass, run as the tail of the TTS step and as the standalone Align
 *     row / `bookforge-tts --align`;
 *   * `whisperx-align-bridge.ts` — `align_audiobook.py --backend qwen3`, the
 *     whole-m4b "Generate sentences" alignment.
 *
 * ── The env is a different KIND of thing per platform ───────────────────────
 *
 * darwin  a NATIVE conda prefix. `electron/components/qwen-align-env.ts` is a
 *         managed conda-pack component (`qwen-align-env`, landed ac36c1b6), so
 *         the ordinary answer is "wherever the component manager installed it",
 *         and the component's OWN `detect` block — `namedCondaEnvCandidates`
 *         plus `QWEN_ALIGN_ENV_PATH` — covers a hand-built one. That block is
 *         READ from the component rather than restated here: a second copy of a
 *         candidate list is a second answer, and the copy is the one that goes
 *         stale.
 * win32   a WSL conda env NAME. `qwen-asr` wants a CUDA torch env; the PC's is
 *         the guest env `qwen-align`, which no Windows-side managed install can
 *         lay down and no Windows path can name. So the setting carries the NAME
 *         and the prefix is derived with `wslCondaEnvPrefix`.
 * linux   the setting, or nothing. There is no component for linux and no
 *         convention to guess from.
 *
 * ── IT REFUSES BY NAME AND NEVER PICKS A DIFFERENT ALIGNER ──────────────────
 *
 * There is no whisperx fallback anywhere behind this function. The app's doors
 * are qwen3 now; a machine with no qwen env is a machine that does not align, and
 * it is TOLD SO with the setting to fill in. Quietly running whisperx instead
 * would ship a book measured by a different instrument under the same label —
 * and the two do not even have the same score scale (`align/aligner.py`,
 * `score_source`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { QWEN_ALIGN_ENV_ID, qwenAlignEnvComponent } from './components/qwen-align-env';
import { componentManager } from './components/component-manager';
import {
  getQwenAlignEnvSetting,
  getWslCondaPath,
  wslCondaEnvPrefix,
} from './tool-paths';

/**
 * A resolved aligner environment.
 *
 * `python` is what goes on `narrator align --python` / `align_audiobook.py
 * --align-python`. `viaWsl` is what decides whether the SPAWN has to cross into
 * the guest: on Windows the interpreter is a `/home/...` path that only exists
 * inside WSL, so a native Windows spawn cannot run it and the caller has to know.
 * `wslEnvName` is the conda env the guest-side narrator parent is started in.
 */
interface QwenAlignEnvBase {
  /** The env PREFIX. A Windows caller must not hand this to a native spawn. */
  prefix: string;
  /** `<prefix>/bin/python`. POSIX on both arms — the mac env and the guest env. */
  python: string;
  /** How this answer was reached, for the job log. */
  source: 'setting' | 'component' | 'candidate' | 'env-var';
}

/**
 * A DISCRIMINATED union on `viaWsl`, not a boolean plus an optional name: the
 * guest env name is REQUIRED whenever the spawn crosses, and a shape that let it
 * be undefined there would compile into a native spawn of a `/home/...` path.
 */
export type QwenAlignEnv =
  | (QwenAlignEnvBase & { viaWsl: false })
  | (QwenAlignEnvBase & { viaWsl: true; wslEnvName: string });

export type QwenAlignResolution =
  | { ok: true; env: QwenAlignEnv }
  | { ok: false; error: string };

/**
 * `HF_HOME` for every qwen3 alignment — BookForge's managed Hugging Face cache.
 *
 * `Qwen3ForcedAligner.from_pretrained` pulls ~1.2 GB of weights on first use, the
 * same arrangement whisperx has for its ~378 MB wav2vec2 checkpoint under a
 * managed `TORCH_HOME`. HF_HOME rather than HF_HUB_CACHE because it is the
 * umbrella variable: one setting covers the hub cache and everything else
 * `huggingface_hub` writes, where HF_HUB_CACHE relocates only the hub subtree and
 * leaves the rest in `~/.cache/huggingface` (the reasoning is
 * `components/qwen-align-env.ts`'s, which DECLARES the variable and sets nothing —
 * the doors are where it is set).
 *
 * IT IS CREATED, NOT ASSUMED, by the door that spawns. On the WSL arm the guest
 * reaches it as `/mnt/c/...`, where `huggingface_hub` cannot create its blob
 * symlinks and copies the files instead — slower on the one download, correct
 * afterwards, and the alternative (a second cache inside the guest) would have
 * BookForge managing one copy of the weights and not the other.
 */
export function qwenAlignCacheDir(userDataDir: string): string {
  return path.join(userDataDir, 'runtime', 'qwen-align-cache');
}

/** `<prefix>/bin/python` — POSIX on both arms this function can produce. */
function posixPython(prefix: string): string {
  return `${prefix.replace(/\\/g, '/').replace(/\/$/, '')}/bin/python`;
}

/**
 * THE ONE REFUSAL, said once so every door says the same thing.
 *
 * Exported because the CLI's plan-time check (`cli/coverage-align.js`) and the
 * job itself both have to say it, and the app has always stated this refusal
 * twice — once when a row is composed, once when it runs, because a row outlives
 * the machine state that composed it. Twice is fine; two DIFFERENT sentences
 * would not be.
 */
export function qwenAlignRefusal(): string {
  if (os.platform() === 'win32') {
    return (
      'No qwen-align WSL env is named in tool-paths ("qwenAlignEnv"), so nothing on this '
      + 'machine can force-align the chunks. install_qwen_align.sh is not written yet — build '
      + 'the guest env by hand (`pip install qwen-asr soundfile` into a CUDA torch conda env '
      + 'inside WSL) and name it in Settings → Add-ons under "Qwen3 aligner WSL env". '
      + 'BookForge will not pick an interpreter for you and will not quietly align with '
      + 'WhisperX instead: the two do not score words on the same scale.'
    );
  }
  if (os.platform() === 'darwin') {
    return (
      'The "Qwen3 forced aligner (Apple Silicon)" add-on is not installed and no qwen-align '
      + 'conda env was found, so nothing on this machine can force-align the chunks. Install it '
      + 'from Settings → Add-ons, or point "qwenAlignEnv" in tool-paths.json at the conda '
      + 'PREFIX of an env that has qwen-asr.'
    );
  }
  return (
    'No qwen-align environment is configured on this machine, so nothing can force-align the '
    + 'chunks. There is no managed component for this platform: `pip install qwen-asr soundfile` '
    + 'into a CUDA torch conda env and point "qwenAlignEnv" in tool-paths.json at its prefix.'
  );
}

/**
 * The qwen3 aligner env for this machine, or the refusal naming what is missing.
 *
 * Order, and every step is a STATED answer rather than a scan:
 *   1. the `qwenAlignEnv` setting — an env NAME in the guest on Windows, an
 *      absolute conda prefix everywhere else;
 *   2. darwin only: the installed `qwen-align-env` component, then the candidate
 *      list and the env var that component itself declares;
 *   3. a refusal.
 *
 * A candidate is only accepted when its `bin/python` is actually on disk — the
 * same rule `resolveWhisperxEnvRoot` applies — because an env directory that
 * exists and has no interpreter fails later, in a spawn, as ENOENT.
 */
export function resolveQwenAlignEnv(): QwenAlignResolution {
  const stated = getQwenAlignEnvSetting();
  const platform = os.platform();

  if (platform === 'win32') {
    if (!stated) return { ok: false, error: qwenAlignRefusal() };
    const prefix = wslCondaEnvPrefix(getWslCondaPath(), stated);
    // NOT checked on disk. It is a guest path: `fs.existsSync` would have to go
    // through the \\wsl$ 9p mount, which is absent when the VM is down and slow
    // when it is not — and a wrong name fails in the spawn with conda's own
    // "env not found", naming the env. The setting is the operator's statement.
    return {
      ok: true,
      env: { prefix, python: `${prefix}/bin/python`, viaWsl: true,
             wslEnvName: stated, source: 'setting' },
    };
  }

  if (stated) {
    const python = posixPython(stated);
    if (!fs.existsSync(python)) {
      return {
        ok: false,
        error:
          `tool-paths.json names "qwenAlignEnv": ${stated}, but there is no interpreter at `
          + `${python}. On this platform the setting is the conda PREFIX of the env that holds `
          + 'qwen-asr, not an env name.',
      };
    }
    return { ok: true, env: { prefix: stated, python, viaWsl: false, source: 'setting' } };
  }

  if (platform === 'darwin') {
    const managed = componentManager.resolveEntry(QWEN_ALIGN_ENV_ID);
    if (managed && fs.existsSync(posixPython(managed))) {
      return {
        ok: true,
        env: { prefix: managed, python: posixPython(managed), viaWsl: false,
               source: 'component' },
      };
    }
    // The component's OWN detect block, read rather than restated — see the
    // header. `candidates` is `namedCondaEnvCandidates('qwen-align')` and
    // `envVar` is `QWEN_ALIGN_ENV_PATH`; both belong to that component and
    // changing them there has to change this. It is REQUIRED rather than
    // optional-with-a-default: the whole point of reading it is that this
    // function has no candidate list of its own, so a component that stopped
    // declaring one must say so instead of silently detecting nothing.
    const detect = qwenAlignEnvComponent().detect;
    if (!detect || !detect.candidates) {
      return {
        ok: false,
        error:
          `The ${QWEN_ALIGN_ENV_ID} component declares no detect candidates, so there is no `
          + 'candidate list to look for a hand-built qwen-align env in. Install the add-on '
          + 'from Settings → Add-ons, or name the env prefix as "qwenAlignEnv" in '
          + 'tool-paths.json.',
      };
    }
    for (const candidate of detect.candidates) {
      if (candidate.platform !== platform) continue;
      if (!fs.existsSync(posixPython(candidate.path))) continue;
      return {
        ok: true,
        env: { prefix: candidate.path, python: posixPython(candidate.path),
               viaWsl: false, source: 'candidate' },
      };
    }
    const pointedRaw = detect.envVar === undefined ? undefined : process.env[detect.envVar];
    const pointed = pointedRaw === undefined ? '' : pointedRaw.trim();
    if (pointed && fs.existsSync(posixPython(pointed))) {
      return {
        ok: true,
        env: { prefix: pointed, python: posixPython(pointed), viaWsl: false,
               source: 'env-var' },
      };
    }
  }

  return { ok: false, error: qwenAlignRefusal() };
}
