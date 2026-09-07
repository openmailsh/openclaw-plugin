import { describe, expect, it, vi } from "vitest";
import type { OpenMailApi, OpenMailInbox } from "./openmail-api.js";
import { normalizeAllowFrom, provisionOpenMailAccount, provisionOpenMailPod, setupAdapter } from "./setup.js";
import { resolveOpenMailAccount } from "./accounts.js";

describe("normalizeAllowFrom", () => {
  it("splits, trims, lowercases and dedupes", () => {
    expect(normalizeAllowFrom(" A@x.com, y.com ,a@X.com,, ")).toEqual(["a@x.com", "y.com"]);
    expect(normalizeAllowFrom(["*", "*"])).toEqual(["*"]);
    expect(normalizeAllowFrom(undefined)).toEqual([]);
  });
});

const inbox: OpenMailInbox = { id: "inb_1", address: "sales@omail.sh" };

function mockApi(over: Partial<Record<keyof OpenMailApi, unknown>> = {}) {
  return {
    getInbox: vi.fn(async () => inbox),
    createInbox: vi.fn(async () => ({ ...inbox, id: "inb_new", address: "new@omail.sh" })),
    resolveInbox: vi.fn(async () => ({ kind: "resolved" as const, inbox, created: false })),
    mintInboxKey: vi.fn(async () => ({ id: "key_1", token: "omk_scoped" })),
    ...over,
  } as unknown as OpenMailApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("provisionOpenMailAccount", () => {
  const base = { accountId: "sales", create: {}, log: () => {} };

  it("resolves the key's single inbox and mints a scoped key", async () => {
    const api = mockApi();
    const out = await provisionOpenMailAccount({ ...base, api });
    expect(out).toEqual({ inboxId: "inb_1", apiKey: "omk_scoped", address: "sales@omail.sh", created: false });
    expect(api.mintInboxKey).toHaveBeenCalledWith("inb_1", "openclaw:sales");
  });

  it("does not store a key when the one given is already inbox-scoped (mint 403)", async () => {
    const api = mockApi({ mintInboxKey: vi.fn(async () => null) });
    const out = await provisionOpenMailAccount({ ...base, api });
    expect(out.apiKey).toBeUndefined();
  });

  it("creates an inbox when asked and never touches server-side policy", async () => {
    const api = mockApi();
    await provisionOpenMailAccount({ ...base, api, create: { mailboxName: "sales" } });
    expect(api.createInbox).toHaveBeenCalledWith({ mailboxName: "sales" });
    expect("setInboundAllowlist" in api).toBe(false);
  });

  it("refuses to guess when the key sees several inboxes", async () => {
    const api = mockApi({
      resolveInbox: vi.fn(async () => ({
        kind: "ambiguous" as const,
        inboxes: [inbox, { id: "inb_2", address: "ops@omail.sh" }],
      })),
    });
    await expect(provisionOpenMailAccount({ ...base, api })).rejects.toThrow(/--inbox-id/);
    expect(api.mintInboxKey).not.toHaveBeenCalled();
  });

  it("uses an explicit inboxId without creating or resolving", async () => {
    const api = mockApi();
    await provisionOpenMailAccount({ ...base, api, inboxId: "inb_1" });
    expect(api.getInbox).toHaveBeenCalledWith("inb_1");
    expect(api.resolveInbox).not.toHaveBeenCalled();
    expect(api.createInbox).not.toHaveBeenCalled();
  });
});

describe("setup --mode", () => {
  const apply = (input: Record<string, unknown>, cfg: Record<string, unknown> = {}) =>
    setupAdapter.applyAccountConfig({
      cfg: cfg as never,
      accountId: "default",
      input: input as never,
    });

  it("defaults to channel when not given", () => {
    const cfg = apply({ apiKey: "k", inboxId: "i" });
    expect(resolveOpenMailAccount({ cfg, accountId: "default" }).mode).toBe("channel");
  });

  it("stores notify / tool when chosen", () => {
    const cfg = apply({ apiKey: "k", inboxId: "i", mode: "notify" });
    expect(resolveOpenMailAccount({ cfg, accountId: "default" }).mode).toBe("notify");
  });

  it("ignores an unknown mode instead of writing it", () => {
    const cfg = apply({ apiKey: "k", inboxId: "i", mode: "shout" });
    expect(resolveOpenMailAccount({ cfg, accountId: "default" }).mode).toBe("channel");
  });
});

describe("provisionOpenMailPod", () => {
  const pods = [{ id: "pod_1", clientId: "team-a", name: "Team A" }];
  const podApi = (over: Record<string, unknown> = {}) =>
    mockApi({
      listPods: vi.fn(async () => pods),
      listInboxes: vi.fn(async () => [
        { id: "inb_1", address: "a@omail.sh", podId: "pod_1" },
        { id: "inb_2", address: "b@omail.sh", podId: "pod_other" },
      ]),
      mintPodKey: vi.fn(async () => ({ id: "key_p", token: "omk_pod" })),
      ...over,
    });

  it("mints a pod key from an account key and resolves clientId", async () => {
    const api = podApi();
    const out = await provisionOpenMailPod({ api, accountId: "team", pod: "team-a", log: () => {} });
    expect(out).toEqual({ podId: "pod_1", apiKey: "omk_pod", name: "Team A", inboxCount: 1 });
    expect(api.mintPodKey).toHaveBeenCalledWith("pod_1", "openclaw:team");
  });

  it("resolves a unique name", async () => {
    const api = podApi();
    const out = await provisionOpenMailPod({ api, accountId: "team", pod: "team a", log: () => {} });
    expect(out.podId).toBe("pod_1");
  });

  it("keeps a pod key as-is (pod mint 403, inbox mint works)", async () => {
    const revokeInboxKey = vi.fn(async () => undefined);
    const api = podApi({ mintPodKey: vi.fn(async () => null), revokeInboxKey });
    const out = await provisionOpenMailPod({ api, accountId: "team", pod: "pod_1", log: () => {} });
    expect(out.apiKey).toBeUndefined();
    expect(out.podId).toBe("pod_1");
    expect(revokeInboxKey).toHaveBeenCalledWith("inb_1", "key_1");
  });

  it("refuses an inbox key that happens to see its pod (both mints 403)", async () => {
    const api = podApi({
      mintPodKey: vi.fn(async () => null),
      mintInboxKey: vi.fn(async () => null),
    });
    await expect(
      provisionOpenMailPod({ api, accountId: "team", pod: "pod_1", log: () => {} }),
    ).rejects.toThrow(/scoped to one inbox/);
  });

  it("refuses a pod the key cannot see", async () => {
    const api = podApi();
    await expect(
      provisionOpenMailPod({ api, accountId: "team", pod: "pod_x", log: () => {} }),
    ).rejects.toThrow(/not visible/);
    expect(api.mintPodKey).not.toHaveBeenCalled();
  });

  it("refuses an inbox key (sees no pods)", async () => {
    const api = podApi({ listPods: vi.fn(async () => []) });
    await expect(
      provisionOpenMailPod({ api, accountId: "team", pod: "pod_1", log: () => {} }),
    ).rejects.toThrow(/cannot see any pod/);
  });
});

describe("setup pod shape", () => {
  const apply = (input: Record<string, unknown>, cfg: Record<string, unknown> = {}) =>
    setupAdapter.applyAccountConfig({ cfg: cfg as never, accountId: "team", input: input as never });

  it("stores podId and clears a previous inboxId", () => {
    const before = apply({ apiKey: "k", inboxId: "inb_1" });
    expect(resolveOpenMailAccount({ cfg: before, accountId: "team" })).toMatchObject({
      scope: "inbox",
      inboxId: "inb_1",
      podId: null,
    });
    const after = apply({ apiKey: "omk_pod", pod: "pod_1" }, before);
    expect(resolveOpenMailAccount({ cfg: after, accountId: "team" })).toMatchObject({
      scope: "pod",
      inboxId: null,
      podId: "pod_1",
      configured: true,
    });
  });

  it("a named pod account does not inherit the root inbox", () => {
    const cfg = apply(
      { apiKey: "omk_pod", pod: "pod_1" },
      { channels: { openmail: { apiKey: "k", inboxId: "inb_root" } } },
    );
    expect(resolveOpenMailAccount({ cfg, accountId: "team" })).toMatchObject({ scope: "pod", inboxId: null });
    expect(resolveOpenMailAccount({ cfg, accountId: "default" })).toMatchObject({ scope: "inbox", inboxId: "inb_root" });
  });
});
