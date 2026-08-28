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
  InstallerStateKey = 'Software\CC-Fix\Installer';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C76DF1B-B683-4A77-9B4C-89E3305D2399}_is1';
  CurrentReleaseVersion = '{#AppVersion}';

function StripQuotes(Value: String): String;
begin
  Result := Value;
  if (Length(Result) >= 2) and (Result[1] = '"') and (Result[Length(Result)] = '"') then
    Result := Copy(Result, 2, Length(Result) - 2);
end;

{ issue #55：HKCU 卸载键可被同用户篡改。执行其中的 cc-fix.cmd 之前先做三重核验：
  1) UninstallString 的目录与 InstallLocation 一致（单一值篡改可检出）
  2) InstallLocation 下存在完整产品布局（伪造目录需复制全套载荷）
  3) cc-fix.cmd 形状符合产品启动器（引用 runtime\node.exe 与 core\index.js）
  无 Authenticode 时的纵深防御：不构成密码学信任根，残余风险记录于 issue #55。 }
function UninstallRecordConsistent(Location: String): Boolean;
var
  UninstallString, UninstallerDir: String;
begin
  Result := False;
  if not RegQueryStringValue(HKCU, UninstallKey, 'UninstallString', UninstallString) then exit;
  UninstallerDir := ExtractFilePath(StripQuotes(UninstallString));
  if UninstallerDir = '' then exit;
  Result := CompareText(RemoveBackslashUnlessRoot(UninstallerDir), RemoveBackslashUnlessRoot(Trim(Location))) = 0;
end;

function InstallLayoutLooksLegit(Location: String): Boolean;
var
  Base: String;
begin
  Base := AddBackslash(Trim(Location));
  Result := (Base <> '')
    and FileExists(Base + 'bin\cc-fix.cmd')
    and FileExists(Base + 'core\index.js')
    and FileExists(Base + 'core\sidecar.js')
    and FileExists(Base + 'runtime\node.exe')
    and FileExists(Base + 'assets\gui\app.css')
    and FileExists(Base + 'assets\gui\app.js')
    and FileExists(Base + 'assets\fonts\cc-fix-noto-sans-sc.woff2')
    and FileExists(Base + 'CC-Fix.exe');
end;

function LauncherLooksLegit(Location: String): Boolean;
var
  Lines: TArrayOfString;
  Index, LineCount: Integer;
  MentionsNode, MentionsCore: Boolean;
begin
  Result := False;
  if not LoadStringsFromFile(AddBackslash(Trim(Location)) + 'bin\cc-fix.cmd', Lines) then exit;
  LineCount := GetArrayLength(Lines);
  if (LineCount < 3) or (LineCount > 8) then exit;
  if CompareText(Trim(Lines[0]), '@echo off') <> 0 then exit;
  MentionsNode := False;
  MentionsCore := False;
  for Index := 0 to LineCount - 1 do begin
    if Pos('runtime\node.exe', Lines[Index]) > 0 then MentionsNode := True;
    if Pos('core\index.js', Lines[Index]) > 0 then MentionsCore := True;
  end;
  Result := MentionsNode and MentionsCore;
end;

function TrustedInstallRecord(Location: String): Boolean;
begin
  Result := UninstallRecordConsistent(Location)
    and InstallLayoutLooksLegit(Location)
    and LauncherLooksLegit(Location);
end;

function ParseReleaseVersion(Value: String; var Major, Minor, Patch, Stability, PreNumber: Integer): Boolean;
var
  Core, PreRelease, Part: String;
  Separator: Integer;
begin
  Result := False;
  Core := Value;
  PreRelease := '';
  Separator := Pos('-', Core);
  if Separator > 0 then begin
    PreRelease := Copy(Core, Separator + 1, MaxInt);
    Delete(Core, Separator, MaxInt);
  end;

  Separator := Pos('.', Core);
  if Separator = 0 then exit;
  Part := Copy(Core, 1, Separator - 1);
  Major := StrToIntDef(Part, -1);
  Delete(Core, 1, Separator);
  Separator := Pos('.', Core);
  if Separator = 0 then exit;
  Part := Copy(Core, 1, Separator - 1);
  Minor := StrToIntDef(Part, -1);
  Delete(Core, 1, Separator);
  if Pos('.', Core) > 0 then exit;
  Patch := StrToIntDef(Core, -1);
  if (Major < 0) or (Minor < 0) or (Patch < 0) then exit;

  if PreRelease = '' then begin
    Stability := 1;
    PreNumber := 0;
  end else begin
    if Pos('rc.', PreRelease) <> 1 then exit;
    PreNumber := StrToIntDef(Copy(PreRelease, 4, MaxInt), -1);
    if PreNumber < 0 then exit;
    Stability := 0;
  end;
  Result := True;
end;

function CompareReleaseVersions(Left, Right: String; var Comparison: Integer): Boolean;
var
  LeftMajor, LeftMinor, LeftPatch, LeftStability, LeftPre: Integer;
  RightMajor, RightMinor, RightPatch, RightStability, RightPre: Integer;
begin
  Result := ParseReleaseVersion(Left, LeftMajor, LeftMinor, LeftPatch, LeftStability, LeftPre) and
    ParseReleaseVersion(Right, RightMajor, RightMinor, RightPatch, RightStability, RightPre);
  if not Result then exit;
  Comparison := LeftMajor - RightMajor;
  if Comparison = 0 then Comparison := LeftMinor - RightMinor;
  if Comparison = 0 then Comparison := LeftPatch - RightPatch;
  if Comparison = 0 then Comparison := LeftStability - RightStability;
  if (Comparison = 0) and (LeftStability = 0) then Comparison := LeftPre - RightPre;
end;

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
  Result := RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Location);
  RegQueryStringValue(HKCU, UninstallKey, 'DisplayVersion', Version);
end;

procedure ReportSetupError(Message: String);
begin
  Log(Message);
  if not WizardSilent then MsgBox(Message, mbError, MB_OK);
end;

function InitializeSetup: Boolean;
var
  Location, InstalledVersion, Launcher, Parameters: String;
  ResultCode, VersionComparison: Integer;
begin
  Result := True;
  if not ExistingInstallLocation(Location, InstalledVersion) then exit;
  { Legacy 0.1.x had no durable transaction and is migrated by the new runtime on first launch. }
  if Pos('0.1.', InstalledVersion) = 1 then exit;
  if not CompareReleaseVersions(CurrentReleaseVersion, InstalledVersion, VersionComparison) then begin
    ReportSetupError('无法安全识别已安装的 CC-Fix 版本（' + InstalledVersion + '），已停止覆盖安装。');
    Result := False;
    exit;
  end;
  if VersionComparison < 0 then begin
    ReportSetupError('已安装 CC-Fix ' + InstalledVersion + '，不能用较旧的 ' + CurrentReleaseVersion + ' 覆盖。请先保留状态卸载较新版本。');
    Result := False;
    exit;
  end;
  Launcher := AddBackslash(Location) + 'bin\cc-fix.cmd';
  if not FileExists(Launcher) then begin Result := False; exit; end;
  { issue #55：执行 HKCU 记录的启动器前先核验注册表一致性与安装布局，防止单值篡改把升级/修复流程导向未知程序。 }
  if not TrustedInstallRecord(Location) then begin
    ReportSetupError('CC-Fix 的安装记录（注册表或安装布局）不一致，已停止升级/修复以避免执行未知程序。请先通过「设置-应用」完整卸载，再重新安装。');
    Result := False;
    exit;
  end;
  Parameters := '/D /S /C ""' + Launcher + '" persist preflight"';
  Result := Exec(ExpandConstant('{cmd}'), Parameters, Location, SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then
    ReportSetupError('当前有未完成的 CC-Fix 恢复事务，已停止升级/修复。请先运行 cc-fix persist recover。');
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
  OriginallyPresent: Boolean;
begin
  OriginallyPresent := RegValueExists(HKCU, 'Environment', 'Path');
  RegQueryStringValue(HKCU, 'Environment', 'Path', Value);
  if not PathContains(Value, Entry) then begin
    if not RegValueExists(HKCU, InstallerStateKey, 'PathOwned') then begin
      RegWriteStringValue(HKCU, InstallerStateKey, 'OriginalUserPath', Value);
      RegWriteDWordValue(HKCU, InstallerStateKey, 'OriginalPathPresent', Ord(OriginallyPresent));
      RegWriteDWordValue(HKCU, InstallerStateKey, 'PathOwned', 1);
    end;
    if Value <> '' then
      if Value[Length(Value)] <> ';' then Value := Value + ';';
    RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Value + Entry);
  end else if not RegValueExists(HKCU, InstallerStateKey, 'PathOwned') then begin
    { A pre-existing matching segment is not owned by CC-Fix. }
    RegWriteDWordValue(HKCU, InstallerStateKey, 'PathOwned', 0);
  end;
end;

procedure RemoveUserPath(Entry: String);
var
  Value, Original, InstalledPrefix, Suffix, Remaining, Part, Updated: String;
  Separator: Integer;
  Owned, OriginallyPresent: Cardinal;
begin
  if RegQueryDWordValue(HKCU, InstallerStateKey, 'PathOwned', Owned) then begin
    if Owned = 0 then exit;
    if RegQueryStringValue(HKCU, InstallerStateKey, 'OriginalUserPath', Original) and
       RegQueryDWordValue(HKCU, InstallerStateKey, 'OriginalPathPresent', OriginallyPresent) then begin
      InstalledPrefix := Original;
      if (InstalledPrefix <> '') and (InstalledPrefix[Length(InstalledPrefix)] <> ';') then
        InstalledPrefix := InstalledPrefix + ';';
      InstalledPrefix := InstalledPrefix + Entry;
      if RegQueryStringValue(HKCU, 'Environment', 'Path', Value) and
         (CompareText(Copy(Value, 1, Length(InstalledPrefix)), InstalledPrefix) = 0) and
         ((Length(Value) = Length(InstalledPrefix)) or (Value[Length(InstalledPrefix) + 1] = ';')) then begin
        Suffix := Copy(Value, Length(InstalledPrefix) + 1, MaxInt);
        if (Suffix <> '') and ((Original = '') or (Original[Length(Original)] = ';')) then
          Delete(Suffix, 1, 1);
        if (OriginallyPresent = 0) and (Original = '') and (Suffix = '') then
          RegDeleteValue(HKCU, 'Environment', 'Path')
        else
          RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Original + Suffix);
        exit;
      end;
    end;
  end;

  { Compatibility fallback for installs created before ownership metadata existed. }
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
  if CurUninstallStep = usPostUninstall then begin
    RemoveUserPath(ExpandConstant('{app}\bin'));
    RegDeleteKeyIncludingSubkeys(HKCU, InstallerStateKey);
  end;
end;

function InitializeUninstall: Boolean;
var
  ResultCode: Integer;
  Parameters: String;
  Index: Integer;
  AppDir: String;
begin
  for Index := 1 to ParamCount do begin
    if CompareText(ParamStr(Index), '/PRESERVESTATE') = 0 then begin
      if not UninstallSilent then
        MsgBox('将仅移除程序并保留全部保护状态和恢复数据。重新安装同版本或更新版本后，请立即运行 cc-fix persist recover 或 persist off。', mbInformation, MB_OK);
      Result := True;
      exit;
    end;
  end;
  // issue #55：{app} 虽来自卸载日志，执行 persist off 前仍核验布局与启动器形状；
  // 核验失败时跳过该步骤（等价 /PRESERVESTATE 语义），绝不执行形状异常的启动器。
  AppDir := ExpandConstant('{app}');
  if not InstallLayoutLooksLegit(AppDir) or not LauncherLooksLegit(AppDir) then begin
    if not UninstallSilent then
      MsgBox('CC-Fix 安装布局不完整或启动器形状异常，已跳过「还原日常配置」步骤。程序文件仍将移除；如需还原系统设置，请重新安装后运行 cc-fix persist recover。', mbInformation, MB_OK);
    Result := True;
    exit;
  end;
  Parameters := '/D /S /C ""' + AppDir + '\bin\cc-fix.cmd" persist off"';
  Result := Exec(ExpandConstant('{cmd}'), Parameters, AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if (not Result) and (not UninstallSilent) then
    MsgBox('CC-Fix 无法完整还原日常配置，因此已停止卸载。请运行 cc-fix persist recover，确认状态健康后再卸载。', mbError, MB_OK);
end;
