import { describe, expect, it } from "vitest";
import { createSender } from "../src/photon.js";

const user = (id: string, kind: string) => ({ details: {}, handle: "+15555550100", id, kind, metadata: {}, platform: "imessage", projectId: "pho_prj_1" });

/** A sent iMessage in the shape Photon returns (the SDK validates responses). */
function message(id: string, text: string, status: "dispatched" | "delivered") {
  const at = "2026-10-18T06:52:49.098Z";
  return {
    addressedTo: user("pho_usr_human", "human"),
    content: { format: "plain", text, type: "text" },
    createdAt: at,
    id,
    metadata: {},
    platform: "imessage",
    projectId: "pho_prj_1",
    sentBy: { ...user("pho_usr_agent", "agent"), details: { type: "shared" } },
    space: { details: {}, id: "pho_spc_1", kind: "direct", metadata: {}, participantIds: ["pho_usr_agent", "pho_usr_human"], platform: "imessage", projectId: "pho_prj_1" },
    status,
    timestamps: status === "delivered" ? { deliveredAt: at, dispatchedAt: at } : { dispatchedAt: at },
    updatedAt: at,
  };
}

/** Fake Photon API: each sent text reports "dispatched" until it has been polled `pollsUntilDelivered` times. */
function fakePhoton(pollsUntilDelivered: number | ((text: string) => number)) {
  const log: string[] = [];
  const texts = new Map<string, { text: string; polls: number }>();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (req.method === "POST") {
      const { content } = (await req.json()) as { content: { text: string } };
      const id = `pho_msg_${texts.size + 1}`;
      texts.set(id, { text: content.text, polls: 0 });
      log.push(`send ${content.text}`);
      return json(202, message(id, content.text, "dispatched"));
    }
    const id = url.pathname.split("/").pop()!;
    const m = texts.get(id)!;
    m.polls++;
    const needed = typeof pollsUntilDelivered === "number" ? pollsUntilDelivered : pollsUntilDelivered(m.text);
    const status = m.polls >= needed ? "delivered" : "dispatched";
    if (status === "delivered") log.push(`delivered ${m.text}`);
    return json(200, message(id, m.text, status));
  };
  return { fetch: fetch as typeof globalThis.fetch, log };
}

const base = { apiKey: "k", projectId: "prj", baseUrl: "https://photon.test", deliveryPollMs: 1 };
const reply = (text: string) => ({ spaceId: "spc", senderId: "usr", text, idempotencyKey: `k:${text}` });

describe("createSender", () => {
  it("resolves only once Photon reports the text delivered, so the next text goes out after it", async () => {
    const photon = fakePhoton((t) => (t === "intro" ? 3 : 1));
    const sender = createSender({ ...base, fetch: photon.fetch });
    await sender.send(reply("intro"));
    await sender.send(reply("question"));
    expect(photon.log).toEqual(["send intro", "delivered intro", "send question", "delivered question"]);
  });

  it("doesn't poll when the send is already delivered", async () => {
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push(req.method);
      return new Response(JSON.stringify(message("pho_msg_1", "hi", "delivered")), { status: 202, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    await createSender({ ...base, fetch }).send(reply("hi"));
    expect(calls).toEqual(["POST"]);
  });

  it("stops waiting after the delivery timeout", async () => {
    const photon = fakePhoton(Infinity);
    const started = performance.now();
    await createSender({ ...base, fetch: photon.fetch, deliveryTimeoutMs: 50 }).send(reply("stuck"));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(photon.log).toEqual(["send stuck"]);
  });
});
