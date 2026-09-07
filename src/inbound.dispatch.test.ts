import { describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedOpenMailAccount } from "./accounts.js";
import { dispatchOpenMailMessage, type OpenMailMessageReceived } from "./inbound.js";
import type { OpenMailApi, OpenMailMessage } from "./openmail-api.js";

vi.mock("./media.js", () => ({
  stageInboundAttachments: vi.fn(async () => ({ paths: ["/tmp/a.png"], types: ["image/png"], skipped: [] })),
}));

const account: ResolvedOpenMailAccount = {
  accountId: "default",
  name: undefined,
  enabled: true,
  configured: true,
  apiKey: "k",
  inboxId: "inb_1",
  baseUrl: "https://api.openmail.sh",
  dmPolicy: undefined,
  allowFrom: ["ada@example.com"],
  mode: "channel",
  allowNewThreads: false,
  mediaMaxMb: 20,
};

const event: OpenMailMessageReceived = {
  event: "message.received",
  event_id: "evt_1",
  inbox_id: "inb_1",
  thread_id: "thr_1",
  message: { id: "msg_1", from: "Ada <ada@example.com>", subject: "Hi", body_text: "hello" },
};

const apiMessage: OpenMailMessage = {
  id: "msg_1",
  threadId: "thr_1",
  direction: "inbound",
  fromAddr: "ada@example.com",
  toAddr: "agent@omail.sh",
  subject: "Hi",
  bodyText: "hello",
  attachments: [],
};

function harness(found: OpenMailMessage | null, overrides: Partial<ResolvedOpenMailAccount> = {}) {
  const run = vi.fn(async (params: { adapter: { ingest: (raw: unknown) => unknown; resolveTurn: (i: unknown) => Promise<unknown> } }) => {
    const ingested = params.adapter.ingest(event) as { id: string };
    return await params.adapter.resolveTurn(ingested);
  });
  const buildContext = vi.fn((p: unknown) => p);
  const ctx = {
    account: { ...account, ...overrides },
    accountId: "default",
    cfg: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setStatus: vi.fn(),
    getStatus: vi.fn(() => ({})),
    channelRuntime: {
      inbound: { run, buildContext },
      routing: { resolveAgentRoute: vi.fn(() => ({ agentId: "main", sessionKey: "s" })) },
    },
  } as unknown as ChannelGatewayContext<ResolvedOpenMailAccount>;
  const api = {
    findMessage: vi.fn(async () => found),
    sendReply: vi.fn(async () => ({ id: "out_1" })),
  } as unknown as OpenMailApi & { findMessage: ReturnType<typeof vi.fn>; sendReply: ReturnType<typeof vi.fn> };
  return { ctx, api, run, buildContext };
}

describe("dispatchOpenMailMessage re-authorization", () => {
  it("dispatches when the API confirms the message and the sender is allowed", async () => {
    const { ctx, api, run, buildContext } = harness(apiMessage);
    const out = await dispatchOpenMailMessage({ ctx, event, api });
    expect(out).toEqual({ kind: "dispatched" });
    expect(api.findMessage).toHaveBeenCalledWith("thr_1", "msg_1");
    expect(run).toHaveBeenCalledTimes(1);
    const built = buildContext.mock.calls[0][0] as { reply: { to: string }; sender: { id: string } };
    expect(built.reply.to).toBe("openmail:ada@example.com");
    expect(built.sender.id).toBe("ada@example.com");
  });

  it("drops a frame whose (thread, message) pair OpenMail does not know", async () => {
    const { ctx, api, run } = harness(null);
    const out = await dispatchOpenMailMessage({ ctx, event, api });
    expect(out).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/not found/) });
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the API's From, not the frame's, when deciding the allowlist", async () => {
    // Frame claims an allowed sender; the real message is from someone else.
    const { ctx, api, run } = harness({ ...apiMessage, fromAddr: "mallory@evil.io" });
    const out = await dispatchOpenMailMessage({ ctx, event, api });
    expect(out).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/mallory@evil\.io/) });
    expect(run).not.toHaveBeenCalled();
    expect(ctx.log?.warn).toHaveBeenCalledWith(expect.stringMatching(/claimed From ada@example.com but the API says mallory@evil.io/));
  });

  it("replies to the API's From even when the frame lies about an allowed sender", async () => {
    const { ctx, api, buildContext } = harness({ ...apiMessage, fromAddr: "Ada Real <ada@example.com>" });
    const spoofed = { ...event, message: { ...event.message, from: "mallory@evil.io" } };
    const out = await dispatchOpenMailMessage({ ctx, event: spoofed, api });
    expect(out).toEqual({ kind: "dispatched" });
    const built = buildContext.mock.calls[0][0] as { reply: { to: string } };
    expect(built.reply.to).toBe("openmail:ada@example.com");
  });

  it("drops events addressed to a different inbox", async () => {
    const { ctx, api } = harness(apiMessage);
    const out = await dispatchOpenMailMessage({ ctx, event: { ...event, inbox_id: "inb_other" }, api });
    expect(out).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/inbox inb_other/) });
    expect(api.findMessage).not.toHaveBeenCalled();
  });

  it("drops its own outbound messages", async () => {
    const { ctx, api, run } = harness({ ...apiMessage, direction: "outbound" });
    const out = await dispatchOpenMailMessage({ ctx, event, api });
    expect(out).toMatchObject({ kind: "dropped", reason: /outbound/ });
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates transient API errors so the durable queue retries", async () => {
    const { ctx, api } = harness(apiMessage);
    api.findMessage.mockRejectedValueOnce(new Error("503"));
    await expect(dispatchOpenMailMessage({ ctx, event, api })).rejects.toThrow("503");
  });

  it("passes staged attachments through as MediaPaths", async () => {
    const { ctx, api, buildContext } = harness({
      ...apiMessage,
      attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 10 }],
    });
    await dispatchOpenMailMessage({ ctx, event, api });
    const built = buildContext.mock.calls[0][0] as { extra: Record<string, unknown> };
    expect(built.extra.MediaPaths).toEqual(["/tmp/a.png"]);
    expect(built.extra.MediaTypes).toEqual(["image/png"]);
  });
});

describe("dispatchOpenMailMessage notify mode", () => {
  it("wakes the main session instead of starting a reply turn", async () => {
    const { ctx, api, run } = harness(apiMessage, { mode: "notify" });
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(out).toEqual({ kind: "dispatched" });
    expect(run).not.toHaveBeenCalled();
    expect(api.sendReply).not.toHaveBeenCalled();
    const [text, opts] = notifyRuntime.enqueueSystemEvent.mock.calls[0] as [string, { sessionKey: string }];
    expect(text).toMatch(/New email arrived/);
    expect(text).toContain("ada@example.com");
    expect(opts.sessionKey).toBe("agent:main:main");
    expect(notifyRuntime.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "immediate", sessionKey: "agent:main:main" }),
    );
  });

  it("still re-authorizes the sender before notifying", async () => {
    const { ctx, api } = harness({ ...apiMessage, fromAddr: "mallory@evil.test" }, { mode: "notify" });
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(out.kind).toBe("dropped");
    expect(notifyRuntime.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
