import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpenMailCli, resolveBundledCliPath } from "./cli.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("openclaw/plugin-sdk/runtime", () => ({
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }) => ({ resolvedConfig: config, diagnostics: [] })),
}));

describe("draft deletion forwarding", () => {
  afterEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });

  it.each([
    ["drafts", "delete", "--draft-id", "d/1", "--updated-at", "2026-11-18T10:00:00.123Z", "--json"],
    ["drafts", "delete", "--draft-id", "d/1", "--updated-at", "2026-11-18T10:00:00.123Z", "--inbox-id", "owner"],
  ])("forwards deletion IDs and exact versions without interpreting them: %j", async (...args) => {
    const registerCli = vi.fn();
    registerOpenMailCli({ registerCli } as unknown as OpenClawPluginApi);
    let run!: (args: string[], opts: { account?: string }) => Promise<void>;
    const command = {
      command: vi.fn().mockReturnThis(), description: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(), allowUnknownOption: vi.fn().mockReturnThis(),
      allowExcessArguments: vi.fn().mockReturnThis(), argument: vi.fn().mockReturnThis(),
      action: (handler: typeof run) => { run = handler; },
    };
    registerCli.mock.calls[0][0]({ program: command, config: {
      channels: { openmail: { apiKey: "om_test", inboxId: "owner", baseUrl: "https://example.invalid" } },
    } });
    vi.mocked(spawn).mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child as ReturnType<typeof spawn>;
    });
    await run(args, {});
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [resolveBundledCliPath(), ...args], {
      stdio: "inherit",
      env: expect.objectContaining({ OPENMAIL_API_KEY: "om_test", OPENMAIL_INBOX_ID: "owner", OPENMAIL_BASE_URL: "https://example.invalid" }),
    });
    expect(process.exitCode).toBe(0);
  });
});
