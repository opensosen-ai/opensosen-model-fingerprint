Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor zlib
ManifestDPIAware true
!include "x64.nsh"

!ifndef AppVersion
  !error "Pass the application version with /DAppVersion, or run npm run build:portable."
!endif
!define AppName "OpenSosen Model Fingerprint"
!define Stem "OpenSosenModelFingerprint-${AppVersion}-win-x64"
Name "${AppName}"
OutFile "out\${Stem}.exe"
VIProductVersion "${AppVersion}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${AppName}"
VIAddVersionKey /LANG=1033 "CompanyName" "OpenSosen"
VIAddVersionKey /LANG=1033 "FileDescription" "${AppName} (Windows x64 portable)"
VIAddVersionKey /LANG=1033 "FileVersion" "${AppVersion}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${AppVersion}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 OpenSosen"

Section
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "This application requires 64-bit Windows."
    SetErrorLevel 1
    Quit
  ${EndIf}

  InitPluginsDir
  ClearErrors
  SetOutPath "$PLUGINSDIR\app"
  File /r "out\${Stem}\*.*"
  IfErrors failed
  ExecWait '"$OUTDIR\OpenSosenModelFingerprint.exe"' $0
  IfErrors failed
  SetOutPath "$TEMP"
  ; Chromium subprocesses can keep the shared executable open briefly.
  StrCpy $1 20
  cleanup:
    ClearErrors
    Delete "$PLUGINSDIR\app\OpenSosenModelFingerprint.exe"
    IfErrors 0 finished
    Sleep 200
    IntOp $1 $1 - 1
    IntCmp $1 0 finished finished cleanup
  finished:
  SetErrorLevel $0
  Goto done

  failed:
    SetOutPath "$TEMP"
    MessageBox MB_OK|MB_ICONSTOP "OpenSosen Model Fingerprint could not start. Check available space in the Windows temporary folder."
    SetErrorLevel 1
  done:
SectionEnd
