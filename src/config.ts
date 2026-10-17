export interface Config {
  photonApiKey: string;
  photonProjectId: string;
  photonApiOrigin: string;
  photonApiVersion: string | undefined;
  photonAgentHandle: string | undefined;
  creaoApiKey: string;
  creaoAgentId: string;
  databaseUrl: string;
  defaultTimezone: string;
  defaultTempUnit: string;
  port: number;
  creaoTimeoutMs: number;
  interimAfterMs: number;
  cursorConsumer: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function loadConfig(): Config {
  const photonProjectId = required("PHOTON_PROJECT_ID");
  if (!photonProjectId.startsWith("pho_prj_")) throw new Error("PHOTON_PROJECT_ID must start with pho_prj_");
  const defaultTimezone = optional("DEFAULT_TIMEZONE") ?? "America/Los_Angeles";
  new Intl.DateTimeFormat("en-US", { timeZone: defaultTimezone });
  return {
    photonApiKey: required("PHOTON_API_KEY"),
    photonProjectId,
    photonApiOrigin: optional("PHOTON_API_ORIGIN") ?? "https://api.photon.codes",
    photonApiVersion: optional("PHOTON_API_VERSION") ?? "2026-07-01",
    photonAgentHandle: optional("PHOTON_AGENT_HANDLE"),
    creaoApiKey: required("CREAO_API_KEY"),
    creaoAgentId: required("CREAO_AGENT_ID"),
    databaseUrl: required("DATABASE_URL"),
    defaultTimezone,
    defaultTempUnit: optional("DEFAULT_TEMP_UNIT") ?? "fahrenheit",
    port: int("PORT", 8080),
    creaoTimeoutMs: int("CREAO_TIMEOUT_MS", 60_000),
    interimAfterMs: int("CREAO_INTERIM_AFTER_MS", 8_000),
    cursorConsumer: optional("CURSOR_CONSUMER") ?? "outfit-relay",
  };
}
