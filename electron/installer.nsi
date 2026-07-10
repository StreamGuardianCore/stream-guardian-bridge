; Stream Guardian OBS Bridge - NSIS installer script
; Produces a single Setup.exe that installs into %LocalAppData%\Programs
; so users never see the raw Electron runtime files.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT_NAME "Stream Guardian OBS Bridge"
!define PRODUCT_SHORT "StreamGuardian-OBS-Bridge"
!define PRODUCT_PUBLISHER "Stream Guardian"
!define PRODUCT_WEB_SITE "https://www.streamguardian.co.uk"
!define PRODUCT_EXE "StreamGuardian-OBS-Bridge.exe"
!define PRODUCT_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_SHORT}"

; PRODUCT_VERSION is passed in via /DPRODUCT_VERSION=x.y.z on the command line
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.0"
!endif
; SOURCE_DIR is the unpacked Electron app folder, passed via /DSOURCE_DIR=...
!ifndef SOURCE_DIR
  !error "SOURCE_DIR must be defined (path to packaged Electron app folder)"
!endif

Name "${PRODUCT_NAME}"
OutFile "StreamGuardian-OBS-Bridge-Setup-${PRODUCT_VERSION}.exe"
BrandingText "${PRODUCT_PUBLISHER}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_SHORT}"
InstallDirRegKey HKCU "Software\${PRODUCT_SHORT}" "InstallDir"
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "© ${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Installer"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"

!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCT_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  ; Recursively copy the entire packaged Electron app folder contents.
  File /r "${SOURCE_DIR}\*.*"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0

  ; Registry: install dir + Add/Remove Programs entry
  WriteRegStr HKCU "Software\${PRODUCT_SHORT}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "${PRODUCT_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${PRODUCT_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PRODUCT_REGKEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${PRODUCT_REGKEY}" "EstimatedSize" "$0"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${PRODUCT_REGKEY}"
  DeleteRegKey HKCU "Software\${PRODUCT_SHORT}"
SectionEnd
