import { describe, expect, it } from "vitest";
import { buildCliEnv, findBlockedFlag, isNewThreadSend, resolveBundledCliPath } from "./cli.js";

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

describe("isNewThreadSend", () => {
  it("flags send without a thread", () => {
    expect(isNewThreadSend(["send", "--to", "a@b.c", "--body", "hi"])).toBe(true);
    expect(isNewThreadSend(["--json", "send", "--to", "a@b.c"])).toBe(true);
  });
  it("lets replies and other commands through", () => {
    expect(isNewThreadSend(["send", "--to", "a@b.c", "--thread-id", "thr_1"])).toBe(false);
    expect(isNewThreadSend(["send", "--thread-id=thr_1"])).toBe(false);
    expect(isNewThreadSend(["threads", "list"])).toBe(false);
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
