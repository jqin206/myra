import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { OutfitPlan } from "./format.js";

export interface CreaoOutcome {
  plan: OutfitPlan;
  runId?: string;
  conversationId?: string;
}

export class CreaoError extends Error {
  constructor(
    readonly code: string,
    readonly runId?: string,
  ) {
    super(`Creao error: ${code}`);
    this.name = "CreaoError";
  }
}

export interface CreaoClientOptions {
  apiKey: string;
  agentId: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
  developerBaseUrl?: string;
  appBaseUrl?: string;
  /** Resolves a hostname to IP addresses; injectable for tests. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

type Json = Record<string, unknown>;
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled"]);
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function hasOutfitShape(v: unknown): v is OutfitPlan {
  return isObj(v) && ("outfits" in v || "outfit_count" in v || "weather" in v || "summary" in v);
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const brace = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (brace >= 0 && last > brace) candidates.push(text.slice(brace, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Lifts top-level weather fields (session-summary shape) into `weather`. */
export function normalizePlan(raw: Json): OutfitPlan {
  const plan = { ...raw } as OutfitPlan & Json;
  if (!isObj(plan.weather)) {
    const weather: Json = {};
    for (const k of ["temp_high", "temp_low", "temp_unit", "conditions", "precipitation_chance", "wind"]) {
      if (k in raw) weather[k] = raw[k];
    }
    if (Object.keys(weather).length) plan.weather = weather;
  }
  return plan;
}

/**
 * Accepts the documented run wrapper (`{ run_id, status, result }`), the bare
 * outfit object, or an outfit object serialized inside `result.text`.
 */
export function extractPlanFromBody(body: unknown): OutfitPlan | undefined {
  if (!isObj(body)) return undefined;
  const result = "result" in body ? body.result : body;
  if (hasOutfitShape(result) && Array.isArray((result as Json).outfits)) return normalizePlan(result as Json);
  if (isObj(result)) {
    for (const field of ["text", "chat_text", "chatText"]) {
      const parsed = tryJson(str(result[field]));
      if (isObj(parsed) && Array.isArray(parsed.outfits)) return normalizePlan(parsed);
    }
  }
  if (hasOutfitShape(result)) return normalizePlan(result as Json);
  return undefined;
}

export class CreaoClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;
  private readonly appScoped: boolean;
  private readonly base: string;

  constructor(private readonly opts: CreaoClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2500;
    // `capi_` keys are app-scoped API Trigger keys; `cr_sk_` keys use CREAO CLI /v1.
    this.appScoped = opts.apiKey.startsWith("capi_");
    this.base = this.appScoped
      ? `${opts.appBaseUrl ?? "https://agent.creao.ai"}/api/v1/apps/${encodeURIComponent(opts.agentId)}/runs`
      : `${opts.developerBaseUrl ?? "https://developer.creao.ai"}/v1/runs`;
  }

  async run(input: { request: string; temp_unit: string }, signal: AbortSignal): Promise<CreaoOutcome> {
    const body = this.appScoped ? { inputs: input } : { agent_id: this.opts.agentId, input };
    let run = await this.request("POST", this.base, signal, body);
    const runId = str(run.run_id) ?? str(run.id);
    let conversationId = str(run.conversation_id) ?? str(run.conversationId) ?? str(run.threadId);

    // Some deployments answer synchronously with the plan (or a wrapper around it).
    const status = () => str(run.status)?.toLowerCase();
    if (!status() || !runId) {
      const plan = extractPlanFromBody(run);
      if (plan) return { plan, runId, conversationId };
      throw new CreaoError("unexpected_response", runId);
    }

    try {
      while (!TERMINAL.has(status()!)) {
        await sleep(this.pollIntervalMs, signal);
        try {
          run = await this.request("GET", `${this.base}/${encodeURIComponent(runId)}`, signal);
        } catch (error) {
          // Transient poll failures (rate limits, 5xx, network) just mean "ask again later".
          if (signal.aborted || (error instanceof CreaoError && !isTransient(error.code))) throw error;
        }
        conversationId ??= str(run.conversation_id) ?? str(run.threadId);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      // Creao has no cancel API: we just stop waiting and let the run finish on its side.
      const reason = signal.reason;
      throw new CreaoError(reason instanceof CreaoError ? reason.code : "aborted", runId);
    }
    if (status() !== "completed") {
      const err = isObj(run.error) ? str(run.error.code) : str(run.errorCode);
      throw new CreaoError(`run_${status()}${err ? `:${err}` : ""}`, runId);
    }

    const plan = (await this.planFromArtifacts(run, signal)) ?? extractPlanFromBody(run);
    if (plan) return { plan, runId, conversationId };
    const result = isObj(run.result) ? run.result : {};
    const text = str(result.chat_text) ?? str(result.chatText) ?? str(result.text);
    return { plan: { summary: text && !text.trim().startsWith("{") ? text : undefined }, runId, conversationId };
  }

  /** The Fashion Stylist agent writes the full plan to a JSON artifact. */
  private async planFromArtifacts(run: Json, signal: AbortSignal): Promise<OutfitPlan | undefined> {
    const result = isObj(run.result) ? run.result : undefined;
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts.filter(isObj) : [];
    const json = artifacts.filter(
      (a) => str(a.url) && (/json/i.test(str(a.type) ?? str(a.mime_type) ?? "") || /\.json$/i.test(str(a.id) ?? "")),
    );
    for (const artifact of json) {
      try {
        const parsed = await this.download(str(artifact.url)!, signal);
        if (isObj(parsed) && (Array.isArray(parsed.outfits) || hasOutfitShape(parsed))) return normalizePlan(parsed);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
    return undefined;
  }

  private async download(url: string, signal: AbortSignal): Promise<unknown> {
    const api = new URL(this.base);
    let target = new URL(url);
    if (!isCreaoHost(target, api)) throw new CreaoError("artifact_untrusted_host");
    for (let hop = 0; ; hop++) {
      if (!(await this.resolvesPublic(target.hostname, signal))) throw new CreaoError("artifact_private_address");
      const res = await this.fetch(target, {
        signal,
        redirect: "manual",
        // The bearer token only ever goes to the configured API origin.
        headers: target.origin === api.origin ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= 3) throw new CreaoError("artifact_too_many_redirects");
        target = new URL(location, target);
        if (!isSafePublicUrl(target)) throw new CreaoError("artifact_untrusted_redirect");
        continue;
      }
      if (!res.ok) throw new CreaoError(`artifact_http_${res.status}`);
      return JSON.parse(await res.text());
    }
  }

  private async resolvesPublic(hostname: string, signal: AbortSignal): Promise<boolean> {
    const resolve =
      this.opts.resolveHost ?? (async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address));
    try {
      // dns.lookup can't be aborted, so race it against the run deadline and a short cap.
      const stop = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const addresses = await Promise.race([
        resolve(hostname),
        new Promise<never>((_, reject) => {
          if (stop.aborted) reject(stop.reason);
          stop.addEventListener("abort", () => reject(stop.reason), { once: true });
        }),
      ]);
      return addresses.length > 0 && addresses.every(isPublicAddress);
    } catch {
      return false;
    }
  }

  private async request(method: string, url: string, signal: AbortSignal, body?: unknown): Promise<Json> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      if (res.ok) {
        if (!isObj(parsed)) throw new CreaoError("unexpected_response");
        return parsed;
      }
      const retryable = res.status === 429 || res.status === 503 || res.status === 502;
      if (retryable && attempt < 3) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : 1000 * attempt, signal);
        continue;
      }
      const code = isObj(parsed) ? str(parsed.error) : undefined;
      throw new CreaoError(`http_${res.status}${code ? `:${code}` : ""}`);
    }
  }
}

/** Artifact links must point at Creao itself (the API origin or a *.creao.ai host) over HTTPS. */
function isCreaoHost(url: URL, api: URL): boolean {
  return url.protocol === "https:" && (url.host === api.host || url.hostname === "creao.ai" || url.hostname.endsWith(".creao.ai"));
}

/** Redirect targets (signed storage URLs) must be HTTPS hostnames, not IP literals or internal names. */
export function isSafePublicUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || /^\d+$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return !/(^|\.)(localhost|internal|local|localdomain|intranet|corp|home|lan)$/.test(host);
}

const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
  ] as const) list.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [
    ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** True for globally routable unicast addresses only. */
export function isPublicAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d): judge the embedded IPv4 address.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (/^::ffff:/i.test(address)) return false;
  const family = isIP(address);
  if (family === 0) return false;
  return !PRIVATE_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isTransient(code: string): boolean {
  return code.startsWith("http_5") || code.startsWith("http_429");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
