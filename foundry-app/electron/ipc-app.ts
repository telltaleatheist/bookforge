/**
 * ipc-app — the engine's identity and settings, the shell, and first run.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import * as path from 'node:path';
import { ipcMain, shell } from 'electron';
import { engineInfo, runDoctor } from '@owen/foundry-core/node/engine';
import { setupState } from '@owen/foundry-core/node/setup';
import { probeSystem } from '@owen/foundry-core/node/system-probe';
import { readSettings } from '@owen/foundry-core/node/settings';
import { writeSettingsOutsideHost, finishSetupFor } from '@owen/foundry-core/node/doors-library';
import type { BackendSettingsPatch } from '@owen/foundry-core/shared/types';

export function registerAppDoors(): void {
  ipcMain.handle('engine:info', () => engineInfo());
  ipcMain.handle('doctor:run', (_event, endpointUrl?: string) => runDoctor(endpointUrl));

  ipcMain.handle('settings:read', () => readSettings());
  /*
   * ── THE ENGINE'S SETTINGS ARE NOT OURS TO WRITE INSIDE A HOST ─────────────
   *
   * `settings.json` is the ENGINE's, machine-global, and hosted the host runs
   * that same engine with that same file (docs/BOOKFORGE-HANDOFF.md). A person
   * changing the mode or the endpoint on this screen inside BookForge would be
   * reconfiguring the host's own conversions from a window that does not own
   * them. The form is hidden there, and this is the door behind it: something
   * reachable by an IPC message must refuse at the door as well, or the hiding
   * is a decoration (`refuseHostedRegistryChange`'s rule, crucible-registry.ts).
   *
   * Found by BookForge's audit, 2026-09-14, unguarded on both sides.
   */
  ipcMain.handle('settings:write', (_event, patch: BackendSettingsPatch) => writeSettingsOutsideHost(patch));

  ipcMain.handle('shell:reveal', (_event, target: string) => {
    shell.showItemInFolder(path.resolve(target));
  });

  /*
   * ── WHAT USED TO BE HERE: `wsl:*` AND `backend:setup-*` ───────────────────
   *
   * Four doors that listed WSL distros, asked one of them what it could build
   * with, and ran a conda/venv build of vLLM inside it while streaming the
   * guest's output over `backend:setup-log`. All four went on 2026-09-13 with
   * the launcher they fed (docs/SLOTS.md §6, package B). This app does not
   * build a vLLM, does not start one, and does not ask about WSL. The local
   * page reader below is what reads pages on this machine now, and a vLLM
   * somebody else runs is reached the way every other server is: by its URL.
   */

  /*
   * ── THE PREBUILT ENVIRONMENTS ARE GONE, AND WITH THEM FIVE DOORS ─────────
   *
   * `env:catalog`, `env:install`, `env:cancel`, `env:choose-dest` and the
   * `env:install-progress` push. They downloaded and installed the Python the
   * rasteriser and the MLX reader ran in; both are gone (2026-11-04: the pages
   * render in-process on MuPDF and every model call goes to Crucible), so there
   * is nothing to install. Folders an earlier version downloaded are left on
   * disk (`retireSettingsKeys`, node/settings.ts, says where).
   */

  /*
   * ── THE LOCAL PAGE READER IS GONE, AND WITH IT EIGHT DOORS ─────────────
   *
   * `page-reader:state`, `:install`, `:install-cancel`, `:start`, `:stop`,
   * `:set-keep-warm`, and the `:progress` / `:status-changed` pushes.
   *
   * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
   * there sohuldnt be a local system. foundry does all ai work through
   * crucible."* Reading a page wants a GPU, so it belongs to an engine. The
   * settings card went first, then the queue's fallback, then the gate that
   * lit the OCR tile with no engine, then the first-run step that sold the
   * download -- this is the machinery all four stood on.
   *
   * `models:inventory` and `models:remove-page-reader` went with them for a
   * smaller reason: they served the "Models on this machine" card, which Owen
   * deleted as unnecessary, and nothing else ever called either one.
   */

  // ── First run ────────────────────────────────────────────────────────────
  /*
   * THE WIZARD'S DOORS. Every one of them is also reachable from the settings
   * screen, which is the whole design: setup is the first-run ARRANGEMENT of
   * questions the app can already answer, not a separate mechanism. Nothing
   * below is exclusive to it.
   *
   * `system:probe` takes a force flag because the one case where the hardware
   * answer goes stale inside a process is somebody installing a GPU driver and
   * pressing Check again — see the cache argument in system-probe.ts.
   */
  ipcMain.handle('setup:state', () => setupState());
  ipcMain.handle('setup:finish', (_event, skipped: string[], prepare?: boolean) =>
    finishSetupFor(skipped, prepare));

  ipcMain.handle('system:probe', (_event, force?: boolean) => probeSystem(force === true));
}
