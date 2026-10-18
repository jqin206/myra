import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CreaoError } from "../src/creao.js";
import { claimMessage, loadCursor, migrate, saveCursor } from "../src/db.js";
import { ERROR_REPLY, LOCATION_REPLY, interimReply, TEXT_ONLY_REPLY, TIMEOUT_REPLY } from "../src/format.js";
import { handleIncoming, type HandlerDeps, type Planner } from "../src/handler.js";
import type { IncomingText } from "../src/incoming.js";
import example from "./fixtures/creao-example.json" with { type: "json" };

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

type Sent = { text: string; idempotencyKey: string; spaceId: string; senderId: string };

d("dedupe / idempotency (Postgres)", () => {
  let pool: pg.Pool;
  let sent: Sent[];
  let requests: string[];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool);
    await migrate(pool); // idempotent
  });
  afterAll(async () => pool?.end());
  beforeEach(async () => {
    await pool.query("TRUNCATE messages, processed_messages, users, event_cursor, creao_runs, planned_days");
    sent = [];
    requests = [];
  });

  const planner = (impl?: Planner["run"]): Planner => ({
    run: async (input, signal) => {
      requests.push(input.request);
      return impl ? impl(input, signal) : { plan: example, runId: "run_1" };
    },
  });

  const deps = (overrides: Partial<HandlerDeps> = {}): HandlerDeps => ({
    db: pool,
    sender: { send: async (r) => void sent.push(r) },
    planner: planner(),
    owner: "test-a",
    defaultTimezone: "America/Los_Angeles",
    defaultTempUnit: "fahrenheit",
    timeoutMs: 60000,
    claimRetryMs: 10,
    now: () => new Date("2026-10-17T22:48:00Z"),
    ...overrides,
  });

  const msg = (id: string, text = "Austin this Saturday — brunch at 11", createdAt = new Date().toISOString()): IncomingText => ({
    kind: "text",
    messageId: id,
    spaceId: "spc_1",
    senderId: "usr_agent",
    senderHandle: "+15551230000",
    text,
    createdAt,
  });

  it("replies exactly once when the same message is delivered twice", async () => {
    await handleIncoming(msg("m1"), deps());
    await handleIncoming(msg("m1"), deps());
    expect(sent.map((s) => s.idempotencyKey)).toEqual(["reply:m1:interim", "reply:m1"]);
    expect(sent[1]).toMatchObject({ idempotencyKey: "reply:m1", spaceId: "spc_1", senderId: "usr_agent" });
    expect(sent[1]).not.toHaveProperty("parentMessageId");
    expect(requests).toHaveLength(1);
    const runs = await pool.query("SELECT run_id, status FROM creao_runs");
    expect(runs.rows).toEqual([{ run_id: "run_1", status: "completed" }]);
  });

  it("replies once when two workers race on the same message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = planner(async () => {
      await gate;
      return { plan: example };
    });
    const a = handleIncoming(msg("m1"), deps({ planner: slow, owner: "a" }));
    await new Promise((r) => setTimeout(r, 50));
    const b = handleIncoming(msg("m1"), deps({ planner: slow, owner: "b" }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    expect(sent.map((s) => s.idempotencyKey)).toEqual(["reply:m1:interim", "reply:m1"]);
    expect(requests).toHaveLength(1);
  });

  it("re-handles a message whose worker crashed, reusing the same idempotency key", async () => {
    // Simulates a crash after claiming: the row is stuck in `processing` under a dead owner.
    expect(await claimMessage(pool, "m1", "spc_1", "dead-worker", 120)).toBe("claimed");
    await pool.query("UPDATE processed_messages SET claimed_at = now() - interval '10 minutes'");
    await handleIncoming(msg("m1"), deps());
    expect(sent.map((s) => s.idempotencyKey)).toEqual(["reply:m1:interim", "reply:m1"]);
    const row = await pool.query("SELECT status FROM processed_messages WHERE message_id = 'm1'");
    expect(row.rows[0].status).toBe("replied");
  });

  it("does not take over a fresh claim held by another worker", async () => {
    expect(await claimMessage(pool, "m1", "spc_1", "other", 120)).toBe("claimed");
    expect(await claimMessage(pool, "m1", "spc_1", "me", 120)).toBe("busy");
    await pool.query("UPDATE processed_messages SET status = 'replied'");
    expect(await claimMessage(pool, "m1", "spc_1", "me", 120)).toBe("done");
  });

  it("includes earlier user messages (last 30 days) in later requests", async () => {
    const day = 24 * 60 * 60 * 1000;
    await handleIncoming(msg("old", "ancient plan", new Date(Date.now() - 31 * day).toISOString()), deps());
    await handleIncoming(msg("m1", "I run cold", new Date(Date.now() - 60_000).toISOString()), deps());
    await handleIncoming(msg("m2", "actually dinner is on a rooftop"), deps());
    const last = requests.at(-1)!;
    expect(last).toContain('- "I run cold"');
    expect(last).not.toContain("ancient plan");
    expect(last).toContain('Current message:\n"actually dinner is on a rooftop"');
  });

  const day = (date: string, top: string) => ({ date, activity: "Out", items: { top } });
  const nyc = {
    location: "New York, NY",
    daily_weather: [
      { date: "2026-10-24", temp_high: 56, conditions: "Clear" },
      { date: "2026-10-25", temp_high: 59, conditions: "Overcast" },
    ],
    outfits: [day("2026-10-24", "Sweater"), day("2026-10-25", "Knit")],
  };
  const planned = (request: string) =>
    JSON.parse(request.split("Outfits already planned for this user, by date (JSON):\n")[1]!.split("\n")[0]!);
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("saves each planned day and sends them, with the most recent trip, to later requests", async () => {
    await handleIncoming(msg("m1", "NYC next weekend", at(2)), deps({ planner: planner(async () => ({ plan: nyc })) }));
    expect(requests[0]).not.toContain("Outfits already planned");
    await handleIncoming(msg("m2", "no jeans please"), deps());
    expect(planned(requests[1]!)).toEqual([
      { date: "2026-10-24", location: "New York, NY", weather: { temp_high: 56, conditions: "Clear" }, activity: "Out", items: { top: "Sweater" } },
      { date: "2026-10-25", location: "New York, NY", weather: { temp_high: 59, conditions: "Overcast" }, activity: "Out", items: { top: "Knit" } },
    ]);
    expect(requests[1]).toContain("Most recent trip: 2026-10-24, 2026-10-25.");
  });

  it("replaces only the revised day and keeps the most recent trip", async () => {
    await handleIncoming(msg("m1", "NYC next weekend", at(3)), deps({ planner: planner(async () => ({ plan: nyc })) }));
    const revised = { location: "New York, NY", outfits: [day("2026-10-25", "Silk blouse")] };
    await handleIncoming(msg("m2", "dressier on Sunday", at(2)), deps({ planner: planner(async () => ({ plan: revised })) }));
    await handleIncoming(msg("m3", "thanks"), deps());
    expect(planned(requests[2]!).map((d: { items: { top: string } }) => d.items.top)).toEqual(["Sweater", "Silk blouse"]);
    expect(requests[2]).toContain("Most recent trip: 2026-10-24, 2026-10-25.");
  });

  it("doesn't send days before today or save failed runs", async () => {
    await handleIncoming(msg("m1", "NYC next weekend", at(2)), deps({ planner: planner(async () => ({ plan: nyc })) }));
    const failing = planner(async () => {
      throw new CreaoError("failed");
    });
    await handleIncoming(msg("m2", "hello again", at(1)), deps({ planner: failing }));
    await handleIncoming(msg("m3", "no jeans"), deps({ now: () => new Date("2026-10-25T20:00:00Z") }));
    expect(planned(requests.at(-1)!).map((d: { date: string }) => d.date)).toEqual(["2026-10-25"]);
    expect(requests.at(-1)).toContain("Most recent trip: 2026-10-25.");
  });

  it("asks for a location, then points the next request at the message it answers", async () => {
    const asks = planner(async () => ({ plan: { outfits: [], needs_location: true } }));
    await handleIncoming(msg("m1", "dinner Friday", at(3)), deps({ planner: asks }));
    expect(sent.at(-1)!.text).toBe(LOCATION_REPLY);
    const runs = await pool.query("SELECT status FROM creao_runs");
    expect(runs.rows).toEqual([{ status: "needs_location" }]);
    await handleIncoming(msg("m2", "Austin", at(2)), deps());
    expect(requests[1]).toContain(`for their previous message: "dinner Friday"`);
    await handleIncoming(msg("m3", "thanks"), deps());
    expect(requests[2]).not.toContain("You asked this user");
  });

  it("answers non-text messages with the text-only reply", async () => {
    await handleIncoming({ kind: "non_text", messageId: "m1", spaceId: "spc_1", senderId: "usr_agent", createdAt: new Date().toISOString() }, deps());
    expect(sent.map((s) => [s.text, s.idempotencyKey])).toEqual([[TEXT_ONLY_REPLY, "reply:m1"]]);
    expect(requests).toHaveLength(0);
  });

  it("sends the interim message, then the timeout reply when Creao doesn't answer in time", async () => {
    const down = planner(async (_input, signal) => {
      await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      throw new Error("unreachable");
    });
    await handleIncoming(msg("m1"), deps({ planner: down, timeoutMs: 80 }));
    expect(sent.map((s) => [s.text, s.idempotencyKey])).toEqual([
      [interimReply("m1"), "reply:m1:interim"],
      [TIMEOUT_REPLY, "reply:m1"],
    ]);
    const runs = await pool.query("SELECT status FROM creao_runs");
    expect(runs.rows[0].status).toBe("timeout");
  });

  it("sends the friendly error immediately when Creao fails", async () => {
    const failing = planner(async () => {
      throw new CreaoError("http_503", "run_9");
    });
    await handleIncoming(msg("m1"), deps({ planner: failing }));
    expect(sent.map((s) => s.text)).toEqual([interimReply("m1"), ERROR_REPLY]);
  });

  it("starts planning and answers even when the interim send stalls", async () => {
    const stalled: Sent[] = [];
    const sender = {
      send: async (r: Sent) => {
        if (r.idempotencyKey.endsWith(":interim")) return new Promise<void>(() => {});
        stalled.push(r);
      },
    };
    await handleIncoming(msg("m1"), deps({ sender, interimWaitMs: 20 }));
    expect(requests).toHaveLength(1);
    expect(stalled.map((s) => s.idempotencyKey)).toEqual(["reply:m1"]);
  });

  it("sends the interim message before the outfits", async () => {
    await handleIncoming(msg("m1"), deps());
    expect(sent[0]).toMatchObject({ text: interimReply("m1"), idempotencyKey: "reply:m1:interim" });
    expect(sent[1]!.idempotencyKey).toBe("reply:m1");
  });

  it("saves a stated temperature unit and uses it for later requests", async () => {
    const units: string[] = [];
    const p = planner(async (input) => {
      units.push(input.temp_unit);
      return { plan: example };
    });
    await handleIncoming(msg("m1", "use celsius please", new Date(Date.now() - 60_000).toISOString()), deps({ planner: p }));
    expect(sent.map((s) => s.text)).toEqual(["Got it — I'll use Celsius from now on."]);
    expect(units).toEqual([]);
    await handleIncoming(msg("m2", "Austin this Saturday — brunch at 11"), deps({ planner: p }));
    expect(units).toEqual(["celsius"]);
  });

  it("uses reply:<id>:<n> keys for split messages", async () => {
    const long = { ...example, outfits: Array.from({ length: 6 }, (_, i) => ({ ...example.outfits[0], activity: `Stop ${i}`, items: { ...example.outfits[0].items, top: "x".repeat(250) } })) };
    await handleIncoming(msg("m1"), deps({ planner: planner(async () => ({ plan: long })) }));
    expect(sent.length).toBeGreaterThan(2);
    const keys = sent.map((s) => s.idempotencyKey);
    expect(keys[0]).toBe("reply:m1:interim");
    expect(keys.slice(1)).toEqual(keys.slice(1).map((_, i) => (i === 0 ? "reply:m1" : `reply:m1:${i + 1}`)));
  });

  it("only moves the cursor forward", async () => {
    expect(await loadCursor(pool, "c")).toBe(0);
    await saveCursor(pool, "c", 10);
    await saveCursor(pool, "c", 7);
    expect(await loadCursor(pool, "c")).toBe(10);
  });
});
