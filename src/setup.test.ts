import { describe, expect, it, vi } from "vitest";
import type { OpenMailApi, OpenMailInbox } from "./openmail-api.js";
import { normalizeAllowFrom, provisionOpenMailAccount } from "./setup.js";

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
    setInboundAllowlist: vi.fn(async () => "applied" as const),
    mintInboxKey: vi.fn(async () => ({ id: "key_1", token: "omk_scoped" })),
    ...over,
  } as unknown as OpenMailApi & Record<string, ReturnType<typeof vi.fn>>;
}

describe("provisionOpenMailAccount", () => {
  const base = { accountId: "sales", create: {}, keepKey: false, allowFrom: [] as string[], log: () => {} };

  it("resolves the key's single inbox and mints a scoped key", async () => {
    const api = mockApi();
    const out = await provisionOpenMailAccount({ ...base, api });
    expect(out).toEqual({ inboxId: "inb_1", apiKey: "omk_scoped", address: "sales@omail.sh", created: false });
    expect(api.mintInboxKey).toHaveBeenCalledWith("inb_1", "openclaw:sales");
    // Existing inbox + no allowFrom: leave whatever policy the user set alone.
    expect(api.setInboundAllowlist).not.toHaveBeenCalled();
  });

  it("keeps the given key when told to", async () => {
    const api = mockApi();
    const out = await provisionOpenMailAccount({ ...base, api, keepKey: true });
    expect(out.apiKey).toBeUndefined();
    expect(api.mintInboxKey).not.toHaveBeenCalled();
  });

  it("does not store a key when the one given is already inbox-scoped (mint 403)", async () => {
    const api = mockApi({ mintInboxKey: vi.fn(async () => null) });
    const out = await provisionOpenMailAccount({ ...base, api });
    expect(out.apiKey).toBeUndefined();
  });

  it("writes the server allowlist for a newly created inbox, even when empty (fail closed)", async () => {
    const api = mockApi();
    const log = vi.fn();
    await provisionOpenMailAccount({ ...base, api, create: { mailboxName: "sales" }, log });
    expect(api.createInbox).toHaveBeenCalledWith({ mailboxName: "sales" });
    expect(api.setInboundAllowlist).toHaveBeenCalledWith("inb_new", []);
    expect(log.mock.calls.flat().join("\n")).toMatch(/nobody can reach the agent yet/);
  });

  it("writes the allowlist before minting, so a pod key can still set policy", async () => {
    const order: string[] = [];
    const api = mockApi({
      setInboundAllowlist: vi.fn(async () => (order.push("policy"), "applied" as const)),
      mintInboxKey: vi.fn(async () => (order.push("mint"), { id: "k", token: "t" })),
    });
    await provisionOpenMailAccount({ ...base, api, allowFrom: ["ada@example.com"] });
    expect(order).toEqual(["policy", "mint"]);
  });

  it("explains inherited and forbidden policy outcomes", async () => {
    for (const [outcome, pattern] of [
      ["inherited", /inheriting your pod\/account allow rules/],
      ["forbidden", /cannot set the inbox's inbound policy/],
    ] as const) {
      const log = vi.fn();
      const api = mockApi({ setInboundAllowlist: vi.fn(async () => outcome) });
      await provisionOpenMailAccount({ ...base, api, allowFrom: ["a@b.com"], log });
      expect(log.mock.calls.flat().join("\n")).toMatch(pattern);
    }
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
