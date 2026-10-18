type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: "info" | "warn" | "error", msg: string, fields?: Fields): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

// Never pass message text or secrets here: log IDs and statuses only.
export const log = {
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

export function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; status?: unknown; name?: unknown; body?: unknown };
    if (typeof e.code === "string") return e.code;
    // Photon ApiError carries the problem code (e.g. SPACE_NOT_SENDABLE) in its body.
    const bodyCode = e.body && typeof e.body === "object" ? (e.body as { code?: unknown }).code : undefined;
    if (typeof e.status === "number" && typeof bodyCode === "string") return `http_${e.status}_${bodyCode}`;
    if (typeof e.status === "number") return `http_${e.status}`;
    if (typeof e.name === "string") return e.name;
  }
  return "unknown";
}
