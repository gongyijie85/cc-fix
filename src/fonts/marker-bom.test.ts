import { describe, expect, it } from 'vitest';
import { parsePrivilegedMarker } from './service.js';

describe('privileged marker parsing (BOM regression)', () => {
  it('accepts a BOM-prefixed marker written by Windows PowerShell 5.1', () => {
    const text = String.fromCharCode(0xFEFF) + JSON.stringify({ ok: true, pendingReboot: ['msyh.ttc'] });
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(parsePrivilegedMarker(text)).toEqual({ ok: true, pendingReboot: ['msyh.ttc'], scheduledDeleteNames: ['msyh.ttc'] });
  });

  it('still parses BOM-less markers and surfaces errors', () => {
    expect(parsePrivilegedMarker(JSON.stringify({ ok: true, pendingReboot: [] }))).toEqual({ ok: true, pendingReboot: [], scheduledDeleteNames: [] });
    expect(parsePrivilegedMarker(JSON.stringify({ ok: false, error: 'x' }))).toEqual({ ok: false, error: 'x' });
    expect(parsePrivilegedMarker('not json')).toBeUndefined();
  });

  it('rejects forged markers whose nonce does not match (issue #49)', () => {
    const forged = JSON.stringify({ ok: true, pendingReboot: [], nonce: 'attacker-guess' });
    expect(parsePrivilegedMarker(forged, 'real-nonce')).toBeUndefined();
    const authentic = JSON.stringify({ ok: true, pendingReboot: ['msyh.ttc'], nonce: 'real-nonce' });
    expect(parsePrivilegedMarker(String.fromCharCode(0xFEFF) + authentic, 'real-nonce')).toEqual({ ok: true, pendingReboot: ['msyh.ttc'], scheduledDeleteNames: ['msyh.ttc'] });
  });

  it('filters unsafe pendingReboot names and truncates oversized errors (issue #49)', () => {
    const hostile = JSON.stringify({ ok: true, pendingReboot: ['..\\evil.ttc', 'a.ttf.exe', 'msyh.ttc'], nonce: 'n' });
    expect(parsePrivilegedMarker(hostile, 'n')).toEqual({ ok: true, pendingReboot: ['msyh.ttc'], scheduledDeleteNames: ['msyh.ttc'] });
    const longError = JSON.stringify({ ok: false, error: 'x'.repeat(900), nonce: 'n' });
    const parsed = parsePrivilegedMarker(longError, 'n');
    expect(parsed?.ok).toBe(false);
    if (parsed?.ok === false) expect(parsed.error.length).toBeLessThanOrEqual(501);
  });

  it('keeps the owned reboot-delete subset separate from all pending fonts', () => {
    const marker = JSON.stringify({
      ok: true,
      pendingReboot: ['msyh.ttc', 'simsun.ttc'],
      scheduledDeleteNames: ['msyh.ttc', '..\\evil.ttc'],
    });
    expect(parsePrivilegedMarker(marker)).toEqual({
      ok: true,
      pendingReboot: ['msyh.ttc', 'simsun.ttc'],
      scheduledDeleteNames: ['msyh.ttc'],
    });
  });
});
