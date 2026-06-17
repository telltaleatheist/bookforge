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
  ; A real uninstall removes ALL app data (the user chose to remove the app, so
  ; take its data too — no prompt). The SILENT auto-uninstall electron-builder
  ; runs during an UPGRADE is skipped, so reinstalling over a version never loses
  ; downloads/settings. IfSilent → keep; interactive → wipe.
  IfSilent bf_keepData bf_removeData
  bf_removeData:
    ; Normalized location (everything lives here now), plus pre-normalization dirs.
    RMDir /r "$APPDATA\BookForge"
    RMDir /r "$APPDATA\bookforge-app"
    RMDir /r "$APPDATA\BookForgeApp"
    RMDir /r "$LOCALAPPDATA\BookForge-updater"
    RMDir /r "$LOCALAPPDATA\bookforge-app-updater"
  bf_keepData:
  ; Clean up the Start-menu uninstaller shortcut we created on install.
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
!macroend
