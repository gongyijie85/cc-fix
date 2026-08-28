import { randomUUID } from 'node:crypto';
import { DurableFileError, readCheckedFile, writeCheckedFile, type DurableFileSystem } from './durable-file.js';
import type { JsonValue } from './checksum.js';
import { isProtectionState, type ProtectionState } from './schema.js';
import type { RegionCode } from '../domain/region.js';
import type { BrowserPolicySlotId } from './schema.js';

export const TRANSACTION_JOURNAL_SCHEMA = 'cc-fix-transaction-journal-v1';
/** 快照值文件 schema（issue #59）：steps 的 original/desired 在 plan 时一次性落盘，
 * 随后的 phase 转换只重写 journal.json 的 phase 表，不再全量携带快照值。 */
export const TRANSACTION_JOURNAL_VALUES_SCHEMA = 'cc-fix-transaction-journal-values-v1';
export type JournalPhase = 'planned' | 'applying' | 'verified' | 'compensating' | 'compensated' | 'recovery_required';
export type JournalStep = { id: string; phase: JournalPhase; original?: JsonValue; desired?: JsonValue };
export type JournalProtectionTarget = { mode: 'standard' | 'deep'; region: RegionCode };
export type TransactionJournalContext = Readonly<{
  previousState: {
    committedTarget: JournalProtectionTarget | null;
    preferredRegion: RegionCode;
    health: 'healthy' | 'degraded' | 'recovery_required';
    degradation: Array<{
      kind: 'browser_policy_unaligned';
      slot: BrowserPolicySlotId;
      cause: 'access_denied';
    }>;
  };
  requestedTarget: JournalProtectionTarget | null;
}>;
export type TransactionJournal = {
  transactionId: string;
  kind: 'protect' | 'restore';
  steps: JournalStep[];
  context?: TransactionJournalContext;
};

export type JournalRecoveryAction = 'reverse_compensation' | 'forward_restore' | 'none';

const legalTransitions: Readonly<Record<JournalPhase, readonly JournalPhase[]>> = {
  planned: ['applying', 'compensated', 'recovery_required'],
  applying: ['verified', 'compensating', 'recovery_required'],
  verified: ['applying', 'compensating', 'recovery_required'],
  compensating: ['compensated', 'recovery_required'],
  compensated: [],
  recovery_required: ['applying', 'compensating'],
};

/** Crash recovery is deterministic from kind plus durable per-step phase. */
export function recoveryAction(journal: TransactionJournal): JournalRecoveryAction {
  if (journal.steps.every((step) => step.phase === 'verified' || step.phase === 'compensated')) return 'none';
  return journal.kind === 'protect' ? 'reverse_compensation' : 'forward_restore';
}

function validJournal(value: JsonValue): value is TransactionJournal {
  const structurallyValid = typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.transactionId === 'string' && (value.kind === 'protect' || value.kind === 'restore')
    && Array.isArray(value.steps) && value.steps.every((step) => typeof step === 'object' && step !== null && !Array.isArray(step)
      && typeof step.id === 'string' && ['planned','applying','verified','compensating','compensated','recovery_required'].includes(String(step.phase)))
    && (value.context === undefined || validContext(value.context));
  if (!structurallyValid) return false;
  const journal = value as unknown as TransactionJournal;
  return journal.context === undefined ||
    (journal.kind === 'protect' ? journal.context.requestedTarget !== null : journal.context.requestedTarget === null);
}

function validContext(value: unknown): value is TransactionJournalContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  if (Object.keys(context).sort().join(',') !== 'previousState,requestedTarget') return false;
  if (typeof context.previousState !== 'object' || context.previousState === null || Array.isArray(context.previousState)) return false;
  const previous = context.previousState as Record<string, unknown>;
  if (Object.keys(previous).sort().join(',') !== 'committedTarget,degradation,health,preferredRegion') return false;
  const probe: ProtectionState = {
    schemaVersion: 1,
    revision: 0,
    committedTarget: previous.committedTarget as ProtectionState['committedTarget'],
    preferredRegion: previous.preferredRegion as ProtectionState['preferredRegion'],
    health: previous.health as ProtectionState['health'],
    degradation: previous.degradation as ProtectionState['degradation'],
    activeTransactionId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (!isProtectionState(probe)) return false;
  const targetProbe = { ...probe, committedTarget: context.requestedTarget };
  return context.requestedTarget === null || isProtectionState(targetProbe);
}

export type JournalReadResult = Readonly<{
  journal: TransactionJournal | undefined;
  /**
   * true = current 代损坏、内容来自 .prev 回退（issue #57）。.prev 是**旧**代：
   * 其中的 phase 只可能滞后于崩溃现场——恢复决策必须按最保守方向解释
   * （planned 视为"可能已写入"），绝不能据其跳过补偿写回。
   */
  degraded: boolean;
}>;

export class TransactionJournalRepository {
  constructor(private readonly root: string, private readonly path: string, private readonly filesystem?: DurableFileSystem) {}

  private get valuesPath(): string {
    return `${this.path}.values`;
  }

  /** 从 journal.json 读 phase 表，缺失值步骤从 values 文件补全（issue #59）。
   * 旧格式（单文件带值）直接返回；新格式无值步骤需匹配的 values 文件，缺失即视为损坏。 */
  private async mergeValues(journal: TransactionJournal): Promise<TransactionJournal> {
    if (journal.steps.some((step) => step.original !== undefined || step.desired !== undefined)) {
      return journal; // 旧格式：值内嵌于 steps
    }
    const valuesResult = await readCheckedFile<JsonValue>({
      stateRoot: this.root,
      filePath: this.valuesPath,
      schema: TRANSACTION_JOURNAL_VALUES_SCHEMA,
      ...(this.filesystem === undefined ? {} : { filesystem: this.filesystem }),
      validatePayload: validJournalValues,
    });
    if (valuesResult.kind !== 'ok') {
      throw new DurableFileError('CORRUPT', 'Journal phase table exists but its values snapshot is missing or invalid');
    }
    const doc = valuesResult.payload as unknown as JournalValuesDocument;
    if (doc.transactionId !== journal.transactionId) {
      throw new DurableFileError('CORRUPT', 'Journal values snapshot belongs to a different transaction');
    }
    return { ...journal, steps: journal.steps.map((step) => ({ ...step, ...(doc.values[step.id] ?? {}) })) };
  }

  async read(): Promise<TransactionJournal | undefined> {
    return (await this.readWithDegradation()).journal;
  }
  async readWithDegradation(): Promise<JournalReadResult> {
    const result = await readCheckedFile<TransactionJournal>({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, ...(this.filesystem === undefined ? {} : { filesystem: this.filesystem }), validatePayload: validJournal });
    if (result.kind === 'missing') return { journal: undefined, degraded: false };
    return { journal: await this.mergeValues(result.payload), degraded: result.degraded === true };
  }

  /** plan 拆两步：先写 values 快照（含完整 original/desired），再写 phase 表（剥值）。
   * 崩溃窗口安全：values 写完 journal 未写 → journal 缺失，下次 plan 以新 transactionId 覆盖；
   * journal 写完 values 未写不可能（values 先写）。 */
  async plan(
    kind: TransactionJournal['kind'],
    steps: readonly (string | Readonly<{ id: string; original?: JsonValue; desired?: JsonValue }>)[],
    context?: TransactionJournalContext,
  ): Promise<TransactionJournal> {
    const ids = steps.map((step) => typeof step === 'string' ? step : step.id);
    if (new Set(ids).size !== ids.length) throw new Error('A journal plan needs unique steps');
    const existing = await this.read();
    if (existing !== undefined && recoveryAction(existing) !== 'none') {
      throw new Error('An unfinished transaction requires recovery before a new plan');
    }
    if (context !== undefined && !validContext(context)) throw new Error('Journal context is invalid');
    const transactionId = randomUUID();
    const values: Record<string, { original?: JsonValue; desired?: JsonValue }> = {};
    for (const step of steps) {
      if (typeof step === 'string') continue;
      values[step.id] = {
        ...(step.original === undefined ? {} : { original: step.original }),
        ...(step.desired === undefined ? {} : { desired: step.desired }),
      };
    }
    const valuesDocument: JournalValuesDocument = { transactionId, values };
    await writeCheckedFile({ stateRoot: this.root, filePath: this.valuesPath, schema: TRANSACTION_JOURNAL_VALUES_SCHEMA, ...(this.filesystem === undefined ? {} : { filesystem: this.filesystem }), payload: valuesDocument as never, validatePayload: validJournalValues });
    const journal: TransactionJournal = {
      transactionId,
      kind,
      steps: steps.map((step) => typeof step === 'string' ? ({ id: step, phase: 'planned' }) : ({ id: step.id, phase: 'planned' })),
      ...(context === undefined ? {} : { context: structuredClone(context) }),
    };
    await writeCheckedFile({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, ...(this.filesystem === undefined ? {} : { filesystem: this.filesystem }), payload: journal, validatePayload: validJournal });
    return this.mergeValues(journal);
  }

  async transition(journal: TransactionJournal, id: string, phase: JournalPhase): Promise<TransactionJournal> {
    const index = journal.steps.findIndex((step) => step.id === id);
    if (index < 0) throw new Error('Journal step is not planned');
    if (!legalTransitions[journal.steps[index]!.phase].includes(phase)) {
      throw new Error(`Illegal journal transition: ${journal.steps[index]!.phase} -> ${phase}`);
    }
    // issue #59：写盘只落 phase 表（剥去快照值），避免每次转换全量重写系统配置
    const stripped: TransactionJournal = { ...journal, steps: journal.steps.map((step, i) => i === index ? { id: step.id, phase } : { id: step.id, phase: step.phase }) };
    await writeCheckedFile({ stateRoot: this.root, filePath: this.path, schema: TRANSACTION_JOURNAL_SCHEMA, ...(this.filesystem === undefined ? {} : { filesystem: this.filesystem }), payload: stripped, validatePayload: validJournal });
    return { ...journal, steps: journal.steps.map((step, i) => i === index ? { ...step, phase } : { ...step }) };
  }
}

/** 快照值文件形状：transactionId + 每步 original/desired。 */
export type JournalValuesDocument = Readonly<{
  transactionId: string;
  values: Readonly<Record<string, { original?: JsonValue; desired?: JsonValue }>>;
}>;

function validJournalValues(value: JsonValue): value is JournalValuesDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as JournalValuesDocument).transactionId === 'string'
    && typeof (value as JournalValuesDocument).values === 'object'
    && (value as JournalValuesDocument).values !== null;
}
