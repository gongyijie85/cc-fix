import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? '').split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf('=');
    return separator < 0 ? [item, ''] : [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

export class GuiSession {
  readonly bootstrapToken: string;
  readonly sessionId: string;
  private bootstrapConsumed = false;

  constructor(bootstrapToken = token(), sessionId = token()) {
    if (bootstrapToken.length < 32 || sessionId.length < 32) throw new Error('GUI session secrets are too short');
    this.bootstrapToken = bootstrapToken;
    this.sessionId = sessionId;
  }

  bootstrap(req: IncomingMessage, res: ServerResponse, candidate: string | null, expectedOrigin: string): boolean {
    if (!this.transportAllowed(req, expectedOrigin) || this.bootstrapConsumed || candidate === null || !equalSecret(candidate, this.bootstrapToken)) return false;
    this.bootstrapConsumed = true;
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': `cc_fix_session=${this.sessionId}; HttpOnly; SameSite=Strict; Path=/`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  authorize(req: IncomingMessage, expectedOrigin: string, requireOrigin: boolean): boolean {
    if (!this.transportAllowed(req, expectedOrigin)) return false;
    if (requireOrigin && req.headers.origin !== expectedOrigin) return false;
    return equalSecret(cookies(req.headers.cookie).cc_fix_session ?? '', this.sessionId);
  }

  private transportAllowed(req: IncomingMessage, expectedOrigin: string): boolean {
    const remote = req.socket.remoteAddress;
    if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return false;
    if (req.headers.host !== expectedOrigin.slice('http://'.length)) return false;
    return true;
  }
}
