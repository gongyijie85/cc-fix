import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { composeElevatedFontScript, encodePowerShellCommand } from './elevated-script.js';

// 真实 PowerShell 冒烟（issue #49）：非提权运行组装出的脚本，验证
// PS 5.1 语法可执行、锚定校验工作、错误路径正确写 nonce marker。
// 不触发 UAC、不碰真实系统（Copy-Item 到 Fonts 因权限失败 → 走 catch）。
describe.skipIf(process.platform !== 'win32')('elevated script real-PowerShell smoke', () => {
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  async function fixture() {
    const stateRoot = await mkdtemp(join(tmpdir(), 'ccfix-font-smoke-'));
    roots.push(stateRoot);
    const anchorRoot = resolve(join(stateRoot, 'font-backup'));
    const backupDir = join(anchorRoot, '2026', 'fonts');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(backupDir, 'msyh.ttc'), 'fake', 'utf8');
    await writeFile(
      join(anchorRoot, '2026', 'fonts-hklm.json'),
      JSON.stringify({ version: 1, entries: { 'YaHei (TrueType)': 'msyh.ttc' } }),
      'utf8',
    );
    return { stateRoot, anchorRoot, backupDir, regJsonPath: join(anchorRoot, '2026', 'fonts-hklm.json') };
  }

  async function runScript(script: string, stateRoot: string): Promise<Record<string, unknown>> {
    const markerPath = join(stateRoot, 'smoke-marker.json');
    await rm(markerPath, { force: true });
    await new Promise<void>((resolveClose) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(script)], { windowsHide: true });
      child.on('close', () => resolveClose());
    });
    try {
      return JSON.parse((await readFile(markerPath, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch {
      return { missing: true };
    }
  }

  it('executes under PS 5.1, anchors paths and writes the nonce marker on the failure path', async () => {
    const { stateRoot, anchorRoot, backupDir, regJsonPath } = await fixture();
    const nonce = 'smoke-nonce-1';
    const marker = await runScript(composeElevatedFontScript({
      request: { mode: 'restore', backupDir, regJsonPath },
      anchorRoot,
      markerPath: join(stateRoot, 'smoke-marker.json'),
      nonce,
    }), stateRoot);
    // 非提权：Copy-Item 拒绝访问 → ok:false，但脚本本身、锚定与 marker 通道全部工作
    expect(marker.ok).toBe(false);
    expect(marker.nonce).toBe(nonce);
    expect(String(marker.error)).toBeTruthy();
  });

  it('rejects a backup dir and registry json that escape the anchor', async () => {
    const { stateRoot, anchorRoot, backupDir } = await fixture();
    const escapeDir = await runScript(composeElevatedFontScript({
      request: { mode: 'restore', backupDir: 'C:\\Windows\\Temp' },
      anchorRoot,
      markerPath: join(stateRoot, 'smoke-marker.json'),
      nonce: 'n2',
    }), stateRoot);
    expect(escapeDir.ok).toBe(false);
    expect(String(escapeDir.error)).toContain('escapes');

    const escapeReg = await runScript(composeElevatedFontScript({
      request: { mode: 'restore', backupDir, regJsonPath: 'C:\\Windows\\evil.json' },
      anchorRoot,
      markerPath: join(stateRoot, 'smoke-marker.json'),
      nonce: 'n3',
    }), stateRoot);
    expect(escapeReg.ok).toBe(false);
    expect(String(escapeReg.error)).toContain('escapes');
  });
});
