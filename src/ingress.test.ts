import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedOpenMailAccount } from "./accounts.js";
import type { OpenMailMessageReceived } from "./inbound.js";
import { createFileCursor, createMemoryIngress, laneKeyFor } from "./ingress.js";

function ev(id: string, from = "ada@example.com"): OpenMailMessageReceived {
  return {
    event: "message.received",
    event_id: id,
    inbox_id: "inb",
    thread_id: "thr",
    message: { id: `m-${id}`, from },
  };
}

function ctx() {
  return {
    accountId: "default",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    abortSignal: new AbortController().signal,
  } as unknown as ChannelGatewayContext<ResolvedOpenMailAccount>;
}

describe("createMemoryIngress", () => {
  it("dispatches in order and dedupes by event_id", async () => {
    const order: string[] = [];
    const dispatch = vi.fn(async (e: OpenMailMessageReceived) => {
      await new Promise((r) => setTimeout(r, e.event_id === "1" ? 20 : 0));
      order.push(e.event_id);
      return { kind: "dispatched" as const };
    });
    const ingress = createMemoryIngress({ ctx: ctx(), dispatch });
    ingress.start();
    await Promise.all([ingress.receive(ev("1")), ingress.receive(ev("2")), ingress.receive(ev("1"))]);
    expect(order).toEqual(["1", "2"]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries a failing dispatch, then succeeds", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ kind: "dispatched" });
    const ingress = createMemoryIngress({ ctx: ctx(), dispatch, retryDelaysMs: [1, 1] });
    ingress.start();
    await expect(ingress.receive(ev("1"))).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries so the cursor does not advance", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("boom"));
    const ingress = createMemoryIngress({ ctx: ctx(), dispatch, retryDelaysMs: [1] });
    ingress.start();
    await expect(ingress.receive(ev("1"))).rejects.toThrow(/not handled/);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // A later retry of the same event is allowed (it was forgotten on give-up).
    dispatch.mockResolvedValue({ kind: "dispatched" });
    await expect(ingress.receive(ev("1"))).resolves.toBeUndefined();
  });

  it("refuses events when stopped", async () => {
    const ingress = createMemoryIngress({ ctx: ctx(), dispatch: vi.fn() });
    await expect(ingress.receive(ev("1"))).rejects.toThrow(/stopped/);
  });
});

describe("laneKeyFor", () => {
  it("groups by normalized sender address", () => {
    expect(laneKeyFor(ev("1", "Ada <ADA@Example.com>"))).toBe("sender:ada@example.com");
  });
});

describe("createFileCursor", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and returns undefined when missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "openmail-cursor-"));
    const cursor = createFileCursor("acct/one", dir);
    expect(await cursor.load()).toBeUndefined();
    await cursor.save("evt_9");
    expect(await cursor.load()).toBe("evt_9");
  });
});
