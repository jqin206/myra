import type { Queryable } from "./db.js";
import {
  claimMessage,
  finishMessage,
  recentUserMessages,
  recordCreaoRun,
  upsertUser,
} from "./db.js";
import { CreaoError, type CreaoOutcome } from "./creao.js";
import { ERROR_REPLY, INTERIM_REPLY, TEXT_ONLY_REPLY, formatReply } from "./format.js";
import type { Incoming } from "./incoming.js";
import { errorCode, log } from "./log.js";
import { buildRequestText } from "./requestText.js";

export interface Sender {
  send(reply: { spaceId: string; senderId: string; parentMessageId: string; text: string; idempotencyKey: string }): Promise<void>;
}

export interface Planner {
  run(input: { request: string; temp_unit: string }, signal: AbortSignal): Promise<CreaoOutcome>;
}

export interface HandlerDeps {
  db: Queryable;
  sender: Sender;
  planner: Planner;
  owner: string;
  defaultTimezone: string;
  defaultTempUnit: string;
  interimAfterMs: number;
  timeoutMs: number;
  leaseSeconds?: number;
  claimRetryMs?: number;
  now?: () => Date;
}

/**
 * Handles one incoming message end to end. Resolves only once the reply has
 * been sent and recorded, so the caller can safely checkpoint the cursor.
 */
export async function handleIncoming(msg: Incoming, deps: HandlerDeps): Promise<void> {
  const leaseSeconds = deps.leaseSeconds ?? Math.ceil(deps.timeoutMs / 1000) + 60;
  const fields = { messageId: msg.messageId, spaceId: msg.spaceId };

  // Another instance may own a fresh claim (overlapping deploy); wait for it to finish or expire.
  for (;;) {
    const claim = await claimMessage(deps.db, msg.messageId, msg.spaceId, deps.owner, leaseSeconds);
    if (claim === "done") {
      log.info("skip_duplicate", fields);
      return;
    }
    if (claim === "claimed") break;
    await new Promise((r) => setTimeout(r, deps.claimRetryMs ?? 2000));
  }

  const reply = (text: string, idempotencyKey: string) =>
    deps.sender.send({
      spaceId: msg.spaceId,
      senderId: msg.senderId,
      parentMessageId: msg.messageId,
      text,
      idempotencyKey,
    });

  const user = await upsertUser(deps.db, msg.spaceId, msg.senderHandle);

  if (msg.kind === "non_text") {
    await reply(TEXT_ONLY_REPLY, `reply:${msg.messageId}`);
    await finishMessage(deps.db, msg.messageId, "replied");
    log.info("replied_non_text", fields);
    return;
  }

  const timeZone = user.timezone ?? deps.defaultTimezone;
  const history = await recentUserMessages(deps.db, msg.spaceId, msg.messageId, msg.createdAt);
  const request = buildRequestText({ now: deps.now?.() ?? new Date(), timeZone, history, current: msg.text });

  const started = performance.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new CreaoError("timeout")), deps.timeoutMs);
  let interim: Promise<void> | undefined;
  const interimTimer = setTimeout(() => {
    interim = reply(INTERIM_REPLY, `reply:${msg.messageId}:interim`).catch((error) => {
      log.warn("interim_send_failed", { ...fields, error: errorCode(error) });
    });
  }, deps.interimAfterMs);

  let texts: string[];
  let outcome: CreaoOutcome | undefined;
  let status = "completed";
  try {
    outcome = await deps.planner.run({ request, temp_unit: user.tempUnit ?? deps.defaultTempUnit }, controller.signal);
    texts = formatReply(outcome.plan);
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    status = reason instanceof CreaoError ? reason.code : errorCode(reason);
    outcome = { plan: {}, runId: error instanceof CreaoError ? error.runId : undefined };
    texts = [ERROR_REPLY];
    log.warn("creao_failed", { ...fields, status, runId: outcome.runId });
  } finally {
    clearTimeout(deadline);
    clearTimeout(interimTimer);
  }
  const latencyMs = performance.now() - started;
  await interim;

  await recordCreaoRun(deps.db, {
    spaceId: msg.spaceId,
    messageId: msg.messageId,
    runId: outcome.runId,
    conversationId: outcome.conversationId,
    status,
    latencyMs,
  });

  for (const [i, text] of texts.entries()) {
    await reply(text, i === 0 ? `reply:${msg.messageId}` : `reply:${msg.messageId}:${i + 1}`);
  }
  await finishMessage(deps.db, msg.messageId, "replied", {
    spaceId: msg.spaceId,
    text: msg.text,
    createdAt: msg.createdAt,
  });
  log.info("replied", { ...fields, status, parts: texts.length, latencyMs: Math.round(latencyMs), runId: outcome.runId });
}
