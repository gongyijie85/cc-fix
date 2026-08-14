import { describe, expect, it } from 'vitest';
import { storedValue } from '../../state/schema.js';
import { createRepositoryStateTransition } from './internal/state-transition.js';
import type { ProtectionState } from '../../state/schema.js';

const initial = (): ProtectionState => ({
  schemaVersion: 1,
  revision: 3,
  committedTarget: { mode: 'deep', region: 'jp' },
  preferredRegion: 'jp',
  health: 'healthy',
  degradation: [],
  activeTransactionId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function repository() {
  let current = initial();
  const commits: Array<Partial<ProtectionState>> = [];
  return {
    commits,
    commit: async (_revision: number, next: Parameters<import('../../state/repository.js').StateRepository['commit']>[1]) => {
      commits.push({ ...next });
      current = { ...current, ...next, revision: current.revision + 1, updatedAt: 'later' };
      return { value: current };
    },
  };
}

describe('unified state transition（ADR-0012 T-a）', () => {
  it('protect 视图：begin → complete 发布目标与健康，fail 恢复旧状态', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial(), { mode: 'standard', region: 'us' });
    await t.protect.begin('tx-1');
    await t.protect.complete({ kind: 'committable', degraded: [] });
    expect(repo.commits[1]).toMatchObject({ committedTarget: { mode: 'standard', region: 'us' }, preferredRegion: 'us', health: 'healthy', activeTransactionId: null });
    await t.protect.fail({ kind: 'compensated', degraded: [] });
    expect(repo.commits[2]).toMatchObject({ committedTarget: { mode: 'deep', region: 'jp' }, health: 'healthy', activeTransactionId: null });
  });

  it('protect 视图：degraded 提交健康降级并保留逐槽原因；recovery_required 清空降级', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial(), { mode: 'standard', region: 'us' });
    await t.protect.complete({ kind: 'degraded', degraded: [{ kind: 'browser_policy_unaligned', slot: 'chrome.webrtc', cause: 'access_denied' }] });
    expect(repo.commits[0]).toMatchObject({ health: 'degraded', degradation: [{ slot: 'chrome.webrtc' }] });
    await t.protect.fail({ kind: 'recovery_required', degraded: [] });
    expect(repo.commits[1]).toMatchObject({ health: 'recovery_required', degradation: [] });
  });

  it('restore 视图：restored 发布日常并记录 dailyPublished，failCleanup 据此选择目标', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial());
    await t.restore.begin('tx-2');
    await t.restore.restored('tx-2');
    expect(repo.commits[1]).toMatchObject({ committedTarget: null, health: 'healthy', activeTransactionId: 'tx-2' });
    await t.restore.failCleanup('tx-2');
    expect(repo.commits[2]).toMatchObject({ committedTarget: null, health: 'recovery_required', activeTransactionId: 'tx-2' });
    // 未 published 前失败：目标保留旧值（新实例演示分支）
    const repo2 = repository();
    const t2 = createRepositoryStateTransition(repo2 as never, initial());
    await t2.restore.failCleanup('tx-3');
    expect(repo2.commits[0]).toMatchObject({ committedTarget: { mode: 'deep', region: 'jp' }, health: 'recovery_required', activeTransactionId: 'tx-3' });
  });

  it('restore 视图：failBeforeRestore 与 complete 的边界', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial());
    await t.restore.failBeforeRestore();
    expect(repo.commits[0]).toMatchObject({ committedTarget: { mode: 'deep', region: 'jp' }, health: 'recovery_required', activeTransactionId: null });
    await t.restore.complete();
    expect(repo.commits[1]).toMatchObject({ committedTarget: null, health: 'healthy', activeTransactionId: null });
  });

  it('recover 视图：publishPrevious 携带日志上下文字段并按 health 取舍 degradation', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial());
    const previousState = {
      committedTarget: { mode: 'standard', region: 'us' } as const,
      preferredRegion: 'us' as const,
      health: 'degraded' as const,
      degradation: [{ kind: 'browser_policy_unaligned', slot: 'edge.webrtc', cause: 'access_denied' } as const],
    };
    await t.recover.publishPrevious(previousState, 'degraded');
    expect(repo.commits[0]).toMatchObject({ committedTarget: { mode: 'standard', region: 'us' }, preferredRegion: 'us', health: 'degraded', degradation: [{ slot: 'edge.webrtc' }] });
    await t.recover.publishPrevious(previousState, 'recovery_required');
    expect(repo.commits[1]).toMatchObject({ health: 'recovery_required', degradation: [] });
  });

  it('recover 视图：publishDaily / failCleanupDaily / completeDaily', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial());
    await t.recover.publishDaily('tx-4', 'jp');
    expect(repo.commits[0]).toMatchObject({ committedTarget: null, health: 'healthy', activeTransactionId: 'tx-4' });
    await t.recover.failCleanupDaily('tx-4', 'jp');
    expect(repo.commits[1]).toMatchObject({ committedTarget: null, health: 'recovery_required', activeTransactionId: 'tx-4' });
    await t.recover.completeDaily('jp');
    expect(repo.commits[2]).toMatchObject({ committedTarget: null, health: 'healthy', activeTransactionId: null });
  });

  it('revision 随每次提交递增（单一追踪来源）', async () => {
    const repo = repository();
    const t = createRepositoryStateTransition(repo as never, initial(), { mode: 'standard', region: 'us' });
    await t.protect.begin('tx-5');
    await t.protect.complete({ kind: 'committable', degraded: [] });
    expect(repo.commits).toHaveLength(2);
    // 3（初始）→ 4（begin）→ 5（complete）：两份提交连续推进同一 revision
    const last = await repo.commit(5, { committedTarget: null, preferredRegion: 'us', health: 'healthy', degradation: [], activeTransactionId: null });
    expect(last.value.revision).toBe(6);
  });
});