import { Photon } from "@photon-ai/api";
import { io, type Socket } from "socket.io-client";
import type { Sender } from "./handler.js";
import { errorCode, log } from "./log.js";

export function createSender(opts: { apiKey: string; projectId: string; baseUrl: string }): Sender {
  const photon = new Photon({ baseUrl: opts.baseUrl, headers: { Authorization: `Bearer ${opts.apiKey}` } });
  return {
    async send({ spaceId, senderId, parentMessageId, text, idempotencyKey }) {
      await photon.projects.sendMessage({
        path: { id: opts.projectId },
        headers: { "idempotency-key": idempotencyKey },
        body: { spaceId, senderId, parentMessageId, content: { type: "text", format: "plain", text } },
      });
    },
  };
}

export interface StreamOptions {
  apiKey: string;
  projectId: string;
  origin: string;
  apiVersion?: string;
  loadCursor: () => Promise<number>;
  saveCursor: (seq: number) => Promise<void>;
  /** Key used to serialize events; events with the same key run one at a time. */
  keyOf: (event: unknown) => string | undefined;
  handle: (event: unknown) => Promise<void>;
  maxInFlight?: number;
  checkpointRetryMs?: number;
}

/**
 * Consumes the Photon Beta Socket.IO event stream. Events for the same
 * conversation are processed in order; different conversations run in
 * parallel. The persisted cursor only advances past a seq once it and every
 * earlier seq have been fully handled, so a crash replays (never skips).
 */
export class EventStream {
  private socket?: Socket;
  private cursor = 0;
  private epoch = 0;
  private readonly pending = new Map<number, "running" | "done" | "failed">();
  private retryTimer?: NodeJS.Timeout;
  private readonly chains = new Map<string, Promise<void>>();
  private checkpointing: Promise<void> = Promise.resolve();
  private stopped = false;
  connected = false;

  constructor(private readonly opts: StreamOptions) {}

  async start(): Promise<void> {
    this.cursor = await this.opts.loadCursor();
    log.info("photon_stream_starting", { cursor: this.cursor });
    const socket = io(this.opts.origin, {
      path: `/v1/projects/${this.opts.projectId}/events/ws`,
      addTrailingSlash: false,
      transports: ["websocket"],
      extraHeaders: {
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.connected = true;
      socket.timeout(10_000).emit("subscribe", { startSeq: this.cursor, ...(this.opts.apiVersion ? { apiVersion: this.opts.apiVersion } : {}) }, (error: unknown, result: any) => {
        if (error) {
          log.warn("photon_subscribe_timeout");
          socket.io.engine?.close();
        } else if (!result?.ok) {
          log.error("photon_subscribe_failed", { code: result?.error?.code });
          socket.io.engine?.close();
        } else {
          log.info("photon_subscribed", { startSeq: this.cursor });
        }
      });
    });
    socket.on("disconnect", (reason) => {
      this.connected = false;
      this.epoch++;
      log.warn("photon_disconnected", { reason });
    });
    socket.on("connect_error", (error) => log.warn("photon_connect_error", { error: error.message }));
    socket.on("delivery_error", (error: { code?: string }) => log.warn("photon_delivery_error", { code: error?.code }));
    socket.on("delivery", (event: unknown, meta: { seq: number }) => this.onDelivery(event, meta?.seq));
    socket.connect();
  }

  private onDelivery(event: unknown, seq: number): void {
    if (typeof seq !== "number" || seq <= this.cursor) return;
    const state = this.pending.get(seq);
    if (state === "running") return;
    if (state === "done") {
      // Replay of a handled event whose cursor write may have failed: retry the checkpoint.
      this.checkpoint();
      return;
    }
    if (state === undefined && this.pending.size >= (this.opts.maxInFlight ?? 256)) {
      log.warn("photon_backpressure", { inFlight: this.pending.size });
      this.reconnect();
      return;
    }
    this.pending.set(seq, "running");
    const key = this.opts.keyOf(event) ?? `seq:${seq}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.opts.handle(event))
      .then(
        () => {
          this.pending.set(seq, "done");
          this.checkpoint();
        },
        (error) => {
          // Keep the seq as a barrier so the cursor can never move past it until a replay succeeds.
          this.pending.set(seq, "failed");
          log.error("event_failed", { seq, error: errorCode(error) });
          // Always reconnect: a replay on the current connection may have been ignored while this was running.
          this.reconnect();
        },
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Highest seq such that it and every earlier delivered seq completed successfully. */
  private contiguousDone(): number {
    let advanced = this.cursor;
    for (const seq of [...this.pending.keys()].sort((a, b) => a - b)) {
      if (this.pending.get(seq) !== "done") break;
      advanced = seq;
    }
    return advanced;
  }

  private checkpoint(): void {
    this.checkpointing = this.checkpointing.then(async () => {
      const advanced = this.contiguousDone();
      if (advanced <= this.cursor) return;
      try {
        await this.opts.saveCursor(advanced);
        for (const seq of this.pending.keys()) if (seq <= advanced) this.pending.delete(seq);
        this.cursor = advanced;
      } catch (error) {
        log.error("cursor_save_failed", { error: errorCode(error) });
        if (!this.stopped && !this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.checkpoint();
          }, this.opts.checkpointRetryMs ?? 5000);
        }
      }
    });
  }

  /** Exposed for tests. */
  get savedCursor(): number {
    return this.cursor;
  }

  /** Exposed for tests: feeds a delivery as if it came from the socket. */
  deliver(event: unknown, seq: number): void {
    this.onDelivery(event, seq);
  }

  idle(): Promise<void> {
    return Promise.allSettled([...this.chains.values()]).then(() => this.checkpointing);
  }

  private reconnect(): void {
    if (this.stopped || !this.socket) return;
    this.epoch++;
    this.socket.io.engine?.close();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.disconnect();
    await Promise.allSettled([...this.chains.values()]);
    await this.checkpointing;
  }
}
