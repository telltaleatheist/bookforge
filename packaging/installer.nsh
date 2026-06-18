; Custom NSIS hooks for BookForge (pulled in via electron-builder `nsis.include`).
;
; Adds two things the default electron-builder NSIS installer doesn't:
;   1. A Start-menu "Uninstall BookForge" shortcut, so a user can remove the app
;      by typing "uninstall bookforge" in the Start menu (not just Add/Remove).
;   2. A DELIBERATE uninstall wipes all app data — the downloaded audiobook engine,
;      voices, language packs, caches, and settings (under %APPDATA%\BookForge).
;      An UPGRADE (reinstalling over an existing version) runs the old uninstaller
;      SILENTLY, which we detect with IfSilent and SKIP, so upgrades keep data.
;      The user's BOOKS live in their own library folder and are never touched.

!macro customInstall
  ; Start-menu shortcut straight to the uninstaller.
  CreateShortcut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  ; A real uninstall removes ALL app data (the user chose to remove the app, so take
  ; its data too — no prompt). During an UPGRADE, electron-builder runs the OLD
  ; uninstaller with the --updated flag, so we skip the wipe and downloads/settings
  ; survive a reinstall-over-version.
  ;
  ; We gate on ${isUpdated}, NOT IfSilent. A oneClick uninstaller ALWAYS runs in
  ; silent mode (see electron-builder templates/nsis/uninstaller.nsh: "one-click
  ; installer executes uninstall section in the silent mode"), so IfSilent is ALWAYS
  ; true here and the old IfSilent-based skip wiped NOTHING on a real uninstall.
  ; ${isUpdated} (set from the --updated flag electron-builder passes only during an
  ; upgrade) is the reliable signal — it's what electron-builder itself uses to gate
  ; DELETE_APP_DATA_ON_UNINSTALL.
  ${ifNot} ${isUpdated}
    ; Normalized location (everything lives here now), plus pre-normalization dirs.
    RMDir /r "$APPDATA\BookForge"
    RMDir /r "$APPDATA\bookforge-app"
    RMDir /r "$APPDATA\BookForgeApp"
    RMDir /r "$LOCALAPPDATA\BookForge-updater"
    RMDir /r "$LOCALAPPDATA\bookforge-app-updater"
  ${endIf}
  ; Clean up the Start-menu uninstaller shortcut we created on install.
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
!macroend
