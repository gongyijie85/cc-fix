import { startGuiServer } from './server.js';
import { GuiSession } from './session.js';

const token = process.env.CC_FIX_GUI_TOKEN;
const sessionId = process.env.CC_FIX_GUI_SESSION_ID;
if (token === undefined || sessionId === undefined) {
  process.stderr.write('Desktop GUI sidecar requires an authenticated session\n');
  process.exit(2);
}

const session = new GuiSession(token, sessionId);
const server = await startGuiServer(0, { session });
process.stdout.write(`${JSON.stringify({ type: 'ready', sessionId, url: server.bootstrapUrl() })}\n`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close((error) => process.exit(error === undefined ? 0 : 1));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
