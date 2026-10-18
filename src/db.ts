import pg from "pg";
import type { PlannedDay } from "./requestText.js";

export type Queryable = Pick<pg.Pool, "query">;

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        space_id    TEXT PRIMARY KEY,
        handle      TEXT,
        timezone    TEXT,
        temp_unit   TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id  TEXT PRIMARY KEY,
        space_id    TEXT NOT NULL,
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_space_created_idx ON messages (space_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id  TEXT PRIMARY KEY,
        space_id    TEXT,
        status      TEXT NOT NULL,
        claimed_by  TEXT,
        claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS event_cursor (
        consumer    TEXT PRIMARY KEY,
        cursor      BIGINT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS creao_runs (
        id               BIGSERIAL PRIMARY KEY,
        space_id         TEXT NOT NULL,
        message_id       TEXT NOT NULL,
        run_id           TEXT,
        conversation_id  TEXT,
        status           TEXT NOT NULL,
        latency_ms       INTEGER,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS creao_runs_message_idx ON creao_runs (message_id);
    `,
  },
  {
    id: "002_last_plan",
    sql: `
      ALTER TABLE creao_runs ADD COLUMN IF NOT EXISTS plan JSONB;
      CREATE INDEX IF NOT EXISTS creao_runs_space_created_idx ON creao_runs (space_id, created_at DESC);
    `,
  },
  {
    id: "003_planned_days",
    sql: `
      CREATE TABLE IF NOT EXISTS planned_days (
        space_id    TEXT NOT NULL,
        date        DATE NOT NULL,
        location    TEXT,
        weather     JSONB,
        outfit      JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (space_id, date)
      );
    `,
  },
];

/**
 * TLS is verified for remote databases. Railway's private network
 * (`*.railway.internal`) and localhost don't use TLS. Append
 * `sslmode=no-verify` to DATABASE_URL to explicitly opt out of verification.
 */
export function poolSsl(databaseUrl: string): pg.PoolConfig["ssl"] {
  const url = new URL(databaseUrl);
  const mode = url.searchParams.get("sslmode");
  const host = url.hostname;
  if (mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".railway.internal")) return false;
  return { rejectUnauthorized: true };
}

export function createPool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl);
  const ssl = poolSsl(databaseUrl);
  // Our `ssl` option decides TLS; drop sslmode so pg doesn't override it.
  url.searchParams.delete("sslmode");
  return new pg.Pool({ connectionString: url.toString(), max: 10, ssl });
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    for (const m of MIGRATIONS) {
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [m.id]);
      if (done.rowCount) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

export const TERMINAL_STATUSES = ["replied", "ignored"] as const;

export type ClaimResult = "claimed" | "done" | "busy";

/**
 * Claims a message for processing. A row that is still `processing` under
 * another owner is only taken over once its lease has expired, which covers a
 * crashed process and overlapping deploys.
 */
export async function claimMessage(
  db: Queryable,
  messageId: string,
  spaceId: string,
  owner: string,
  leaseSeconds: number,
): Promise<ClaimResult> {
  const res = await db.query<{ message_id: string }>(
    `INSERT INTO processed_messages (message_id, space_id, status, claimed_by, claimed_at)
     VALUES ($1, $2, 'processing', $3, now())
     ON CONFLICT (message_id) DO UPDATE
       SET claimed_by = EXCLUDED.claimed_by, claimed_at = now(), updated_at = now()
       WHERE processed_messages.status = 'processing'
         AND (processed_messages.claimed_by = EXCLUDED.claimed_by
              OR processed_messages.claimed_at < now() - make_interval(secs => $4))
     RETURNING message_id`,
    [messageId, spaceId, owner, leaseSeconds],
  );
  if (res.rowCount) return "claimed";
  const row = await db.query<{ status: string }>("SELECT status FROM processed_messages WHERE message_id = $1", [
    messageId,
  ]);
  return row.rows[0]?.status === "processing" ? "busy" : "done";
}

export async function finishMessage(
  db: Queryable,
  messageId: string,
  status: (typeof TERMINAL_STATUSES)[number],
  record?: { spaceId: string; text: string; createdAt: string },
): Promise<void> {
  if (record) {
    await db.query(
      `INSERT INTO messages (message_id, space_id, text, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, record.spaceId, record.text, record.createdAt],
    );
  }
  await db.query("UPDATE processed_messages SET status = $2, updated_at = now() WHERE message_id = $1", [
    messageId,
    status,
  ]);
}

export async function recentUserMessages(
  db: Queryable,
  spaceId: string,
  excludeMessageId: string,
  before: string,
  limit = 10,
): Promise<string[]> {
  const res = await db.query<{ text: string }>(
    `SELECT text FROM messages
     WHERE space_id = $1 AND message_id <> $2
       AND created_at <= $3 AND created_at > $3::timestamptz - interval '30 days'
     ORDER BY created_at DESC LIMIT $4`,
    [spaceId, excludeMessageId, before, limit],
  );
  return res.rows.map((r) => r.text).reverse();
}

export async function upsertUser(
  db: Queryable,
  spaceId: string,
  handle: string | undefined,
): Promise<{ timezone: string | null; tempUnit: string | null }> {
  const res = await db.query<{ timezone: string | null; temp_unit: string | null }>(
    `INSERT INTO users (space_id, handle) VALUES ($1, $2)
     ON CONFLICT (space_id) DO UPDATE SET handle = COALESCE(EXCLUDED.handle, users.handle), updated_at = now()
     RETURNING timezone, temp_unit`,
    [spaceId, handle ?? null],
  );
  return { timezone: res.rows[0]?.timezone ?? null, tempUnit: res.rows[0]?.temp_unit ?? null };
}

export async function setTempUnit(db: Queryable, spaceId: string, unit: string): Promise<void> {
  await db.query(`UPDATE users SET temp_unit = $2, updated_at = now() WHERE space_id = $1`, [spaceId, unit]);
}

export async function recordCreaoRun(
  db: Queryable,
  run: {
    spaceId: string;
    messageId: string;
    runId?: string;
    conversationId?: string;
    status: string;
    latencyMs: number;
    plan?: object;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO creao_runs (space_id, message_id, run_id, conversation_id, status, latency_ms, plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      run.spaceId,
      run.messageId,
      run.runId ?? null,
      run.conversationId ?? null,
      run.status,
      Math.round(run.latencyMs),
      run.plan ? JSON.stringify(run.plan) : null,
    ],
  );
}

/** The text of the user's last message if Myra answered it, within the last day, by asking where they'll be. */
export async function pendingLocationQuestion(db: Queryable, spaceId: string): Promise<string | undefined> {
  const res = await db.query<{ status: string; text: string | null }>(
    `SELECT r.status, m.text FROM creao_runs r LEFT JOIN messages m ON m.message_id = r.message_id
     WHERE r.space_id = $1 AND r.created_at > now() - interval '1 day'
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [spaceId],
  );
  const row = res.rows[0];
  return row?.status === "needs_location" ? (row.text ?? undefined) : undefined;
}

/** The most recent new-trip plan sent to this user in the last 7 days; its dates are the "most recent trip". */
export async function lastPlan<T = unknown>(db: Queryable, spaceId: string): Promise<T | undefined> {
  const res = await db.query<{ plan: T }>(
    `SELECT plan FROM creao_runs
     WHERE space_id = $1 AND plan IS NOT NULL AND created_at > now() - interval '7 days'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [spaceId],
  );
  return res.rows[0]?.plan;
}

/** The user's saved outfits from `fromDate` (YYYY-MM-DD) on, oldest first. */
export async function upcomingDays(db: Queryable, spaceId: string, fromDate: string, limit = 21): Promise<PlannedDay[]> {
  const res = await db.query<{ date: string; location: string | null; weather: PlannedDay["weather"]; outfit: PlannedDay["outfit"] }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, location, weather, outfit FROM planned_days
     WHERE space_id = $1 AND date >= $2::date ORDER BY date LIMIT $3`,
    [spaceId, fromDate, limit],
  );
  return res.rows;
}

/** Saves (or replaces) each planned day, keyed by date. */
export async function savePlannedDays(db: Queryable, spaceId: string, days: PlannedDay[]): Promise<void> {
  for (const d of days) {
    await db.query(
      `INSERT INTO planned_days (space_id, date, location, weather, outfit) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (space_id, date) DO UPDATE
         SET location = EXCLUDED.location, weather = EXCLUDED.weather, outfit = EXCLUDED.outfit, updated_at = now()`,
      [spaceId, d.date, d.location ?? null, d.weather ? JSON.stringify(d.weather) : null, JSON.stringify(d.outfit)],
    );
  }
}

export async function loadCursor(db: Queryable, consumer: string): Promise<number> {
  const res = await db.query<{ cursor: string }>("SELECT cursor FROM event_cursor WHERE consumer = $1", [consumer]);
  return res.rows[0] ? Number(res.rows[0].cursor) : 0;
}

export async function saveCursor(db: Queryable, consumer: string, cursor: number): Promise<void> {
  await db.query(
    `INSERT INTO event_cursor (consumer, cursor) VALUES ($1, $2)
     ON CONFLICT (consumer) DO UPDATE
       SET cursor = GREATEST(event_cursor.cursor, EXCLUDED.cursor), updated_at = now()`,
    [consumer, cursor],
  );
}

export async function pruneOldMessages(db: Queryable): Promise<number> {
  const res = await db.query("DELETE FROM messages WHERE created_at < now() - interval '30 days'");
  await db.query("UPDATE creao_runs SET plan = NULL WHERE plan IS NOT NULL AND created_at < now() - interval '30 days'");
  await db.query("DELETE FROM planned_days WHERE date < (now() - interval '30 days')::date");
  return res.rowCount ?? 0;
}
