// 状态路径构造测试 — 校验绝对字面路径与 .. 拒绝

import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { statePaths, defaultPersistRoot } from './paths.js';

describe('statePaths', () => {
  it('由绝对根目录推导全部状态文件路径', () => {
    const root = 'C:\\Users\\demo\\AppData\\Roaming\\cc-fix';
    const paths = statePaths(root);
    expect(paths.state).toBe(join(root, 'state.json'));
    expect(paths.backup).toBe(join(root, 'persist-backup.json'));
    expect(paths.migrationEvidence).toBe(join(root, 'migration-evidence'));
    expect(paths.journal).toBe(join(root, 'transaction-journal.json'));
    expect(paths.lock).toBe(join(root, 'mutation.lock'));
  });

  it('POSIX 风格根目录同样接受', () => {
    const root = '/home/demo/.config/cc-fix';
    const paths = statePaths(root);
    expect(paths.state).toBe(join(root, 'state.json'));
  });

  it('相对路径被拒绝', () => {
    expect(() => statePaths('relative/path')).toThrow(TypeError);
    expect(() => statePaths('.\\appdata\\cc-fix')).toThrow(TypeError);
  });

  it('含 .. 段的路径被拒绝', () => {
    expect(() => statePaths('C:\\Users\\demo\\..\\evil')).toThrow(TypeError);
    expect(() => statePaths('C:\\Users\\demo\\foo\\..\\..\\..\\evil')).toThrow(TypeError);
    expect(() => statePaths('/home/demo/../../../etc')).toThrow(TypeError);
  });
});

describe('defaultPersistRoot', () => {
  it('优先使用 APPDATA', () => {
    expect(defaultPersistRoot({ APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' })).toBe('C:\\Users\\demo\\AppData\\Roaming\\cc-fix');
  });

  it('缺失 APPDATA 时回落家目录', () => {
    const root = defaultPersistRoot({});
    expect(root).toBe(join(homedir(), 'AppData', 'Roaming', 'cc-fix'));
  });

  it('默认使用进程环境（通常含 APPDATA）', () => {
    const root = defaultPersistRoot();
    expect(typeof root).toBe('string');
    expect(root.endsWith('cc-fix')).toBe(true);
  });
});

describe('statePaths 与临时目录', () => {
  it('临时目录（无 ..）可用作状态根', () => {
    const root = join(tmpdir(), 'cc-fix-paths-probe');
    const paths = statePaths(root);
    expect(paths.state.startsWith(root)).toBe(true);
  });
});
