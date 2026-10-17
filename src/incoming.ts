export interface IncomingText {
  kind: "text";
  messageId: string;
  spaceId: string;
  senderId: string;
  senderHandle?: string;
  text: string;
  createdAt: string;
}

export interface IncomingNonText {
  kind: "non_text";
  messageId: string;
  spaceId: string;
  senderId: string;
  senderHandle?: string;
  createdAt: string;
}

export type Incoming = IncomingText | IncomingNonText;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function handleOf(user: Json): string | undefined {
  return str(user.handle) ?? str(user.address) ?? str(user.phoneNumber) ?? str(user.email);
}

const normalizeHandle = (h: string) => h.replace(/[\s()-]/g, "").toLowerCase();

/**
 * Decides whether a Photon delivery is a direct iMessage from a human to our
 * agent. Returns undefined for anything we must not answer.
 */
export function parseIncoming(event: unknown, agentHandle?: string): Incoming | undefined {
  if (!isObj(event) || event.type !== "message.received") return undefined;
  const data = isObj(event.data) ? event.data : undefined;
  const msg = data && isObj(data.object) ? data.object : undefined;
  if (!msg) return undefined;
  if (msg.status !== "received" || msg.platform !== "imessage") return undefined;

  const sentBy = isObj(msg.sentBy) ? msg.sentBy : undefined;
  const receivedBy = isObj(msg.receivedBy) ? msg.receivedBy : undefined;
  const space = isObj(msg.space) ? msg.space : undefined;
  if (!sentBy || !receivedBy || !space) return undefined;
  if (sentBy.kind !== "human" || receivedBy.kind !== "agent") return undefined;

  const messageId = str(msg.id);
  const spaceId = str(space.id);
  const senderId = str(receivedBy.id);
  if (!messageId || !spaceId || !senderId || str(sentBy.id) === senderId) return undefined;
  if (space.kind !== "direct") return undefined;

  if (agentHandle) {
    const handle = handleOf(receivedBy);
    if (!handle || normalizeHandle(handle) !== normalizeHandle(agentHandle)) return undefined;
  }

  const base = {
    messageId,
    spaceId,
    senderId,
    senderHandle: handleOf(sentBy),
    createdAt: str(msg.createdAt) ?? new Date().toISOString(),
  };
  const content = isObj(msg.content) ? msg.content : undefined;
  const text = content?.type === "text" ? str(content.text)?.trim() : undefined;
  if (text) return { kind: "text", ...base, text };
  return { kind: "non_text", ...base };
}
