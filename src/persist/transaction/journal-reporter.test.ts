import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransactionJournalRepository } from '../../state/journal.js';
import { createJournalReporter } from './internal/journal-reporter.js';
describe('journal reporter', () => {
  it('persists phase updates rather than retaining them only in memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-fix-reporter-'));
    const repository = new TransactionJournalRepository(root, join(root, 'transaction-journal.json'));
    const reporter = createJournalReporter(repository, await repository.plan('protect', ['environment']));
    await reporter.transition('environment', 'applying');
    expect((await repository.read())?.steps[0]?.phase).toBe('applying');
  });
});