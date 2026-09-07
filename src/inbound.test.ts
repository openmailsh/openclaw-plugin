import { describe, expect, it } from "vitest";
import { resolveInboxMode, type ResolvedOpenMailAccount } from "./accounts.js";
import { buildAgentText, parseAddress } from "./inbound.js";

function account(over: Partial<ResolvedOpenMailAccount> = {}): ResolvedOpenMailAccount {
  return {
    accountId: "default",
    name: undefined,
    enabled: true,
    configured: true,
    apiKey: "k",
    scope: "inbox",
    inboxId: "i",
    podId: null,
    baseUrl: "https://api.openmail.sh",
    mode: "channel",
    mediaMaxMb: 20,
    inboxes: {},
    ...over,
  };
}

describe("parseAddress", () => {
  it("extracts name and lowercases the address", () => {
    expect(parseAddress('"Ada Lovelace" <Ada@Example.com>')).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
    expect(parseAddress("Ada <ada@example.com>")).toEqual({ name: "Ada", address: "ada@example.com" });
    expect(parseAddress("  ADA@example.com ")).toEqual({ address: "ada@example.com" });
  });
});

describe("buildAgentText", () => {
  const base = {
    from: "ada@example.com",
    to: "agent@omail.sh",
    subject: "Invoice",
    threadId: "t1",
    messageId: "m1",
    body: "Please see attached.",
  };

  it("inlines server-extracted attachment text", () => {
    const text = buildAgentText({
      ...base,
      attachments: [{ filename: "inv.pdf", parsedText: "Amount due: 100" }],
      staged: { paths: [], types: [], skipped: [] },
    });
    expect(text).toContain("Attachments: inv.pdf");
    expect(text).toContain("--- inv.pdf (extracted text) ---\nAmount due: 100");
    expect(text).not.toContain("attachments text --message-id");
  });

  it("points at the CLI only when nothing was extracted or staged", () => {
    const text = buildAgentText({
      ...base,
      attachments: [{ filename: "photo.jpg" }],
      staged: { paths: [], types: [], skipped: ["photo.jpg"] },
    });
    expect(text).toContain('attachments text --message-id m1 --filename "photo.jpg"');
    expect(text).toContain("skipped, over the media size limit: photo.jpg");
  });

  it("truncates long extracted text", () => {
    const text = buildAgentText({
      ...base,
      attachments: [{ filename: "big.txt", parsedText: "x".repeat(50_000) }],
      staged: { paths: [], types: [], skipped: [] },
    });
    expect(text).toContain("(extracted text, truncated)");
    expect(text.length).toBeLessThan(10_000);
  });
});

describe("resolveInboxMode", () => {
  it("inherits the account mode without an override", () => {
    expect(resolveInboxMode(account({ mode: "notify" }), { id: "inb_1", address: "a@omail.sh" })).toBe("notify");
  });

  it("matches by id before address, and by lowercased address", () => {
    const a = account({ inboxes: { inb_1: { mode: "tool" }, "a@omail.sh": { mode: "notify" } } });
    expect(resolveInboxMode(a, { id: "inb_1", address: "A@omail.sh" })).toBe("tool");
    expect(resolveInboxMode(a, { id: "inb_2", address: "A@omail.sh" })).toBe("notify");
    expect(resolveInboxMode(a, { id: "inb_3" })).toBe("channel");
  });

  it("ignores an invalid override value", () => {
    const a = account({ inboxes: { inb_1: { mode: "shout" as never } } });
    expect(resolveInboxMode(a, { id: "inb_1" })).toBe("channel");
  });
});
