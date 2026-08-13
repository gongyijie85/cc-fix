import { describe, expect, it } from 'vitest';
import { GuiSession } from './session.js';

describe('GUI localhost session', () => {
  it('uses distinct high-entropy bootstrap and cookie secrets', () => {
    const session = new GuiSession();
    expect(session.bootstrapToken).not.toBe(session.sessionId);
    expect(session.bootstrapToken.length).toBeGreaterThanOrEqual(32);
    expect(session.sessionId.length).toBeGreaterThanOrEqual(32);
  });
});
