# BookForge coordinated release — 2026-09-16

Target app version: **0.1.2927**, explicitly set with `BOOKFORGE_BUILD_COUNT=2927` on both build hosts. The source package version is 0.1.7; packaging normally replaces its patch with the Git commit count. The explicit release number avoids publishing a version below the existing 0.1.2174 Windows build or letting the two build hosts choose different versions.

## What the installer and first launch do

Windows production packaging uses electron-builder NSIS through `packaging/package-win.js`. `packaging/installer.nsh` creates an uninstall shortcut and removes BookForge app data on a deliberate uninstall, retaining app data during an upgrade. It does **not** download Crucible or install WSL. The old Inno Setup script is not the production packaging path.

First launch opens the existing guided setup. The order is now library, Crucible, AI settings, review. A fresh BookForge registry adopts an authenticated existing Crucible from its local pairing file. No WSL distribution is started to do this. An existing empty registry is preserved because it can represent a deliberate removal.

If no engine exists, **Install Crucible (recommended)** runs Crucible's published native Windows installer, streams its progress, verifies the installed service, and connects it to BookForge automatically. macOS uses the SDK's native pack installer. Normal users do not need to find an executable, type a port, or copy a bearer token. A malformed pairing, an identity mismatch, or a failed install remains an explicit failure.

WSL is an explicit optional **Enable WSL acceleration** action in BookForge. It submits the authenticated engine task and displays progress; Crucible's controller owns distribution preparation, Windows permissions, restart requirements and the engine switch. BookForge verifies the new accelerated backend after the switch before reporting success. It never silently modifies an unrelated WSL distribution.

Remote connections accept an IP address or hostname. The shared SDK chooses Crucible's canonical port unless a URL or explicit port is supplied. BookForge displays a short matching code; an already connected BookForge or Foundry approves it through **Connection requests** in Settings. The private device code and eventual bearer token remain in Electron main. Approval resolves the registered endpoint to its engine, because the controller does not own a pairing store. The optional maintenance console and existing connect-code import still work.

AI routes and upstream credentials continue to use Crucible's authenticated settings API from BookForge. Automatic module coordination prepares the models and capabilities BookForge needs. Crucible remains the owner of installation and model state.

## Build and publication sequence

1. Publish and verify the coordinated Crucible release and runtime assets first. Build the final SDK tarballs and install those exact tarballs in both app trees.
2. Sync and build the matching embedded Foundry tree. `packaging/foundry-guard.js` must pass before BookForge packaging.
3. Windows, PowerShell: `$env:BOOKFORGE_BUILD_COUNT='2927'; npm run package:win-x64`. Expected artifact: `release/BookForge Setup 0.1.2927.exe`.
4. On the Mac build host: `BOOKFORGE_BUILD_COUNT=2927 npm run package:mac:signed`. Expected Apple Silicon artifact: `release/BookForge-0.1.2927-arm64.dmg`. A public release requires successful signing, notarization and staple verification. The script obtains notarization credentials from the build host's environment or its `BOOKFORGE_NOTARIZE_ASP` keychain item; credentials are never copied into this worklog.
5. Stage a **draft** `v0.1.2927` GitHub release with both stable asset names, `BookForge-win-x64.exe` and `BookForge-mac-arm64.dmg`, SHA-256 checksums, and release notes. Publish and mark latest only after both platforms are verified. The current per-platform `publish-app.js` marks latest too early for a coordinated release and must not be used independently here.

## Verification and boundaries

CPU regressions cover first-run adoption, preservation of deliberate removals, missing pairing, identity refusal, duplicate races, renderer credential exclusion, window ownership, pairing cancellation, concurrent approval polling and WSL task/switch verification. Existing native install tests exercise a scripted fresh Windows installation with no WSL/GPU, authenticated verification and installer failures. The full Electron compile, Angular production build, IPC collision and keeper suites are required before final packaging.

The production Windows Crucible service, WSL distributions and GPUs are occupied by training and have not been stopped, restarted or uninstalled in this phase. The scheduled 3am check permits GPU validation only after the training ladder is confirmed complete. BookForge NSIS uninstall must not run against the real user profile: its deliberate-uninstall hook removes app data. Clean install/uninstall validation must use an isolated machine/VM or an explicitly isolated disposable profile, preserving user projects and preferences. Packaging and test-owned CPU fixtures are permitted.

Build results, artifact hashes and release URLs will be appended when available. This file does not claim publication or clean-machine install/uninstall validation before those actions occur.

### Completed checks

- Final SDK client tarball SHA-512: `8eeeZv9xTbmygVI/z2JeWDIniAPWP5HdE59wa1gHGqg8Vx6SugULgCWMyRi0dRnGTgLvp/nDi1x1ydmO869sig==`; the lockfile integrity matches.
- `npm test`: Electron TypeScript compile succeeded; **168 keeper suites passed, one external EPUB fixture skipped, zero failures**. The new first-launch/connection/WSL suite passed **17 checks**. Log: `release/bookforge-0.1.2927-test.log`.
- Angular production build succeeded. The existing initial bundle budget warning remains (approximately 675 kB against a 500 kB warning threshold).
- Windows MuPDF and llama.cpp binary staging completed. Seed staging correctly reports that the old ebook2audiobook payload is no longer shipped.
- An isolated Mac checkout exists at `/Volumes/Callisto/Projects/release-builds/bookforge-0.1.2927`; the original `/Volumes/Callisto/Projects/BookForgeApp` checkout was not changed. Developer ID Application signing and the notarization keychain item are available on the build host.
