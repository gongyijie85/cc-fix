import { describe, expect, it } from 'vitest';
import { parsePrivilegedMarker } from './service.js';

describe('privileged marker parsing (BOM regression)', () => {
  it('accepts a BOM-prefixed marker written by Windows PowerShell 5.1', () => {
    const text = String.fromCharCode(0xFEFF) + JSON.stringify({ ok: true, pendingReboot: ['msyh.ttc'] });
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(parsePrivilegedMarker(text)).toEqual({ ok: true, pendingReboot: ['msyh.ttc'] });
  });

  it('still parses BOM-less markers and surfaces errors', () => {
    expect(parsePrivilegedMarker(JSON.stringify({ ok: true, pendingReboot: [] }))).toEqual({ ok: true, pendingReboot: [] });
    expect(parsePrivilegedMarker(JSON.stringify({ ok: false, error: 'x' }))).toEqual({ ok: false, error: 'x' });
    expect(parsePrivilegedMarker('not json')).toBeUndefined();
  });
});
