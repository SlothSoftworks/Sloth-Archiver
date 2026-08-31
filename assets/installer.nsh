; Extra Start Menu shortcuts pointing at the same installed app, purely so
; Windows Search can also match terms that don't literally appear in
; "SlothArchiver" (e.g. someone typing "youtube" or the app's old
; pre-rebrand name). Windows Search's app index is built directly from
; Start Menu shortcut names -- there's no separate "search keywords" tag
; for a plain NSIS-installed Win32 app, so extra named shortcuts are the
; only mechanism confirmed to actually work. Deliberately kept to two, not
; every candidate word considered -- more than that starts looking like a
; broken/duplicated install in the Start Menu.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\YouTube Archiver.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  CreateShortCut "$SMPROGRAMS\ytArchiver.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\YouTube Archiver.lnk"
  Delete "$SMPROGRAMS\ytArchiver.lnk"
!macroend
