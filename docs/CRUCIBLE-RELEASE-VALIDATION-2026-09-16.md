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
- Corrected Crucible target: `0.6.2`, not yet promoted. Parser and Mac dependency
  fixes are in `db9b2b7`; rebuilt Mac fresh-home initialization passed in
  <https://github.com/telltaleatheist/crucible/actions/runs/35061594490>.
- WSL migration correction: `7ac2db6` prepares all destination models, verifies
  guest activation, then retires native weights through their owning catalog.
  It preserves the native executable and records interrupted cleanup. Background
  cleanup cannot start a download or delete sources whose destination is missing.
  Lifecycle, migration and uninstall regression checks: 216 passed, one skipped.
- BookForge target: `0.1.2927`, same version for Windows and Apple Silicon.
  Source `884aa08f` gates model preparation on completed provider/model choices,
  including embedded Foundry; configured Ollama routes request no duplicate LLM.
- Foundry `2.0.1` is already a prerelease. Corrected target is `2.0.2`, aligning
  CLI and desktop versions and consuming the corrected Crucible SDK and modules.
  Source `a34b3b7` includes first-run ordering and native-runtime readiness fixes.
- Client connection API: 315 unit tests passed. Native Python pairing/API/UI/
  desktop checks passed, followed by the malformed-code regression check.
- BookForge: 168 keeper suites passed, one external EPUB fixture skipped;
  Electron compile and Angular production build passed. Seventeen new connection
  and WSL checks are included.
- Native Windows isolated CPU protocol smoke: 12 of 12 passed with a private
  temporary home and random loopback port. It covered authentication, uploads,
  jobs, artifacts, resume, cancellation and graceful worker exit. It did not touch
  the installed services, WSL or model weights.
- Mac desktop publication is blocked on signing/keychain access. The user unlocked
  the keychain and both apps retried, but SSH still could not read the notarization
  item or use the signing key. No unsigned Mac build has been presented as notarized.
- Windows application candidates use the existing unsigned packaging workflow.

These are build and CPU-check results, not a claim that every fresh-machine
installation or full production workflow has passed.

## Training and test boundary

Claude's 02:10 Eastern update says the pause screen is still active and the ladder
has not started; estimated whole-chain completion moved to about 04:45. Training
ended at 01:26. The estimate is not authorization to assume completion. The user
subsequently authorized service downtime while in bed. GPU interruption still
requires checking that the ladder has finished. No local live service, GPU
workload, or WSL installation has been changed during this release phase.

A 03:00 Eastern check is scheduled in this task. It must reread the Claude log
and inspect activity, then use the local GPU only after the entire ladder is
confirmed finished. A moment of idle GPU utilization is insufficient. The
08:00 report remains scheduled.

The Mac service was checked idle before two real fresh-home installation attempts.
Both exposed the `0.6.1` defects above, and both restored the existing `0.6.0`
service and CLI afterward without changing its model/data home. A corrected
`0.6.2` test must still exercise installation, authenticated pairing, registered
CLI, service stop/start, desktop registration and uninstall. A fresh home on this
Mac is not a clean-OS or reboot test.
