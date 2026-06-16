; Custom NSIS hooks for BookForge (pulled in via electron-builder `nsis.include`).
;
; Adds two things the default electron-builder NSIS installer doesn't:
;   1. A Start-menu "Uninstall BookForge" shortcut, so a user can remove the app
;      by typing "uninstall bookforge" in the Start menu (not just Add/Remove).
;   2. An uninstall-time prompt to ALSO wipe all app data — the downloaded
;      audiobook engine, voices, language packs, caches, and settings. These live
;      under %APPDATA%\bookforge-app (the Electron userData dir, named after the
;      app's package name — NOT the product name, which is the usual gotcha).
;      The user's BOOKS live in their own library folder and are never touched.

!macro customInstall
  ; Start-menu shortcut straight to the uninstaller.
  CreateShortcut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  ; Default to KEEP data on a silent uninstall (/SD IDNO) so an unattended remove
  ; never nukes someone's downloads/settings without asking.
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also remove all BookForge data?$\n$\nThis deletes the downloaded audiobook engine, voices, language packs, and settings (several GB). Your books in your library folder are NOT affected." \
    /SD IDNO IDYES bf_removeData IDNO bf_keepData
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
