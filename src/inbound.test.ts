import { describe, expect, it } from "vitest";
import type { ResolvedOpenMailAccount } from "./accounts.js";
import { buildAgentText, isSenderAllowed, parseAddress } from "./inbound.js";

function account(over: Partial<ResolvedOpenMailAccount> = {}): ResolvedOpenMailAccount {
  return {
    accountId: "default",
    name: undefined,
    enabled: true,
    configured: true,
    apiKey: "k",
    inboxId: "i",
    baseUrl: "https://api.openmail.sh",
    dmPolicy: undefined,
    allowFrom: [],
    allowNewThreads: false,
    mediaMaxMb: 20,
    ...over,
  };
}

describe("isSenderAllowed", () => {
  it("denies everyone when allowFrom is empty (fail closed)", () => {
    expect(isSenderAllowed(account(), "anyone@example.com")).toBe(false);
  });

  it("denies everyone with dmPolicy open but no '*' (misconfiguration stays closed)", () => {
    expect(isSenderAllowed(account({ dmPolicy: "open" }), "a@b.com")).toBe(false);
  });

  it("allows everyone only with an explicit '*'", () => {
    expect(isSenderAllowed(account({ allowFrom: ["*"] }), "a@b.com")).toBe(true);
    expect(isSenderAllowed(account({ dmPolicy: "open", allowFrom: ["*"] }), "a@b.com")).toBe(true);
  });

  it("disabled denies even with '*'", () => {
    expect(isSenderAllowed(account({ dmPolicy: "disabled", allowFrom: ["*"] }), "a@b.com")).toBe(false);
  });

  it("matches exact addresses case-insensitively", () => {
    const acc = account({ allowFrom: ["Alice@Example.com"] });
    expect(isSenderAllowed(acc, "alice@example.com")).toBe(true);
    expect(isSenderAllowed(acc, "bob@example.com")).toBe(false);
  });

  it("matches domains in every spelling the API accepts", () => {
    for (const entry of ["example.com", "@example.com", "*@example.com"]) {
      const acc = account({ allowFrom: [entry] });
      expect(isSenderAllowed(acc, "x@example.com"), entry).toBe(true);
      expect(isSenderAllowed(acc, "x@sub.example.com"), entry).toBe(false);
      expect(isSenderAllowed(acc, "x@notexample.com"), entry).toBe(false);
    }
  });

  it("'*.domain' matches the domain and its subdomains only", () => {
    const acc = account({ allowFrom: ["*.example.com"] });
    expect(isSenderAllowed(acc, "x@example.com")).toBe(true);
    expect(isSenderAllowed(acc, "x@mail.example.com")).toBe(true);
    expect(isSenderAllowed(acc, "x@example.com.evil.io")).toBe(false);
    expect(isSenderAllowed(acc, "x@fakeexample.com")).toBe(false);
  });

  it("ignores blank entries", () => {
    expect(isSenderAllowed(account({ allowFrom: ["", "  "] }), "a@b.com")).toBe(false);
  });
});

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
