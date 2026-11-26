import { describe, expect, it } from "vitest";
import { resolveInboxMode, type ResolvedOpenMailAccount } from "./accounts.js";
import { buildReplyInput, parseAddress } from "./inbound.js";

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

describe("buildReplyInput", () => {
  const message = { id: "message-id", threadId: "thread-id", fromAddr: "ada@example.com", bodyText: "Please review." };
  it("passes extracted text and names as external content without file handles", () => {
    const input = buildReplyInput({ ...message, attachments: [
      { id: "private-file-id", filename: "report.pdf", parsedText: "The total is 100.", url: "private-url" },
    ] });
    expect(input).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(input).toContain("Attachment: report.pdf\nThe total is 100.");
    expect(input).not.toMatch(/private-|message-id|thread-id/);
  });

  it.each([
    [{ filename: "photo.png" }],
    [{ filename: "report.txt", parsedText: "x".repeat(8001) }],
    Array.from({ length: 4 }, () => ({ filename: "report.txt", parsedText: "x".repeat(7000) })),
  ].map(attachments => ({ attachments })))("requires complete extracted text within budget", ({ attachments }) => {
    expect(buildReplyInput({ ...message, attachments })).toBeUndefined();
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
