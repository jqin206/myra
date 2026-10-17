import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { CreaoClient } from "./creao.js";
import { createPool, loadCursor, migrate, pruneOldMessages, saveCursor } from "./db.js";
import { handleIncoming } from "./handler.js";
import { parseIncoming } from "./incoming.js";
import { errorCode, log } from "./log.js";
import { EventStream, createSender } from "./photon.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  log.info("migrations_applied");

  const deps = {
    db: pool,
    sender: createSender({ apiKey: config.photonApiKey, projectId: config.photonProjectId, baseUrl: config.photonApiOrigin }),
    planner: new CreaoClient({ apiKey: config.creaoApiKey, agentId: config.creaoAgentId }),
    owner: `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${randomUUID()}`,
    defaultTimezone: config.defaultTimezone,
    defaultTempUnit: config.defaultTempUnit,
    timeoutMs: config.creaoTimeoutMs,
  };

  const stream = new EventStream({
    apiKey: config.photonApiKey,
    projectId: config.photonProjectId,
    origin: config.photonApiOrigin,
    apiVersion: config.photonApiVersion,
    loadCursor: () => loadCursor(pool, config.cursorConsumer),
    saveCursor: (seq) => saveCursor(pool, config.cursorConsumer, seq),
    keyOf: (event) => parseIncoming(event, config.photonAgentHandle)?.spaceId,
    handle: async (event) => {
      const msg = parseIncoming(event, config.photonAgentHandle);
      if (msg) await handleIncoming(msg, deps);
    },
  });

  const prune = () =>
    pruneOldMessages(pool)
      .then((n) => n && log.info("pruned_messages", { count: n }))
      .catch((error) => log.warn("prune_failed", { error: errorCode(error) }));
  await prune();
  const pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, photonConnected: stream.connected }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.port, () => log.info("http_listening", { port: config.port }));

  await stream.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting_down", { signal });
    clearInterval(pruneTimer);
    server.close();
    await stream.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.error("fatal", { error: errorCode(error), message: error instanceof Error ? error.message : undefined });
  process.exit(1);
});
