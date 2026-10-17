import { describe, expect, it } from "vitest";
import { parseIncoming } from "../src/incoming.js";

function event(overrides: Record<string, unknown> = {}, content: unknown = { type: "text", format: "plain", text: "Austin Saturday" }) {
  return {
    id: "evt_1",
    type: "message.received",
    apiVersion: "2026-07-01",
    source: "imessage.photon",
    timestamp: "2026-10-17T22:00:00Z",
    data: {
      projectId: "pho_prj_x",
      object: {
        id: "msg_1",
        platform: "imessage",
        status: "received",
        createdAt: "2026-10-17T22:00:00Z",
        sentBy: { id: "usr_human", kind: "human", handle: "+15551230000" },
        receivedBy: { id: "usr_agent", kind: "agent", handle: "+15559870000" },
        space: { id: "spc_1", kind: "direct", platform: "imessage" },
        content,
        ...overrides,
      },
    },
  };
}

describe("parseIncoming", () => {
  it("accepts a direct text message from a human to the agent", () => {
    expect(parseIncoming(event())).toEqual({
      kind: "text",
      messageId: "msg_1",
      spaceId: "spc_1",
      senderId: "usr_agent",
      senderHandle: "+15551230000",
      text: "Austin Saturday",
      createdAt: "2026-10-17T22:00:00Z",
    });
  });

  it("marks attachments and empty text as non-text", () => {
    expect(parseIncoming(event({}, { type: "attachment", attachmentId: "att_1" }))?.kind).toBe("non_text");
    expect(parseIncoming(event({}, { type: "text", format: "plain", text: "   " }))?.kind).toBe("non_text");
  });

  it.each([
    ["other event types", { ...event(), type: "message.sent" }],
    ["non-imessage", event({ platform: "sms" })],
    ["not received", event({ status: "delivered" })],
    ["agent-sent messages", event({ sentBy: { id: "usr_agent", kind: "agent" } })],
    ["not received by an agent", event({ receivedBy: { id: "usr_x", kind: "human" } })],
    ["sender equals receiver", event({ sentBy: { id: "usr_agent", kind: "human" } })],
    ["group chats", event({ space: { id: "spc_1", kind: "group" } })],
    ["missing space", event({ space: undefined })],
    ["garbage", null],
  ])("ignores %s", (_name, e) => {
    expect(parseIncoming(e)).toBeUndefined();
  });

  it("applies the optional agent-handle filter", () => {
    expect(parseIncoming(event(), "+1 (555) 987-0000")).toBeDefined();
    expect(parseIncoming(event(), "+15550000000")).toBeUndefined();
  });
});
