# Crucible, BookForge and Foundry release validation

This continues the earlier source audit in `CRUCIBLE-OVERNIGHT-REPORT-2026-09-16.md`.
The user authorized publication and preserving-data installation tests, then
clarified that Crucible should behave as an app-managed service, like Ollama.

The canonical product contract is [the intent of Crucible](https://github.com/telltaleatheist/crucible/blob/main/docs/INTENT.md).
It records native Windows independence, optional WSL, app-owned model choices,
shared storage, provider reuse and acceptance scenarios. This dated report records
implementation evidence and remaining limitations; it does not replace that intent.

## Intended ownership

| Concern | Owner and normal user interface |
|---|---|
| Library, project workflow, rendering preferences | BookForge or Foundry |
| Remembering trusted server connections | The app's trusted main process |
| Engine installation, services, model files, device scheduling, leases | Crucible; apps request operations and display progress |
| Model availability, inference routes and upstream credentials | Stored by Crucible; configured through authenticated API calls from the apps |
| Optional WSL engine migration | Crucible's Windows controller; initiated and followed inside the app |
| Remote connection approval | An already trusted BookForge/Foundry instance, with an optional Crucible maintenance UI |

The Windows BookForge NSIS installer installs BookForge. Its first-launch setup
offers one-button Crucible installation, then automatically connects and prepares
capabilities. This is deliberately one shared runtime installer invoked by the
app, rather than a second implementation embedded in NSIS. WSL is an optional
acceleration step; the controller prepares its owned distribution and carries
settings across. Existing WSL distributions are not silently repurposed. Windows
may still require an administrator approval or restart when enabling OS features.

Foundry independently adopts an existing authenticated local Crucible, so the
two apps share the service. An existing deliberately empty app server registry is
preserved. Normal server settings are API operations and work remotely too.

A bare remote IP or hostname uses Crucible's canonical port 7100. Custom ports
can be specified explicitly. This does not scan arbitrary ports. Finding a
server never discloses its token: a short matching-code approval grants access.
Device secrets and bearer credentials remain outside the renderer. The current
credential is service-wide; per-client scopes and revocation remain future work.

## Release state

- Crucible `0.6.1` was published as a prerelease with 29 verified assets, then
  rejected by real fresh-home Mac installation. Its POSIX manifest parser retained
  CR characters in multipart URLs; after that fix, its Mac core lacked MLX required
  by hardware detection. Its release notes warn against fresh installation. The
  immutable candidate remains at <https://github.com/telltaleatheist/crucible/releases/tag/v0.6.1>.
- Corrected Crucible [0.6.2 candidate](https://github.com/telltaleatheist/crucible/releases/tag/v0.6.2)
  is published from `d363eaf`, not promoted. All 29 assets (17,348,272,397 bytes)
  were checked against remote SHA256 and size; the manifest was uploaded last.
  Parser and Mac dependency
  fixes are in `db9b2b7`; rebuilt Mac fresh-home initialization passed in
  <https://github.com/telltaleatheist/crucible/actions/runs/35061594490>.
- WSL migration correction: `7ac2db6` prepares all destination models, verifies
  guest activation, then retires native weights through their owning catalog.
  It preserves the native executable and records interrupted cleanup. Background
  cleanup cannot start a download or delete sources whose destination is missing.
  Lifecycle, migration and uninstall regression checks: 216 passed, one skipped.
- BookForge target: `0.1.2927`, same version for Windows and Apple Silicon.
  Source `7f3bfbed` waits for selected supported models to be ready before Finish,
  including embedded Foundry, retains a pending marker on failure, and waits for
  authenticated POSIX service readiness. New setup no longer offers the separate
  app-owned Cogito download. Existing offline configurations and weights remain.
- Foundry [2.0.2 candidate](https://github.com/telltaleatheist/foundry/releases/tag/v2.0.2)
  is published from `24f586b`: Windows installer, four CLI archives and checksums,
  all remote digests verified. Stable/latest remains 2.0.0. First-run setup now
  waits for selected supported model readiness, and POSIX service bootstrap is
  lightweight until provider choices. All 180 embedded app source files match.
- Client connection API: 315 unit tests passed. Native Python pairing/API/UI/
  desktop checks passed, followed by the malformed-code regression check.
- BookForge: 168 keeper suites passed, one external EPUB fixture skipped;
  Electron compile and Angular production build passed. The final POSIX readiness
  correction also passed 44 install checks on Windows and Mac. Foundry passed
  870 tests plus standalone and embedded production builds.
- Native Windows isolated CPU protocol smoke: 12 of 12 passed with a private
  temporary home and random loopback port. It covered authentication, uploads,
  jobs, artifacts, resume, cancellation and graceful worker exit. It did not touch
  the installed services, WSL or model weights.
- Mac desktop publication is blocked on signing/keychain access. The user unlocked
  the keychain and both apps retried, but SSH still could not read the notarization
  item or use the signing key. No unsigned Mac build has been presented as notarized.
- Windows application candidates use the existing unsigned packaging workflow.
- Source-only Crucible fix `ce2684e` adds an authenticated readiness wait to the
  shared POSIX installer steps; 278 bootstrap tests pass. Published 0.6.2 assets
  remain unchanged. Both corrected app candidates explicitly await readiness using
  the published SDK, so they cover the short service-startup delay already.
- CI Python 3.12 lacked setuptools for the wheel fixtures' `--no-isolation` build.
  `4948204` provisions the backend explicitly. The frozen candidate's Linux 3.11
  full suite passed; subsequent full matrix results must be checked separately.
- An exploratory broader native Windows test run was not a full pass: a POSIX
  fake aligner cancellation stalled on `os.killpg`; a later API selection had
  151 passes and eight failures from executable-shebang installer fixtures and a
  POSIX 0600 assertion. Windows pairing uses an ACL instead. These portability
  limitations do not replace native installation/GPU acceptance, which is pending.

These are build and CPU-check results, not a claim that every fresh-machine
installation or full production workflow has passed.

## Training and test boundary

Claude's 02:10 Eastern update says the pause screen is still active and the ladder
has not started; estimated whole-chain completion moved to about 04:45. Training
ended at 01:26. The estimate is not authorization to assume completion. The user
subsequently authorized service downtime while in bed. GPU interruption still
requires checking that the ladder has finished. No local live service, GPU
workload, or WSL installation has been changed during this release phase.

A 03:00 Eastern check and 05:00 follow-up are scheduled in this task. They must reread the Claude log
and inspect activity, then use the local GPU only after the entire ladder is
confirmed finished. A moment of idle GPU utilization is insufficient. The
08:00 report remains scheduled.

## Actual Mac installation and inference

The two first fresh-home attempts exposed the `0.6.1` defects above and restored
the original service. Published `0.6.2` then passed the complete fresh-home test:

- Authenticated readiness after a measured 1.7-second startup delay.
- Bare installation downloaded no app models or inference environments.
- Correct identity, local registration, owned CLI and a live menu-bar process.
- Matching-code pairing worked; unauthenticated approval was refused.
- Installed stop/start, uninstall dry run and actual uninstall passed.
- Uninstall removed owned runtime/desktop registrations and retained the model
  directory's disposable data fixture; the original service and CLI were restored.

The initial immediate-status assertion was too early. A separate probe proved
the new service was healthy after three seconds. The validation helper also needed
to wait for asynchronous launchd unload before restoring the old service. Neither
observation was hidden by calling the first attempt a pass.

After fresh acceptance, the actual Mac installation was upgraded to 0.6.2. Its
token and all 14 existing model installation stamps were preserved, and its new
owned CLI, installation record and menu bar were verified. Private rollback
backups remain under `~/.crucible-release-validation/0.6.2-upgrade`; the old conda
runtime is retained for recovery. This is not a clean-OS or reboot test.

Foundry's published 2.0.2 CLI then processed a disposable two-block document through
the actual Mac service. Cleanup with Qwen 9B completed two requests in 10.3 seconds;
explicit translation with the installed Qwen 27B 4-bit completed two requests in
5.8 seconds. Numbers, colors and meaning were preserved in the Spanish output.
Leases were released and the accelerator was checked idle afterward. See the
[Foundry acceptance report](https://github.com/telltaleatheist/foundry/blob/main/docs/FOUNDRY-MAC-ACCEPTANCE-2026-09-16.md).

The Mac's preserved configuration selects the supported but uninstalled unquantized
27B as its default, so this does not prove that default is ready. The test explicitly
selected an installed model and did not change defaults or download weights. Mac
page-image OCR is unsupported by the current manifests; native Windows OCR and
WSL migration/inference remain separate acceptance work once the local GPU is free.
