import { describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedOpenMailAccount } from "./accounts.js";
import { dispatchOpenMailMessage, type OpenMailMessageReceived } from "./inbound.js";
import { getOpenMailRuntime } from "./runtime.js";
import { OpenMailApiError } from "./openmail-api.js";
import type { OpenMailApi, OpenMailMessage } from "./openmail-api.js";

vi.mock("./runtime.js", () => ({ getOpenMailRuntime: vi.fn() }));

const account: ResolvedOpenMailAccount = {
  accountId: "default",
  name: undefined,
  enabled: true,
  configured: true,
  apiKey: "k",
  scope: "inbox",
  inboxId: "inb_1",
  podId: null,
  baseUrl: "https://api.openmail.sh",
  mode: "channel",
  inboxes: {},
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

const mailNotice = "Tell the user that new mail arrived in OpenMail. Open the thread only if the user asks.";
const apiThreadId = "f7ceaf86-b692-41e1-83c2-58af3cc47d41";

function harness(found: OpenMailMessage | null, overrides: Partial<ResolvedOpenMailAccount> = {}) {
  const run = vi.fn(async (_input: { message: string }) => ({ text: '{"reply":"Thanks."}' }));
  const system = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
  vi.mocked(getOpenMailRuntime).mockReturnValue({ subagent: { complete: run }, system } as unknown as ReturnType<typeof getOpenMailRuntime>);
  const ctx = {
    account: { ...account, ...overrides },
    accountId: overrides.accountId ?? account.accountId,
    cfg: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setStatus: vi.fn(),
    getStatus: vi.fn(() => ({})),
    channelRuntime: {
      routing: { resolveAgentRoute: vi.fn(() => ({ agentId: "main", sessionKey: "s" })) },
    },
  } as unknown as ChannelGatewayContext<ResolvedOpenMailAccount>;
  const api = {
    findMessage: vi.fn(async () => found),
    sendReply: vi.fn(async () => ({ id: "out_1" })),
  } as unknown as OpenMailApi & { findMessage: ReturnType<typeof vi.fn>; sendReply: ReturnType<typeof vi.fn> };
  return { ctx, api, run, system };
}

describe("dispatchOpenMailMessage re-authorization", () => {
  it("uses only API content for an isolated reply to this one message", async () => {
    const { ctx, api, run } = harness({ ...apiMessage, fromAddr: "real@example.com", subject: null });
    const frame = { ...event, message: { ...event.message, subject: "frame subject", body_text: "frame body" } };
    await dispatchOpenMailMessage({ ctx, event: frame, api });
    expect(api.findMessage).toHaveBeenCalledWith("thr_1", "msg_1");
    expect(run).toHaveBeenCalledExactlyOnceWith({
      agentId: "main", message: expect.stringContaining("real@example.com"), extraSystemPrompt: expect.any(String), signal: undefined,
    });
    expect(run.mock.calls[0][0].message).not.toMatch(/frame subject|frame body|ada@example/);
    expect(api.sendReply).toHaveBeenCalledExactlyOnceWith({ inboxId: "inb_1", to: "real@example.com", threadId: "thr_1", body: "Thanks." });
  });

  it("drops a frame whose (thread, message) pair OpenMail does not know", async () => {
    const { ctx, api, run } = harness(null);
    const out = await dispatchOpenMailMessage({ ctx, event, api });
    expect(out).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/not found/) });
    expect(run).not.toHaveBeenCalled();
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


});

describe("dispatchOpenMailMessage channel replies", () => {
  it.each([
    { fields: { toRecipients: ["sam@example.com", "alex@example.com"] }, expected: "To: sam@example.com, alex@example.com" },
    { fields: { toRecipients: [], headerTo: "hidden@example.com" }, expected: undefined },
    { fields: { headerTo: "review@example.com", deliveryRole: "cc" }, expected: "To: review@example.com" },
    { fields: { deliveryRole: "cc" }, expected: undefined },
    { fields: {}, expected: undefined },
  ])("displays the visible To header for $fields", async ({ fields, expected }) => {
    const { ctx, api, run } = harness({ ...apiMessage, ...fields });
    await dispatchOpenMailMessage({ ctx, event, api });
    expect(run.mock.calls[0][0].message.split("\n").find(line => line.startsWith("To: "))).toBe(expected);
  });
});

describe("dispatchOpenMailMessage notifications", () => {
  it.each(["notify", "channel"] as const)("queues only an arrival notice and reference in %s mode", async (mode) => {
    const { ctx, api, run } = harness({
      ...apiMessage,
      threadId: apiThreadId,
      fromAddr: "Mail Sender <sender@example.com>",
      toRecipients: ["recipient@example.com"],
      subject: "Private subject",
      bodyText: "Private body",
      attachments: [
        { id: "att_1", filename: "private-report.pdf", parsedText: "Private attachment text" },
        { id: "att_2", filename: "private-image.png" },
      ],
      category: mode === "notify" ? "personal" : "automated",
      autoReplyable: mode === "notify",
    }, { mode });
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(out).toEqual({ kind: "dispatched" });
    expect(run).not.toHaveBeenCalled();
    expect(api.sendReply).not.toHaveBeenCalled();
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      `${mailNotice}\nAccount: default\nThread: ${apiThreadId}`,
      { sessionKey: "agent:main:main", contextKey: "openmail:default:msg_1" },
    );
    expect(notifyRuntime.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "immediate", sessionKey: "agent:main:main" }),
    );
  });

  it.each([
    { accountId: "default", threadId: "" },
    { accountId: "default", threadId: `${apiThreadId}\nextra text` },
    { accountId: "unusable\naccount", threadId: apiThreadId },
  ])("omits unusable references without falling back to the websocket thread", async ({ accountId, threadId }) => {
    const { ctx, api } = harness({ ...apiMessage, threadId }, { mode: "notify", accountId });
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const frame = { ...event, thread_id: "820e59af-e40b-4f6a-8066-12d32b8a1be8" };
    const out = await dispatchOpenMailMessage({ ctx, event: frame, api, notifyRuntime });
    expect(out).toEqual({ kind: "dispatched" });
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledWith(mailNotice, expect.anything());
  });

  it("still requires the API to know the message before notifying", async () => {
    const { ctx, api } = harness(null, { mode: "notify" });
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(out.kind).toBe("dropped");
    expect(notifyRuntime.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});

describe("dispatchOpenMailMessage classification", () => {
  const notify = () => ({ enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() });

  it("replies to personal mail in channel mode", async () => {
    const { ctx, api, run } = harness({ ...apiMessage, category: "personal", autoReplyable: true, verdict: "clean" });
    const notifyRuntime = notify();
    await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(run).toHaveBeenCalled();
    expect(notifyRuntime.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("hands automated mail to the agent without a reply turn", async () => {
    const { ctx, api, run } = harness({
      ...apiMessage,
      fromAddr: "noreply@github.com",
      category: "automated",
      autoReplyable: false,
      verdict: "clean",
    });
    const notifyRuntime = notify();
    const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
    expect(out).toEqual({ kind: "dispatched" });
    expect(run).not.toHaveBeenCalled();
    expect(api.sendReply).not.toHaveBeenCalled();
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledWith(mailNotice, expect.anything());
    expect(notifyRuntime.requestHeartbeat).toHaveBeenCalled();
  });

  it("treats marketing and bounces the same way", async () => {
    for (const category of ["marketing", "bounce"] as const) {
      const { ctx, api, run } = harness({ ...apiMessage, category, autoReplyable: false, verdict: "clean" });
      const notifyRuntime = notify();
      await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
      expect(run).not.toHaveBeenCalled();
      expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    }
  });

  it("drops spam and malicious mail in every mode", async () => {
    for (const mode of ["channel", "notify"] as const) {
      for (const verdict of ["spam", "malicious"] as const) {
        const { ctx, api, run } = harness({ ...apiMessage, category: verdict, autoReplyable: false, verdict }, { mode });
        const notifyRuntime = notify();
        const out = await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime });
        expect(out).toMatchObject({ kind: "dropped", reason: expect.stringContaining(verdict) });
        expect(run).not.toHaveBeenCalled();
        expect(notifyRuntime.enqueueSystemEvent).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps replying to unclassified messages", async () => {
    const { ctx, api, run } = harness(apiMessage);
    await dispatchOpenMailMessage({ ctx, event, api, notifyRuntime: notify() });
    expect(run).toHaveBeenCalled();
  });

  it("falls back to the frame's classification when the API copy has none", async () => {
    const { ctx, api, run } = harness(apiMessage);
    const notifyRuntime = notify();
    await dispatchOpenMailMessage({
      ctx,
      event: { ...event, message: { ...event.message, category: "automated", auto_replyable: false, verdict: "clean" } },
      api,
      notifyRuntime,
    });
    expect(run).not.toHaveBeenCalled();
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("prefers the API's classification over the frame's", async () => {
    const { ctx, api, run } = harness({ ...apiMessage, category: "personal", autoReplyable: true, verdict: "clean" });
    await dispatchOpenMailMessage({
      ctx,
      event: { ...event, message: { ...event.message, auto_replyable: false } },
      api,
      notifyRuntime: notify(),
    });
    expect(run).toHaveBeenCalled();
  });
});

describe("dispatchOpenMailMessage pod scope", () => {
  const podAccount: Partial<ResolvedOpenMailAccount> = { scope: "pod", inboxId: null, podId: "pod_1" };

  it("replies from the inbox that received the mail and keys the conversation per inbox", async () => {
    const { ctx, api } = harness({ ...apiMessage, inboxId: "inb_7" }, podAccount);
    await dispatchOpenMailMessage({ ctx, event: { ...event, inbox_id: "inb_7" }, api });
    expect(api.sendReply).toHaveBeenCalledExactlyOnceWith({ inboxId: "inb_7", to: "ada@example.com", threadId: "thr_1", body: "Thanks." });
    const routing = (ctx.channelRuntime as unknown as { routing: { resolveAgentRoute: ReturnType<typeof vi.fn> } })
      .routing.resolveAgentRoute;
    expect(routing.mock.calls[0][0]).toMatchObject({ peer: { id: "inb_7/ada@example.com" } });
  });

  it("does not drop events for other inboxes in the pod", async () => {
    const { ctx, api, run } = harness({ ...apiMessage, inboxId: "inb_9" }, podAccount);
    const out = await dispatchOpenMailMessage({ ctx, event: { ...event, inbox_id: "inb_9" }, api });
    expect(out.kind).toBe("dispatched");
    expect(run).toHaveBeenCalledTimes(1);
  });


});

describe("dispatchOpenMailMessage per-inbox overrides", () => {
  const pod: Partial<ResolvedOpenMailAccount> = { scope: "pod", inboxId: null, podId: "pod_1" };

  it("drops mail for an inbox set to tool mode, by id", async () => {
    const { ctx, api, run } = harness(
      { ...apiMessage, inboxId: "inb_7" },
      { ...pod, inboxes: { inb_7: { mode: "tool" } } },
    );
    const out = await dispatchOpenMailMessage({ ctx, event: { ...event, inbox_id: "inb_7" }, api });
    expect(out).toMatchObject({ kind: "dropped", reason: expect.stringMatching(/tool mode/) });
    expect(run).not.toHaveBeenCalled();
  });

  it("switches one inbox to notify, keyed by address, and leaves the rest in channel mode", async () => {
    const inboxAddress = vi.fn(async (id: string) => (id === "inb_7" ? "Me@omail.sh" : "sales@omail.sh"));
    const notifyRuntime = { enqueueSystemEvent: vi.fn(() => true), requestHeartbeat: vi.fn() };
    const overrides = { ...pod, accountId: "outreach", inboxes: { "me@omail.sh": { mode: "notify" as const } } };

    const a = harness({ ...apiMessage, inboxId: "inb_7", threadId: apiThreadId }, overrides);
    await dispatchOpenMailMessage({ ctx: a.ctx, event: { ...event, inbox_id: "inb_7" }, api: a.api, notifyRuntime, inboxAddress });
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledWith(
      `${mailNotice}\nAccount: outreach\nThread: ${apiThreadId}`,
      expect.anything(),
    );
    expect(a.run).not.toHaveBeenCalled();

    const b = harness({ ...apiMessage, inboxId: "inb_8" }, overrides);
    await dispatchOpenMailMessage({ ctx: b.ctx, event: { ...event, inbox_id: "inb_8" }, api: b.api, notifyRuntime, inboxAddress });
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(notifyRuntime.enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("does not look up addresses when overrides are keyed by id only", async () => {
    const inboxAddress = vi.fn(async () => "x@omail.sh");
    const { ctx, api } = harness({ ...apiMessage, inboxId: "inb_7" }, { ...pod, inboxes: { inb_9: { mode: "tool" } } });
    await dispatchOpenMailMessage({ ctx, event: { ...event, inbox_id: "inb_7" }, api, inboxAddress });
    expect(inboxAddress).not.toHaveBeenCalled();
  });
});

describe("isolated reply fallback", () => {
  it.each(['{"reply":null}', '{"reply":"ok","to":"other@example.com"}', 'unstructured', '{"reply":"   "}'])(
    "announces mail for an unusable decision", async text => {
      const { ctx, api, run, system } = harness(apiMessage);
      run.mockResolvedValue({ text });
      await dispatchOpenMailMessage({ ctx, event, api });
      expect(api.sendReply).not.toHaveBeenCalled();
      expect(system.enqueueSystemEvent).toHaveBeenCalledWith(mailNotice, expect.anything());
    },
  );

  it("announces mail when isolated execution is unavailable", async () => {
    const { ctx, api, run, system } = harness(apiMessage);
    run.mockRejectedValue(new Error("unavailable"));
    await dispatchOpenMailMessage({ ctx, event, api });
    expect(system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(api.sendReply).not.toHaveBeenCalled();
  });

  it("announces mail with unreadable attachments without running the model", async () => {
    const { ctx, api, run, system } = harness({ ...apiMessage, attachments: [{ filename: "photo.png" }] });
    await dispatchOpenMailMessage({ ctx, event, api });
    expect(system.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates transient delivery failures for retry", async () => {
    const { ctx, api, system } = harness(apiMessage);
    api.sendReply.mockRejectedValueOnce(new OpenMailApiError("unavailable", 503, null));
    await expect(dispatchOpenMailMessage({ ctx, event, api })).rejects.toThrow("unavailable");
    expect(system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
