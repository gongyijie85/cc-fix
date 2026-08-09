// PROTOTYPE — desktop sidecar entry. Do not ship as production code.
import { startGuiServer } from "./server.js";

const portIndex = process.argv.indexOf("--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("A valid --port is required");
  process.exit(2);
}

const server = await startGuiServer(port);
process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`);

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
