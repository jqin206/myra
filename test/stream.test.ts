import { describe, expect, it } from "vitest";
import { poolSsl } from "../src/db.js";
import { EventStream } from "../src/photon.js";

function stream(handle: (seq: number) => Promise<void>, saveCursor: (seq: number) => Promise<void> = async () => {}) {
  const saved: number[] = [];
  const s = new EventStream({
    apiKey: "k",
    projectId: "pho_prj_x",
    origin: "https://example.invalid",
    loadCursor: async () => 0,
    saveCursor: async (seq) => {
      await saveCursor(seq);
      saved.push(seq);
    },
    keyOf: (e) => (e as { key: string }).key,
    handle: (e) => handle((e as { seq: number }).seq),
    checkpointRetryMs: 5,
  });
  const deliver = (seq: number, key = `k${seq}`) => s.deliver({ seq, key }, seq);
  return { s, saved, deliver };
}

describe("EventStream checkpointing", () => {
  it("never moves the cursor past a failed delivery until it is replayed successfully", async () => {
    let fail = true;
    const { s, saved, deliver } = stream(async (seq) => {
      if (seq === 2 && fail) throw new Error("boom");
    });
    deliver(1);
    deliver(2);
    deliver(3);
    await s.idle();
    expect(s.savedCursor).toBe(1);
    expect(saved).toEqual([1]);

    fail = false;
    deliver(2); // replay
    deliver(3); // replay of an already-handled event
    await s.idle();
    expect(s.savedCursor).toBe(3);
  });

  it("does not advance past a delivery that is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { s, deliver } = stream(async (seq) => {
      if (seq === 1) await gate;
    });
    deliver(1);
    deliver(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(s.savedCursor).toBe(0);
    release();
    await s.idle();
    expect(s.savedCursor).toBe(2);
  });

  it("retries a failed cursor write without needing a new delivery", async () => {
    let failures = 1;
    const { s, deliver } = stream(
      async () => {},
      async () => {
        if (failures-- > 0) throw new Error("db down");
      },
    );
    deliver(1);
    await s.idle();
    expect(s.savedCursor).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    await s.idle();
    expect(s.savedCursor).toBe(1);
  });

  it("processes one conversation in order", async () => {
    const order: number[] = [];
    const { s, deliver } = stream(async (seq) => {
      await new Promise((r) => setTimeout(r, seq === 1 ? 20 : 1));
      order.push(seq);
    });
    deliver(1, "same");
    deliver(2, "same");
    await s.idle();
    expect(order).toEqual([1, 2]);
  });
});

describe("poolSsl", () => {
  it("verifies TLS for remote hosts by default", () => {
    expect(poolSsl("postgres://u:p@db.example.com:5432/x")).toEqual({ rejectUnauthorized: true });
  });
  it("skips TLS on localhost and Railway's private network", () => {
    expect(poolSsl("postgres://u:p@localhost:5432/x")).toBe(false);
    expect(poolSsl("postgres://u:p@postgres-g2jb.railway.internal:5432/x")).toBe(false);
  });
  it("honours explicit sslmode", () => {
    expect(poolSsl("postgres://u:p@db.example.com/x?sslmode=disable")).toBe(false);
    expect(poolSsl("postgres://u:p@db.example.com/x?sslmode=no-verify")).toEqual({ rejectUnauthorized: false });
  });
});
