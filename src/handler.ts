import type { Queryable } from "./db.js";
import {
  claimMessage,
  finishMessage,
  nextInterimIndex,
  lastPlan,
  pendingQuestion,
  recentUserMessages,
  recordCreaoRun,
  saveOnboarding,
  savePlannedDays,
  upcomingDays,
  setTempUnit,
  upsertUser,
} from "./db.js";
import { CreaoError, type CreaoOutcome } from "./creao.js";
import {
  ERROR_REPLY,
  HELP_REPLY,
  interimReply,
  questionFor,
  TEXT_ONLY_REPLY,
  TIMEOUT_REPLY,
  formatReply,
  tempUnitSavedReply,
  type OutfitPlan,
} from "./format.js";
import type { Incoming } from "./incoming.js";
import { errorCode, log } from "./log.js";
import { CLOTHING_QUESTION, ONBOARDED_REPLY, STYLE_QUESTION, isGreetingOnly, onboardingAnswer } from "./onboarding.js";
import { detectTempUnit, isPreferenceOnly } from "./preferences.js";
import { buildRequestText, isoDate, type PlannedDay } from "./requestText.js";

export interface Sender {
  send(reply: { spaceId: string; senderId: string; text: string; idempotencyKey: string }): Promise<void>;
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
  timeoutMs: number;
  interimWaitMs?: number;
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

  // New users answer a couple of questions first; a first message with plans is held and planned once they're done.
  let current = msg.text;
  let heldPlans = false;
  if (user.onboarding !== "done") {
    if (user.onboarding === null) {
      await reply(HELP_REPLY, `reply:${msg.messageId}`);
      await reply(CLOTHING_QUESTION, `reply:${msg.messageId}:2`);
      await saveOnboarding(deps.db, msg.spaceId, { onboarding: "clothing", heldText: isGreetingOnly(msg.text) ? null : msg.text });
      await finishMessage(deps.db, msg.messageId, "replied");
      log.info("onboarding_started", fields);
      return;
    }
    if (user.onboarding === "clothing") {
      await reply(STYLE_QUESTION, `reply:${msg.messageId}`);
      await saveOnboarding(deps.db, msg.spaceId, { onboarding: "style", clothing: onboardingAnswer(msg.text) });
      await finishMessage(deps.db, msg.messageId, "replied");
      log.info("onboarding_clothing", fields);
      return;
    }
    user.style = onboardingAnswer(msg.text);
    await saveOnboarding(deps.db, msg.spaceId, { onboarding: "done", style: user.style, heldText: null });
    if (!user.heldText) {
      await reply(ONBOARDED_REPLY, `reply:${msg.messageId}`);
      await finishMessage(deps.db, msg.messageId, "replied");
      log.info("onboarding_done", fields);
      return;
    }
    current = user.heldText;
    heldPlans = true;
    log.info("onboarding_done", { ...fields, held: true });
  }

  const stored = { spaceId: msg.spaceId, text: current, createdAt: msg.createdAt };
  const unit = heldPlans ? undefined : detectTempUnit(msg.text);
  if (unit) await setTempUnit(deps.db, msg.spaceId, unit);
  if (unit && isPreferenceOnly(msg.text)) {
    await reply(tempUnitSavedReply(unit), `reply:${msg.messageId}`);
    await finishMessage(deps.db, msg.messageId, "replied", stored);
    log.info("replied_preference", fields);
    return;
  }
  const tempUnit = unit ?? user.tempUnit ?? deps.defaultTempUnit;

  const timeZone = user.timezone ?? deps.defaultTimezone;
  const history = await recentUserMessages(deps.db, msg.spaceId, msg.messageId, msg.createdAt);
  const now = deps.now?.() ?? new Date();
  const today = isoDate(now, timeZone);
  const plannedDays = await upcomingDays(deps.db, msg.spaceId, today);
  const latest = await lastPlan<OutfitPlan>(deps.db, msg.spaceId);
  const latestTripDates = planDates(latest).filter((d) => d >= today);
  const asked = await pendingQuestion(deps.db, msg.spaceId);
  const request = buildRequestText({
    now,
    timeZone,
    history,
    current,
    profile: { clothing: user.clothing, style: user.style },
    plannedDays,
    latestTripDates,
    askedLocationFor: asked?.location ? asked.text : undefined,
    askedDateFor: asked?.date ? asked.text : undefined,
  });

  // Sent alongside the Creao run so a slow Photon send never delays planning or the deadline.
  // The index is in the key so a retried message sends its new pun instead of being deduped by Photon.
  const punIndex = await nextInterimIndex(deps.db, msg.spaceId);
  const interim = reply(interimReply(msg.spaceId, punIndex), `reply:${msg.messageId}:interim:${punIndex}`).catch((error) => {
    log.warn("interim_send_failed", { ...fields, error: errorCode(error) });
  });

  const started = performance.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new CreaoError("timeout")), deps.timeoutMs);

  let texts: string[];
  let outcome: CreaoOutcome | undefined;
  let status = "completed";
  try {
    outcome = await deps.planner.run({ request, temp_unit: tempUnit }, controller.signal);
    texts = formatReply(outcome.plan);
    if (heldPlans && texts.length === 1 && texts[0] === HELP_REPLY) texts = [ONBOARDED_REPLY];
    const question = outcome.plan.outfits?.length ? undefined : questionFor(outcome.plan);
    if (question) status = question.status;
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    status = reason instanceof CreaoError ? reason.code : errorCode(reason);
    outcome = { plan: {}, runId: error instanceof CreaoError ? error.runId : undefined };
    texts = [status === "timeout" ? TIMEOUT_REPLY : ERROR_REPLY];
    log.warn("creao_failed", { ...fields, status, runId: outcome.runId });
  } finally {
    clearTimeout(deadline);
  }
  const latencyMs = performance.now() - started;
  // Keep the ack ahead of the answer, but don't let a stalled send hold the reply.
  await Promise.race([interim, new Promise((r) => setTimeout(r, deps.interimWaitMs ?? 10_000).unref())]);

  await recordCreaoRun(deps.db, {
    spaceId: msg.spaceId,
    messageId: msg.messageId,
    runId: outcome.runId,
    conversationId: outcome.conversationId,
    status,
    latencyMs,
    // Only a plan with a date not planned before is a new trip; revisions of planned dates keep the latest trip as is.
    plan: planDates(outcome.plan).some((d) => !plannedDays.some((p) => p.date === d)) ? outcome.plan : undefined,
  });
  await savePlannedDays(deps.db, msg.spaceId, toPlannedDays(outcome.plan));

  for (const [i, text] of texts.entries()) {
    await reply(text, i === 0 ? `reply:${msg.messageId}` : `reply:${msg.messageId}:${i + 1}`);
  }
  await finishMessage(deps.db, msg.messageId, "replied", stored);
  log.info("replied", { ...fields, status, parts: texts.length, latencyMs: Math.round(latencyMs), runId: outcome.runId });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function planDates(plan: OutfitPlan | undefined): string[] {
  const dates = (plan?.outfits ?? []).map((o) => o?.date).filter((d): d is string => !!d && ISO_DATE.test(d));
  return [...new Set(dates)];
}

/** One saved day per outfit date, with that day's weather from `daily_weather` (or the plan's weather for a one-day plan). */
export function toPlannedDays(plan: OutfitPlan): PlannedDay[] {
  const dates = planDates(plan);
  return dates.map((date) => {
    const outfit = plan.outfits!.find((o) => o?.date === date)!;
    const daily = plan.daily_weather?.find((w) => w?.date === date);
    const { date: _d, ...dailyWeather } = daily ?? {};
    const weather = outfit.weather ?? (daily ? dailyWeather : dates.length === 1 ? plan.weather : undefined);
    return { date, location: plan.location, weather, outfit: { activity: outfit.activity, items: outfit.items } };
  });
}
