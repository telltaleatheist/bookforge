; BookForge Windows installer (Inno Setup 6.3+)
;
; Why Inno instead of NSIS: the bundled offline payload (Python env tarball +
; e2a model snapshot + llama runtime) is ~6 GB. NSIS has a hard 2 GB limit and
; SILENTLY produces a truncated/malformed installer past it (electron-builder
; #8399). Inno Setup 6.3+ handles single-file installers well over 2 GB.
;
; This script packages an already-built electron-builder `win-unpacked` tree.
; It is driven by packaging/build-inno.js, which passes the paths/version as
; defines. Defaults below let you also compile it directly for quick iteration.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\release\win-unpacked"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release"
#endif
#ifndef IconFile
  #define IconFile "..\..\release\.icon-ico\icon.ico"
#endif
; Compression: lzma2/max gives the smallest installer but is slow on a ~6 GB
; payload (most of which — the gzipped env tarball — is incompressible anyway).
; Override with /DCompressionMethod=lzma2/fast (or none) for faster iteration.
#ifndef CompressionMethod
  #define CompressionMethod "lzma2/max"
#endif
; Inno caps a single Setup.exe at ~4.2 GB (Windows limit). Our full offline
; payload compresses past that, so disk spanning (Setup.exe + .bin slices) is on
; by default. Once the payload is slimmed under ~4 GB (e.g. CPU-only llama +
; lighter default voice), pass /DEnableSpanning=no for a single-file installer.
#ifndef EnableSpanning
  #define EnableSpanning "yes"
#endif

#define MyAppName "BookForge"
#define MyAppPublisher "BookForge"
#define MyAppExeName "BookForge.exe"

[Setup]
; Stable AppId — keep constant across versions so upgrades replace in place.
AppId={{8F4A2B1C-3D5E-4F6A-8B9C-0D1E2F3A4B5C}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
; Per-user install (no admin), mirroring the previous NSIS perMachine=false.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir={#OutputDir}
OutputBaseFilename=BookForge-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
WizardStyle=modern
Compression={#CompressionMethod}
SolidCompression=no
#if EnableSpanning == "yes"
DiskSpanning=yes
DiskSliceSize=2100000000
#endif
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Make sure a running instance is closed before upgrading/uninstalling.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The entire electron-builder win-unpacked tree -> {app}. recursesubdirs +
; createallsubdirs is required for the deep resources\e2a model tree.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
