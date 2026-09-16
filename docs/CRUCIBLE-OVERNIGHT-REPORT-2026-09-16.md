# Crucible integration cleanup — September 16, 2026

The audit found real integration and installation defects and corrected them across
BookForge, Crucible, and Foundry. The intended product shape is preserved: install
Crucible on Windows, use its native engine immediately, and optionally let Crucible
guide and own a later move to WSL. Applications connect to an engine through the
shared SDK instead of guessing its runtime paths or controlling a WSL distribution.

## Committed and pushed

All implementation changes were pushed normally to `origin/main`, without force.

| Repository | Implementation commit |
|---|---|
| Crucible | `ad059f00cae259209b2ef59b0590df2c4435c60d` |
| Foundry | `3938e31215567954c699d692196e9364e89f3253` |
| BookForge | `3ffbc9d2` |

This consolidated report is a subsequent documentation commit in BookForge.
The embedded Foundry provenance points to its authoritative `3938e31` commit.

## What changed

- **Installation and desktop ownership:** Crucible publishes a versioned local
  installation record and owns status, start, stop, console, tray, and uninstall
  commands. Closing the tray leaves the engine running. An explicit stop persists
  across controller restarts. Windows login retains a custom installation home.
  macOS has a separate menu-bar application and launch agent.
- **Native process shutdown:** the controller launches Python directly instead
  of owning only a command wrapper. A private lifetime pipe requests graceful
  engine shutdown, including when the controller dies. The controller waits for
  cleanup before exiting, and upgrades wait for actual tray process exit.
- **Safe upgrades:** replacement runtimes are staged and checked before shutdown
  and activation. Failed shutdown keeps the installed runtime; failed activation
  preserves/restores the previous one. Uninstall aborts when shutdown fails and
  preserves job/upload data. Models require the existing explicit purge choice.
- **Network configuration:** settings writes preserve advertised addresses and
  replace configuration atomically. Native Windows interface enumeration works.
  Optional Tailscale sharing is owned explicitly, checks the exact forwarding
  target, and appears in the desktop menu. Installing WSL does not silently create
  broad LAN forwarding rules. Local configuration is not reported as proof of
  remote reachability.
- **WSL migration:** the guided path now verifies/imports the owned rootfs, runs
  its installer with the intended release, transfers configuration, stops the
  native engine, verifies authenticated guest identity/backend through Windows,
  switches pairing, and establishes controller ownership before reporting success.
- **BookForge routing:** work, settings, uploads, inventory, leases, streaming,
  and downloads reach the resolved engine even when the saved address is an
  orchestrator. Host/engine aliases share one queue lane. Artifact retrieval stays
  pinned to the submitting engine. Stale discovery cannot overwrite a newer route.
- **Cancellation and leases:** late submission/placement results cannot resurrect
  cancelled jobs. Late lease acquisition and renewal are cleaned up. Foundry model
  loading propagates cancellation. Server refresh preserves rank and enabled state.
- **Application setup:** both applications offer native Windows installation.
  Install/start/uninstall use the shared lifecycle contract. BookForge coordinates
  remote servers even if its local lifecycle check fails. Three hosted Foundry IPC
  collisions were removed, and the embedded source was synchronized from Foundry.
- **Release consistency:** source and vendored SDKs move together to 0.6.1.
  Python selection now follows each environment recipe, including Python 3.12 for
  the current CUDA Higgs recipe. Release creation stages a non-latest candidate;
  a promotion gate checks complete assets and requires completed install smoke
  tests. Verified unchanged inference packs can be staged for reuse; runtime packs
  must be rebuilt from the changed source.

## Validation

| Check | Result |
|---|---|
| BookForge keeper suites | 167 passed; one external EPUB fixture skipped |
| BookForge Electron compile and Angular production build | Passed; existing bundle-budget warning remains |
| Foundry tests | 847 passed |
| Standalone and embedded Foundry production builds | Passed; existing bundle-budget warning remains |
| Crucible TypeScript client | 310 passed |
| Crucible bootstrap | 269 passed, including four actual shell activation/rollback fixtures |
| Full Crucible Python suite in WSL | 1,940 passed; 14 skipped; zero failures |
| Native Windows lifecycle/sharing checks | 58 passed |
| New owned-engine process tests | Six passed, using real CPU subprocesses and ASGI worker cleanup |
| Embedded Foundry source parity | 173 files checked; no semantic differences or missing source files |
| Final Python wheel and source archive | Built successfully from the finished source; unpublished |

The full Python suite completed in 8 minutes 44 seconds. Existing test-library
deprecation warnings remain. Detailed regression coverage is in the individual reports.

The live Mac test loaded `qwen3.5-9b`, completed normal and streamed chat, checked
wrong-model refusal, and unloaded the model: all six checks passed. The final Mac
health response showed no queued work or resident model. An earlier streaming
failure exposed a missing lease in the test harness; the corrected lease-owning
test passed. This was not treated as an engine workaround.

The earlier PC protocol smoke passed job submission, upload, event/resume,
cancellation, and artifact checks. One check expected an echo-only fixture with
TTS disabled and was inapplicable to the real TTS-enabled server. No local model
was loaded for these checks. After the GPU handoff, all local verification used
CPU fixtures; no live local engine, WSL, driver, or training service was restarted.

## Release and acceptance boundary

These are source changes, not a deployment to the running engines. **A public
0.6.1 binary release has not been published.** The new installation commands need
the new runtime packs. Fresh installation from this source requests 0.6.1 and
fails explicitly until those matching assets exist; it does not silently install
incompatible 0.6.0 bytes. Existing registered engine API connections remain usable.

A clean Windows install/reboot/upgrade/uninstall, real WSL rootfs import and
migration, macOS menu-bar/login behavior, Tailscale remote reachability, and a full
audiobook/PDF production run were not established by the unit tests. These remain
release acceptance checks. The training runtime was deliberately left in place.
The two changed TTS environment packs and all runtime packs still require target
platform builds and smoke tests before release promotion.

The already-published 0.6.0 Windows controller has the old wrapper shutdown bug.
If its native Python engine remains alive after quit, the new upgrader refuses
the swap and explains the failure. Its safe refusal is tested; unattended upgrade
success from that old executable is not claimed.

## Detailed reports

- [BookForge integration](CRUCIBLE-INTEGRATION-AUDIT-2026-09-16.md)
- [Crucible lifecycle contract](../../crucible/docs/LOCAL-LIFECYCLE.md)
- [Crucible installation and networking](../../crucible/docs/INSTALL-NETWORK-AUDIT-2026-09-16.md)
- [Crucible release readiness](../../crucible/docs/PATCH-RELEASE-READINESS-2026-09-16.md)
- [Foundry integration](../../foundry/docs/CRUCIBLE-INTEGRATION-AUDIT-2026-09-16.md)
# Historical snapshot

For subsequent release work and current limitations, see
[release validation](CRUCIBLE-RELEASE-VALIDATION-2026-09-16.md). Product direction
is defined by [the intent of Crucible](https://github.com/telltaleatheist/crucible/blob/main/docs/INTENT.md).
