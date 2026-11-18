import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliEnv, cliSecretPaths, findBlockedFlag, registerOpenMailCli, resolveBundledCliPath } from "./cli.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("openclaw/plugin-sdk/runtime", () => ({
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }) => ({ resolvedConfig: config, diagnostics: [] })),
}));

describe("draft CLI forwarding", () => {
  afterEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });

  it.each([
    ["drafts", "create", "--inbox-id", "owner", "--body-html", "<p>Proposal & details</p>", "--json"],
    ["drafts", "edit", "--draft-id", "d/1", "--updated-at", "2026-11-18T10:00:00.123Z", "--body-html", "<p>Revised</p>", "--json"],
    ["drafts", "edit", "--draft-id", "d/1", "--updated-at", "2026-11-18T10:00:00.123Z", "--body-html", "", "--clear-cc"],
  ])("forwards HTML draft arguments and exact versions without interpreting them: %j", async (...args) => {
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

describe("cliSecretPaths", () => {
  it("covers the account's own apiKey and the inheritable root one, nothing else", () => {
    expect([...cliSecretPaths("work")].sort()).toEqual([
      "channels.openmail.accounts.work.apiKey",
      "channels.openmail.apiKey",
    ]);
  });

  it("normalises the account id the way the config stores it", () => {
    expect(cliSecretPaths(" Work ")).toContain("channels.openmail.accounts.work.apiKey");
  });
});

describe("findBlockedFlag", () => {
  it("catches credential/endpoint flags in both spellings", () => {
    expect(findBlockedFlag(["inbox", "list", "--api-key", "x"])).toBe("--api-key");
    expect(findBlockedFlag(["--base-url=https://evil"])).toBe("--base-url=https://evil");
    expect(findBlockedFlag(["--state-path", "/tmp/x"])).toBe("--state-path");
  });

  it("lets ordinary args through", () => {
    expect(findBlockedFlag(["threads", "list", "--json", "--limit", "5"])).toBeUndefined();
    expect(findBlockedFlag(["--api-key-file"])).toBeUndefined();
  });
});

describe("buildCliEnv", () => {
  const account = { apiKey: "omk_x", inboxId: "inb", baseUrl: "https://api.openmail.sh" };

  it("injects channel credentials and pins the CLI state path", () => {
    const env = buildCliEnv({ HOME: "/home/u", PATH: "/bin" }, account);
    expect(env.OPENMAIL_API_KEY).toBe("omk_x");
    expect(env.OPENMAIL_INBOX_ID).toBe("inb");
    expect(env.OPENMAIL_BASE_URL).toBe("https://api.openmail.sh");
    expect(env.OPENMAIL_STATE_PATH).toBe("/home/u/.openclaw/openmail/cli-state.json");
    expect(env.PATH).toBe("/bin");
  });

  it("overrides any OPENMAIL_* the caller had and strips proxy vars", () => {
    const env = buildCliEnv(
      {
        OPENMAIL_API_KEY: "attacker",
        OPENMAIL_BASE_URL: "https://evil",
        HTTPS_PROXY: "http://evil:8080",
        http_proxy: "http://evil:8080",
        ALL_PROXY: "socks://evil",
        NO_PROXY: "",
        KEEP: "1",
      },
      account,
    );
    expect(env.OPENMAIL_API_KEY).toBe("omk_x");
    expect(env.OPENMAIL_BASE_URL).toBe("https://api.openmail.sh");
    for (const k of ["HTTPS_PROXY", "http_proxy", "ALL_PROXY", "NO_PROXY"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.KEEP).toBe("1");
  });
});

describe("resolveBundledCliPath", () => {
  it("points at the bundled @openmail/cli entry", () => {
    expect(resolveBundledCliPath()).toMatch(/@openmail[\\/]cli[\\/]dist[\\/]index\.js$/);
  });
});

describe("buildCliEnv pod scope", () => {
  it("leaves OPENMAIL_INBOX_ID unset so commands pick their own inbox", () => {
    const env = buildCliEnv(
      { HOME: "/home/u", OPENMAIL_INBOX_ID: "stale" },
      { apiKey: "omk_pod", inboxId: null, baseUrl: "https://api.openmail.sh" },
    );
    expect(env.OPENMAIL_INBOX_ID).toBeUndefined();
    expect(env.OPENMAIL_API_KEY).toBe("omk_pod");
  });
});
