#ifndef AppVersion
  #define AppVersion "0.5.2"
#endif
#ifndef StageRoot
  #define StageRoot "..\build\package"
#endif
#ifndef ReleaseRoot
  #define ReleaseRoot "..\dist"
#endif

[Setup]
AppId=Framecut.Desktop
AppName=Framecut
AppVersion={#AppVersion}
AppUpdatesURL=https://github.com/getitrendered/framecut/releases
DefaultDirName={localappdata}\Programs\Framecut
DefaultGroupName=Framecut
OutputDir={#ReleaseRoot}
OutputBaseFilename=Framecut-Setup-x64
SetupIconFile=..\framecut.ico
UninstallDisplayIcon={app}\resources\app\framecut.ico
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=StandardInstall
CreateUninstallRegKey=StandardInstall
SolidCompression=yes
Compression=lzma2/fast
WizardStyle=modern

[Files]
Source: "{#StageRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "resources\default_app.asar"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked; Check: StandardInstall

[Icons]
Name: "{group}\Framecut"; Filename: "{app}\Framecut.exe"; IconFilename: "{app}\resources\app\framecut.ico"; Check: StandardInstall
Name: "{userdesktop}\Framecut"; Filename: "{app}\Framecut.exe"; IconFilename: "{app}\resources\app\framecut.ico"; Tasks: desktopicon; Check: StandardInstall

[Run]
Filename: "{app}\Framecut.exe"; Description: "Open Framecut"; Flags: nowait postinstall skipifsilent

[Code]
function StandardInstall: Boolean;
begin
  Result := ExpandConstant('{param:framecut-portable|0}') <> '1';
end;
