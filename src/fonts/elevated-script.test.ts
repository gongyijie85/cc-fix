import { describe, expect, it } from 'vitest';
import { buildElevationLauncherArgs, composeElevatedFontScript, encodePowerShellCommand } from './elevated-script.js';

const anchor = 'C:\\Users\\user\\AppData\\Roaming\\cc-fix\\font-backup';

function compose(request: Parameters<typeof composeElevatedFontScript>[0]['request']) {
  return composeElevatedFontScript({
    request,
    anchorRoot: anchor,
    markerPath: 'C:\\Users\\user\\AppData\\Roaming\\cc-fix\\font-helper-result-abc.json',
    nonce: 'deadbeef'.repeat(8),
  });
}

describe('elevated font script composition (issue #49)', () => {
  it('never touches disk-based script or args files (-File / reg.exe import 消失)', () => {
    for (const script of [compose({ mode: 'remove', expectedNames: ['msyh.ttc'] }), compose({ mode: 'restore', backupDir: anchor + '\\2026\\fonts', regJsonPath: anchor + '\\2026\\fonts-hklm.json' })]) {
      expect(script).not.toContain('reg.exe import');
      expect(script).not.toContain('-File');
      expect(script).not.toContain('font-helper.ps1');
      expect(script).not.toContain('font-helper-args.json');
    }
  });

  it('embeds the anchor, nonce, marker path and request as read-only literals', () => {
    const script = compose({ mode: 'restore', backupDir: anchor + '\\2026\\fonts', regJsonPath: anchor + '\\2026\\fonts-hklm.json', scheduledDeleteNames: ['msyh.ttc'] });
    expect(script).toContain(`$anchor = '${anchor}\\'`);
    expect(script).toContain("$nonce = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'");
    expect(script).toContain('font-helper-result-abc.json');
    expect(script).toContain(`| ConvertFrom-Json`);
    // 锚定与白名单校验齐全
    expect(script).toContain('Assert-Anchored');
    expect(script).toContain('GetFullPath');
    expect(script).toContain('ReparsePoint');
    expect(script).toContain('unsafe registry value name');
    expect(script).toContain('unsafe registry value data');
    expect(script).toContain('New-ItemProperty -Path $fontKey');
    expect(script).toContain('scheduledDeleteNames');
    expect(script).toContain('PendingFileRenameOperations');
    expect(script).toContain('$ownedDeleteSources');
    expect(script).toContain('$existingDeleteSources');
    expect(script).toContain('Set-ItemProperty $key -Name PendingFileRenameOperations -Value ($existing + $entries) -Type MultiString -ErrorAction Stop');
    expect(script).toContain('$ownedDeleteSources[$sourceKey]--');
    expect(script).toContain('-ErrorAction Stop');
    expect(script).not.toContain('Remove-ItemProperty $key -Name PendingFileRenameOperations -ErrorAction SilentlyContinue');
    // nonce 随 marker 写出
    expect(script).toContain('$m.nonce = $nonce');
  });

  it('enumerates the removal list inside the elevated context from the shared catalog', () => {
    const script = compose({ mode: 'remove', expectedNames: ['msyh.ttc', 'simsun.ttc'] });
    expect(script).toContain('Get-ChildItem -LiteralPath $fontsDir');
    expect(script).toMatch(/msyh/);
    expect(script).toMatch(/simsun/);
    expect(script).toContain('expectedNames');
    expect(script).toContain('font inventory changed after backup');
  });

  it('refuses reparse points and directories before deleting from the fonts dir (#92)', () => {
    const removeScript = compose({ mode: 'remove', expectedNames: ['msyh.ttc'] });
    // remove 与 restore 同样在删除/复制前拒绝 reparse point；remove 额外拒绝目录
    expect(removeScript).toContain('reparse point in backup');
    expect(removeScript).toContain('reparse point in fonts dir');
    expect(removeScript).toContain('unexpected directory in fonts dir');
    expect(removeScript).toContain('Get-Item -LiteralPath $full -Force -ErrorAction Stop');
    expect(removeScript).toContain('$item.Attributes -band [IO.FileAttributes]::ReparsePoint');
    expect(removeScript).toContain('$item.PSIsContainer');
    // 守卫必须在 Remove-Item 之前出现
    const deleteIndex = removeScript.indexOf('Remove-Item -LiteralPath $full');
    const guardIndex = removeScript.indexOf('reparse point in fonts dir');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(guardIndex);
  });

  it('escapes single quotes in embedded literals', () => {
    const script = composeElevatedFontScript({
      request: { mode: 'restore', backupDir: "C:\\dir with ' quote\\fonts" },
      anchorRoot: anchor,
      markerPath: 'C:\\m.json',
      nonce: 'n',
    });
    // 参数经 JSON 内嵌：路径里的单引号在 PS 单引号字符串中转义为 ''
    expect(script).toContain('"backupDir":"C:\\\\dir with \'\' quote\\\\fonts"');
  });

  it('builds a launcher argv well under the Windows command-line limit', () => {
    const script = compose({ mode: 'restore', backupDir: anchor + '\\2026\\fonts', regJsonPath: anchor + '\\2026\\fonts-hklm.json' });
    const argv = buildElevationLauncherArgs(script);
    expect(argv.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const total = argv.join(' ').length;
    expect(total).toBeLessThan(28_000);
    // 内层 base64 经 UTF-16LE 编码可无损往返（EncodedCommand 约定）
    const inner = /-EncodedCommand','([A-Za-z0-9+/=]+)'\)/.exec(argv[3]!)!;
    expect(inner).not.toBeNull();
    expect(Buffer.from(inner[1]!, 'base64').toString('utf16le')).toBe(script);
  });

  it('round-trips the script through the encoded command transport', () => {
    const script = compose({ mode: 'remove', expectedNames: ['msyh.ttc'] });
    expect(Buffer.from(encodePowerShellCommand(script), 'base64').toString('utf16le')).toBe(script);
  });

  it('updates the Windows font resource table and broadcasts WM_FONTCHANGE', () => {
    const removeScript = compose({ mode: 'remove', expectedNames: ['msyh.ttc'] });
    const restoreScript = compose({ mode: 'restore', backupDir: anchor + '\\2026\\fonts' });
    for (const script of [removeScript, restoreScript]) {
      expect(script).toContain('WM_FONTCHANGE');
      expect(script).toContain('SendMessageTimeout');
    }
    expect(removeScript).toContain('RemoveFontResource');
    expect(restoreScript).toContain('AddFontResource');
  });
});
