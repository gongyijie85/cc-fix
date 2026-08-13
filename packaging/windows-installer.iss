#define AppPublisher "CC-Fix contributors"
#define AppURL "https://github.com/gongyijie85/cc-fix"
#ifndef AppVersion
  #error AppVersion must be supplied by build-installer.ps1
#endif
#ifndef PayloadDir
  #error PayloadDir must be supplied by build-installer.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by build-installer.ps1
#endif

[Setup]
AppId={{7C76DF1B-B683-4A77-9B4C-89E3305D2399}
AppName=CC-Fix
AppVersion={#AppVersion}
AppVerName=CC-Fix {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\CC-Fix
DefaultGroupName=CC-Fix
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=CC-Fix-Setup-{#AppVersion}-x64
SetupIconFile={#SourcePath}\..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\CC-Fix.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
ChangesEnvironment=yes
MinVersion=10.0.19045
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=CC-Fix Windows installer
VersionInfoProductName=CC-Fix

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"; Flags: unchecked
Name: "addpath"; Description: "将 CC-Fix CLI 添加到当前用户 PATH"; GroupDescription: "命令行集成:"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Excludes: "redist\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\redist\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; Flags: dontcopy

[Icons]
Name: "{group}\CC-Fix"; Filename: "{app}\CC-Fix.exe"; WorkingDir: "{app}"
Name: "{group}\CC-Fix 命令提示符"; Filename: "{cmd}"; Parameters: "/K ""{app}\bin\cc-fix.cmd"" --help"; WorkingDir: "{app}"
Name: "{autodesktop}\CC-Fix"; Filename: "{app}\CC-Fix.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\CC-Fix.exe"; Description: "启动 CC-Fix"; Flags: nowait postinstall skipifsilent

[Code]
const
  WebViewClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebViewClientId, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
  if not Result then
    Result := RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WebViewClientId, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
  if not Result then
    Result := RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WebViewClientId, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function ExistingInstallLocation(var Location, Version: String): Boolean;
begin
  Result := RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C76DF1B-B683-4A77-9B4C-89E3305D2399}_is1', 'InstallLocation', Location);
  RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C76DF1B-B683-4A77-9B4C-89E3305D2399}_is1', 'DisplayVersion', Version);
end;

function InitializeSetup: Boolean;
var
  Location, InstalledVersion, Launcher, Parameters: String;
  ResultCode: Integer;
begin
  Result := True;
  if not ExistingInstallLocation(Location, InstalledVersion) then exit;
  { Legacy 0.1.x had no durable transaction and is migrated by the new runtime on first launch. }
  if Pos('0.1.', InstalledVersion) = 1 then exit;
  Launcher := AddBackslash(Location) + 'bin\cc-fix.cmd';
  if not FileExists(Launcher) then begin Result := False; exit; end;
  Parameters := '/D /S /C ""' + Launcher + '" persist preflight"';
  Result := Exec(ExpandConstant('{cmd}'), Parameters, Location, SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    MsgBox('当前有未完成的 CC-Fix 恢复事务，已停止升级/修复。请先运行 cc-fix persist recover。', mbError, MB_OK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Installer: String;
begin
  Result := '';
  if WebView2Installed then exit;
  ExtractTemporaryFile('MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  Installer := ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
  if not Exec(Installer, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
    Result := '无法启动 Microsoft Edge WebView2 Runtime 安装程序。';
    exit;
  end;
  if ResultCode = 3010 then NeedsRestart := True
  else if ResultCode <> 0 then Result := 'Microsoft Edge WebView2 Runtime 安装失败，退出码：' + IntToStr(ResultCode) + '。';
  if (Result = '') and (not WebView2Installed) and (not NeedsRestart) then
    Result := 'Microsoft Edge WebView2 Runtime 安装后仍未通过检测。';
end;

function NormalizePathPart(Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(Value));
end;

function PathContains(PathValue, Entry: String): Boolean;
var
  Remaining, Part: String;
  Separator: Integer;
begin
  Result := False;
  Remaining := PathValue;
  while Remaining <> '' do begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then begin Part := Remaining; Remaining := ''; end
    else begin Part := Copy(Remaining, 1, Separator - 1); Delete(Remaining, 1, Separator); end;
    if CompareText(NormalizePathPart(Part), NormalizePathPart(Entry)) = 0 then begin Result := True; exit; end;
  end;
end;

procedure AddUserPath(Entry: String);
var
  Value: String;
begin
  RegQueryStringValue(HKCU, 'Environment', 'Path', Value);
  if not PathContains(Value, Entry) then begin
    if Value <> '' then
      if Value[Length(Value)] <> ';' then Value := Value + ';';
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Value + Entry);
  end;
end;

procedure RemoveUserPath(Entry: String);
var
  Value, Remaining, Part, Updated: String;
  Separator: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Value) then exit;
  Remaining := Value;
  Updated := '';
  while Remaining <> '' do begin
    Separator := Pos(';', Remaining);
    if Separator = 0 then begin Part := Remaining; Remaining := ''; end
    else begin Part := Copy(Remaining, 1, Separator - 1); Delete(Remaining, 1, Separator); end;
    if (Part <> '') and (CompareText(NormalizePathPart(Part), NormalizePathPart(Entry)) <> 0) then begin
      if Updated <> '' then Updated := Updated + ';';
      Updated := Updated + Part;
    end;
  end;
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Updated);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addpath') then
    AddUserPath(ExpandConstant('{app}\bin'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveUserPath(ExpandConstant('{app}\bin'));
end;

function InitializeUninstall: Boolean;
var
  ResultCode: Integer;
  Parameters: String;
  Index: Integer;
begin
  for Index := 1 to ParamCount do begin
    if CompareText(ParamStr(Index), '/PRESERVESTATE') = 0 then begin
      MsgBox('将仅移除程序并保留全部保护状态和恢复数据。重新安装同版本或更新版本后，请立即运行 cc-fix persist recover 或 persist off。', mbInformation, MB_OK);
      Result := True;
      exit;
    end;
  end;
  Parameters := '/D /S /C ""' + ExpandConstant('{app}\bin\cc-fix.cmd') + '" persist off"';
  Result := Exec(ExpandConstant('{cmd}'), Parameters, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    MsgBox('CC-Fix 无法完整还原日常配置，因此已停止卸载。请运行 cc-fix persist recover，确认状态健康后再卸载。', mbError, MB_OK);
end;
