import { describe, expect, it, vi } from "vitest";
import { CreaoClient, CreaoError } from "../src/creao.js";
import example from "./fixtures/creao-example.json" with { type: "json" };
import wrapped from "./fixtures/creao-wrapped.json" with { type: "json" };

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function mockFetch(route: Route) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return route(url, init);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const input = { request: "Today is …", temp_unit: "fahrenheit" };
const signal = () => new AbortController().signal;

describe("CreaoClient (capi_ app-scoped key)", () => {
  it("creates a run, polls until completed and downloads the JSON artifact", async () => {
    let polls = 0;
    const { fetch, calls } = mockFetch((url, init) => {
      if (init.method === "POST") return json({ id: "run_1", status: "pending", appId: "app_1" }, 202);
      if (url.endsWith("/runs/run_1")) {
        polls++;
        if (polls < 2) return json({ id: "run_1", status: "running" });
        return json({
          id: "run_1",
          status: "completed",
          threadId: "thr_1",
          result: {
            text: '{"date":"2025-06-14","outfit_count":3}',
            artifacts: [
              { id: "workspaces/w/files/outfits.json", type: "application/json", url: "https://agent.creao.ai/api/v1/runs/run_1/artifacts/download?x=1" },
            ],
          },
        });
      }
      if (url.includes("/artifacts/download")) return json(example);
      throw new Error(`unexpected ${url}`);
    });
    const client = new CreaoClient({ apiKey: "capi_test", agentId: "app_1", fetch, pollIntervalMs: 1 });
    const outcome = await client.run(input, signal());
    expect(outcome.runId).toBe("run_1");
    expect(outcome.conversationId).toBe("thr_1");
    expect(outcome.plan.outfits).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://agent.creao.ai/api/v1/apps/app_1/runs");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ inputs: input });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer capi_test");
  });

  it("does not forward the key when the artifact redirects to storage", async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (init.method === "POST") return json({ id: "run_1", status: "completed", result: { artifacts: [{ id: "a.json", type: "application/json", url: "https://agent.creao.ai/dl" }] } });
      if (url === "https://agent.creao.ai/dl") return new Response(null, { status: 302, headers: { location: "https://storage.example.com/a.json" } });
      if (url === "https://storage.example.com/a.json") return json(example);
      throw new Error(`unexpected ${url}`);
    });
    const outcome = await new CreaoClient({ apiKey: "capi_test", agentId: "app_1", fetch }).run(input, signal());
    expect(outcome.plan.outfits).toHaveLength(3);
    const storage = calls.find((c) => c.url.startsWith("https://storage"))!;
    expect(JSON.stringify(storage.init.headers ?? {})).not.toContain("capi_test");
  });

  it("treats a non-outfit reply (no artifact, JSON text) as empty so the help text is used", async () => {
    const { fetch } = mockFetch(() =>
      json({ id: "run_1", status: "completed", result: { text: '{"response":"I\'m the **Fashion Stylist** — pick a location below"}', artifacts: [] } }),
    );
    const outcome = await new CreaoClient({ apiKey: "capi_test", agentId: "app_1", fetch }).run(input, signal());
    expect(outcome.plan.outfits).toBeUndefined();
    expect(outcome.plan.summary).toBeUndefined();
  });
});

describe("CreaoClient artifact URL safety", () => {
  const completedWith = (url: string) => () =>
    json({ id: "r1", status: "completed", result: { artifacts: [{ id: "a.json", type: "application/json", url }] } });

  it.each(["http://agent.creao.ai/dl", "https://169.254.169.254/latest", "https://evil.example.com/a.json", "https://creao.ai.evil.com/a"])(
    "refuses to fetch artifact %s",
    async (url) => {
      const { fetch, calls } = mockFetch(completedWith(url));
      const outcome = await new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch }).run(input, signal());
      expect(calls.map((c) => c.url)).not.toContain(url);
      expect(outcome.plan.outfits).toBeUndefined();
    },
  );

  it.each(["http://storage.example.com/a", "https://10.0.0.5/a", "https://localhost/a", "https://metadata.google.internal/a", "https://[::1]/a"])(
    "refuses to follow a redirect to %s",
    async (location) => {
      const { fetch, calls } = mockFetch((url, init) => {
        if (init.method === "POST") return completedWith("https://agent.creao.ai/dl")();
        if (url === "https://agent.creao.ai/dl") return new Response(null, { status: 302, headers: { location } });
        return json(example);
      });
      await new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch }).run(input, signal());
      expect(calls).toHaveLength(2);
    },
  );
});

describe("CreaoClient (cr_sk_ CLI key)", () => {
  it("uses the developer endpoint with agent_id/input and accepts a wrapped result", async () => {
    const { fetch, calls } = mockFetch(() => json(wrapped));
    const outcome = await new CreaoClient({ apiKey: "cr_sk_test", agentId: "agent_1", fetch }).run(input, signal());
    expect(calls[0]!.url).toBe("https://developer.creao.ai/v1/runs");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ agent_id: "agent_1", input });
    expect(outcome).toMatchObject({ runId: "run_123", conversationId: "conv_456" });
    expect(outcome.plan.outfits).toHaveLength(3);
  });

  it("accepts a bare outfit object", async () => {
    const { fetch } = mockFetch(() => json(example));
    const outcome = await new CreaoClient({ apiKey: "cr_sk_test", agentId: "agent_1", fetch }).run(input, signal());
    expect(outcome.plan.location).toBe("Austin, TX");
  });

  it("polls GET /v1/runs/{run_id} for queued runs", async () => {
    const { fetch, calls } = mockFetch((url, init) =>
      init.method === "POST" ? json({ run_id: "r1", status: "queued" }) : json({ run_id: "r1", status: "completed", result: example }),
    );
    const outcome = await new CreaoClient({ apiKey: "cr_sk_test", agentId: "a", fetch, pollIntervalMs: 1 }).run(input, signal());
    expect(calls[1]!.url).toBe("https://developer.creao.ai/v1/runs/r1");
    expect(outcome.plan.outfits).toHaveLength(3);
  });
});

describe("CreaoClient errors", () => {
  it("keeps polling through rate limits and 5xx responses", async () => {
    let polls = 0;
    const { fetch } = mockFetch((_url, init) => {
      if (init.method === "POST") return json({ id: "r1", status: "pending" }, 202);
      polls++;
      if (polls <= 3) return json({ error: "RATE_LIMITED" }, 429, { "retry-after": "0" });
      if (polls === 4) return json({ error: "SERVICE_UNAVAILABLE" }, 500);
      return json({ id: "r1", status: "completed", result: example });
    });
    const outcome = await new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch, pollIntervalMs: 1 }).run(input, signal());
    expect(outcome.plan.outfits).toHaveLength(3);
  });

  it("throws on failed runs", async () => {
    const { fetch } = mockFetch(() => json({ id: "r1", status: "failed", error: { code: "AGENT_ERROR" } }));
    await expect(new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch }).run(input, signal())).rejects.toMatchObject({
      code: "run_failed:AGENT_ERROR",
      runId: "r1",
    });
  });

  it("throws on auth errors without retrying", async () => {
    const { fetch, calls } = mockFetch(() => json({ error: "AUTHENTICATION_REQUIRED" }, 401));
    await expect(new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch }).run(input, signal())).rejects.toBeInstanceOf(CreaoError);
    expect(calls).toHaveLength(1);
  });

  it("stops polling when aborted", async () => {
    const controller = new AbortController();
    const { fetch } = mockFetch(() => json({ id: "r1", status: "running" }));
    const promise = new CreaoClient({ apiKey: "capi_x", agentId: "a", fetch, pollIntervalMs: 5 }).run(input, controller.signal);
    setTimeout(() => controller.abort(new CreaoError("timeout")), 20);
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
  });
});
