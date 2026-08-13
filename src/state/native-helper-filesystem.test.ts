import { describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { createNativeHelperFileSystem } from './native-helper-filesystem.js';

describe('native helper filesystem', () => {
  it('allows only the two fixed backup generations and streams expected bytes out of argv', async () => {
    const root = resolve('D:\\Profiles\\Me\\AppData\\Roaming\\cc-fix');
    const runner = vi.fn(async () => 'deleted' as const);
    const filesystem = createNativeHelperFileSystem({ root, helperPath: 'D:\\Program Files\\CC-Fix\\cc-fix-native-helper.exe', runner });
    await expect(filesystem.compareAndDelete!(join(root, 'persist-backup.json'), 'secret checked bytes')).resolves.toBe('deleted');
    expect(runner).toHaveBeenCalledWith(expect.stringContaining('cc-fix-native-helper.exe'), root, 'persist-backup.json', 'secret checked bytes');
    await expect(filesystem.compareAndDelete!(join(root, 'state.json'), 'x')).rejects.toThrow('fixed backup scope');
    await expect(filesystem.compareAndDelete!(join(root, '..', 'persist-backup.json'), 'x')).rejects.toThrow('fixed backup scope');
  });
});
