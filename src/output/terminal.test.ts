// 终端渲染回归测试 — 表格/框线/建议的展示契约（字节级表格语义见 table.test.ts）

import { describe, expect, it, vi } from 'vitest';
import type { CheckResponse } from '../detection/types.js';
import { renderCheckResponse, renderJsonResponse } from './terminal.js';

function allClearResponse(): CheckResponse {
  return {
    score: 0,
    riskLevel: 'low',
    status: 'supported',
    region: 'auto',
    matchedRegion: null,
    signals: [
      { id: 'timezone', label: '系统时区', value: 'America/New_York', score: 0, weight: 25, contribution: 0, source: 'system', risk: 'low' },
      { id: 'fonts', label: '系统字体', value: '未发现中文字体', score: 0, weight: 10, contribution: 0, source: 'system', risk: 'low' },
    ],
    ipIntelligence: null,
    recommendations: [],
  };
}

describe('renderCheckResponse', () => {
  it('输出报告框线与检测表格', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderCheckResponse(allClearResponse());
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('CC-Fix 环境风险检测报告');
      expect(output).toContain('风险评分');
      expect(output).toContain('检测维度: 2 个信号');
      expect(output).toContain('检测信号详情:');
      // 表格宽度与边框（table.ts 的字节级语义；边框按 cell 分段带 ANSI 灰码）
      expect(output).toContain('┌──────────────────');
      expect(output).toContain('┬────────────┐');
      expect(output).toContain('系统时区');
      expect(output).toContain('系统字体');
    } finally {
      log.mockRestore();
    }
  });

  it('无风险时提示环境信号正常', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderCheckResponse(allClearResponse());
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('✅ 环境信号正常，继续保持');
      // score=0 时只走 else 分支，不打印“只检测与提示”行
      expect(output).not.toContain('只检测与提示');
    } finally {
      log.mockRestore();
    }
  });

  it('有可修复信号时输出快速修复建议', () => {
    const response = allClearResponse();
    response.score = 50;
    response.riskLevel = 'medium';
    response.signals = [
      { id: 'timezone', label: '系统时区', value: 'Asia/Shanghai', score: 1, weight: 25, contribution: 25, source: 'system', risk: 'high' },
    ];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderCheckResponse(response);
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('cc-fix persist on');
      expect(output).toContain('命中高危风险 1 个');
    } finally {
      log.mockRestore();
    }
  });

  it('修复建议列表逐项输出', () => {
    const response = allClearResponse();
    response.recommendations = ['建议一', '建议二'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderCheckResponse(response);
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('💡 修复建议:');
      expect(output).toContain('• 建议一');
      expect(output).toContain('• 建议二');
    } finally {
      log.mockRestore();
    }
  });
});

describe('renderJsonResponse', () => {
  it('输出带 schemaVersion 的完整 JSON', () => {
    const response = allClearResponse();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      renderJsonResponse({ schemaVersion: 2, ...response });
      expect(log.mock.calls).toHaveLength(1);
      const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as CheckResponse & { schemaVersion: number };
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.score).toBe(0);
      expect(parsed.signals).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });
});
