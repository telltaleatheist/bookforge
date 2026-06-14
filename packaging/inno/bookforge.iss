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
; Inno caps a single Setup.exe at ~4.2 GB (Windows limit). The slimmed seed
; payload (CPU-only llama, trimmed stanza, no CUDA) fits under that, so a
; single-file installer is the default. The offline build (--seed swapped for
; --models, +26 GB) compresses past 4.2 GB and must re-enable disk spanning
; (Setup.exe + .bin slices) with /DEnableSpanning=yes.
#ifndef EnableSpanning
  #define EnableSpanning "no"
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

[Code]
// Full uninstall of OUR data. The default uninstaller only removes the program.
// All the heavy runtime data BookForge downloads — the unpacked Python engine,
// voice & AI models, Stanza language packs, GPU components, caches, and settings
// — lives in the per-user Electron userData, which it never touches. We delete
// that here so uninstalling reclaims all the disk it used.
//
// We deliberately DO NOT touch the user's audiobook library (Documents\BookForge:
// their imported ebooks, projects, and finished audiobooks) — those are their own
// files, not ours. The dialog tells them so.
// (Note: Pascal { } comments end at the first '}', so '//' is used here to keep
// path examples with braces from breaking the compile.)

procedure RemoveTreeIfExists(const Dir: String);
begin
  if DirExists(Dir) then
    DelTree(Dir, True, True, True);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppData, LocalData, Logs, Library, KeptMsg: String;
begin
  if CurUninstallStep <> usPostUninstall then
    Exit;

  // Electron's userData uses the package name ("bookforge-app"), NOT the product
  // name — that's where models/engine/components/settings live. The file logger
  // uses a separate "BookForgeApp" folder. The user's library is Documents\BookForge.
  AppData   := ExpandConstant('{userappdata}\bookforge-app');
  LocalData := ExpandConstant('{localappdata}\bookforge-app');
  Logs      := ExpandConstant('{userappdata}\BookForgeApp');
  Library   := ExpandConstant('{userdocs}\BookForge');

  if DirExists(Library) then
    KeptMsg := 'Your audiobook library (your imported books, projects, and finished audiobooks) will be KEPT at:' + #13#10 + Library
  else
    KeptMsg := 'Your audiobook library, if any, will be kept — we never delete your own books.';

  if MsgBox('Also remove BookForge''s downloaded data?' + #13#10#13#10 +
            'This deletes the voice & AI models, language packs, GPU components, the bundled audiobook engine, caches, and your settings — freeing up to several GB.' + #13#10#13#10 +
            KeptMsg,
            mbConfirmation, MB_YESNO) = IDYES then
  begin
    RemoveTreeIfExists(AppData);
    RemoveTreeIfExists(LocalData);
    RemoveTreeIfExists(Logs);
  end;
end;
