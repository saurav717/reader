; Koios's Windows installer and uninstaller: what electron-builder's NSIS scripts
; leave to the app (nsis.include in electron-builder.config.cjs).
;
; Installing: an "Uninstall Koios" shortcut beside Koios's in the Start menu. The
; Companion itself is set up by the app the first time it opens (main.js), with
; the uv, the wheel and the Python inside it, so this installer needs no network and no Python.
;
; Uninstalling (Settings -> Apps -> Koios -> Uninstall, the Start menu's Uninstall
; Koios, or Help -> Uninstall Koios... in the app, which runs this silently after
; doing the same itself): the Companion stopped and no longer started at sign-in,
; the Koios extension taken out of VS Code, the Companion program uninstalled, and,
; only if asked, the files and settings deleted too. Never on an update: the new
; version's installer runs this uninstaller first, and nothing is taken away then.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall Koios.lnk" "$INSTDIR\Uninstall Koios.exe" "" "$INSTDIR\Koios.exe" 0
  ; The app was called Reader until 0.16: its own uninstall shortcut goes with it.
  Delete "$SMPROGRAMS\Uninstall Reader.lnk"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $R8 ""
    ; Silent (the app's own uninstall): the app asked already, and did what was asked.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Koios files and settings?$\r$\n$\r$\nYour projects and notebooks in $PROFILE\Reader, the Companion's settings, and what Koios keeps on this PC (a library you didn't sign in to Google Drive with).$\r$\n$\r$\nYour library in Google Drive isn't touched." /SD IDNO IDNO keepFiles
      StrCpy $R8 "--delete-files"
    keepFiles:

    DetailPrint "Stopping the Koios Companion…"
    IfFileExists "$PROFILE\.local\bin\reader-companion.exe" 0 noCompanion
      nsExec::ExecToLog '"$PROFILE\.local\bin\reader-companion.exe" uninstall --vscode $R8'
      Pop $0
    noCompanion:
    IfFileExists "$INSTDIR\resources\companion\uv.exe" 0 noUv
      nsExec::ExecToLog '"$INSTDIR\resources\companion\uv.exe" tool uninstall reader-companion'
      Pop $0
    noUv:
    RMDir /r "$PROFILE\.reader-companion\bin"
    ${if} $R8 != ""
      RMDir /r "$PROFILE\.reader-companion"
      ; What the app keeps: still in the folder named Reader, the app's name until 0.16 (main.js, userData).
      RMDir /r "$APPDATA\Reader"
    ${endIf}
    Delete "$SMPROGRAMS\Uninstall Koios.lnk"
  ${endIf}
!macroend
