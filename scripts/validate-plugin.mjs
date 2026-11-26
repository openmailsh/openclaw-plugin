#!/usr/bin/env node
// Installs the built plugin into a throwaway OpenClaw state dir and asserts
// the host actually loads it: manifest parses, channel + CLI command register,
// the bundled skill is eligible, and the CLI passthrough refuses to leak
// credentials. Catches "builds fine, host rejects it" before publish.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const openclaw = fileURLToPath(new URL("../node_modules/.bin/openclaw", import.meta.url));

const stateDir = mkdtempSync(join(tmpdir(), "openmail-plugin-validate-"));
const env = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_DIR: stateDir,
  OPENCLAW_HOME: stateDir,
  PATH: `${dirname(openclaw)}${delimiter}${process.env.PATH ?? ""}`,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
};

process.on("exit", () => rmSync(stateDir, { recursive: true, force: true }));

function run(args, opts = {}) {
  return execFileSync(openclaw, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...opts,
  });
}

function fail(message, detail) {
  console.error(`\nvalidate-plugin FAILED: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function step(name, fn) {
  try {
    const out = fn();
    console.log(`ok  ${name}`);
    return out;
  } catch (error) {
    fail(name, error.stdout || error.stderr || String(error));
  }
}

step("install linked plugin", () => run(["plugins", "install", "--link", ".", "--force", "--accept-capabilities"]));

const inspect = step("inspect plugin runtime", () => run(["plugins", "inspect", "openmail", "--runtime"]));
if (!/Status:\s*loaded/.test(inspect)) fail("plugin did not load in the host runtime", inspect);
if (!/channel:\s*openmail/.test(inspect)) fail("manifest did not register the openmail channel", inspect);

step("configure a throwaway account", () =>
  run(["config", "set", "channels.openmail.accounts.validate.apiKey", "omk_validate_not_a_real_key"]),
);
step("configure inboxId", () =>
  run(["config", "set", "channels.openmail.accounts.validate.inboxId", "00000000-0000-0000-0000-000000000000"]),
);

// The passthrough must refuse flags that would redirect credentials.
for (const blocked of ["--api-key", "--base-url", "--state-path", "--api-key=x"]) {
  let leaked = false;
  try {
    run(["openmail", "--account", "validate", "--", "inbox", "list", blocked]);
    leaked = true;
  } catch (error) {
    const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (!/managed by the channel config/i.test(text)) fail(`CLI passthrough rejected ${blocked} for the wrong reason`, text);
  }
  if (leaked) fail(`CLI passthrough accepted ${blocked}`);
  console.log(`ok  passthrough blocks ${blocked}`);
}

const version = step("bundled CLI runs through passthrough", () =>
  run(["openmail", "--account", "validate", "--", "--version"]),
);
if (!/\d+\.\d+\.\d+/.test(version)) fail("bundled CLI did not print a version", version);

// Exercise the installed CLI through the real host, not only mocked spawn calls.
// An older bundled CLI can forward arguments successfully yet lack these commands.
const sendHelp = step("bundled CLI supports repeated To recipients", () =>
  run(["openmail", "--account", "validate", "--", "help", "send"]),
);
if (!/^\s*--to\s+<email>.*repeat/im.test(sendHelp)) fail("bundled CLI does not expose repeatable --to", sendHelp);

const draftHelp = step("bundled CLI exposes draft editing and deletion", () =>
  run(["openmail", "--account", "validate", "--", "help", "drafts"]),
);
for (const action of ["edit", "delete"]) {
  if (!new RegExp(`^\\s+${action} --draft-id`, "m").test(draftHelp)) {
    fail(`bundled CLI does not support drafts ${action}`, draftHelp);
  }
}

if (!/^\s+send --draft-id[^\n]*--send-at\b/m.test(draftHelp)) fail("bundled CLI cannot schedule a draft", draftHelp);

const attachmentHelp = step("bundled CLI exposes attachment IDs", () =>
  run(["openmail", "--account", "validate", "--", "help", "attachments"]),
);
for (const action of ["text", "get"]) {
  if (!new RegExp(`^\\s+${action}\\b.*--attachment-id\\b`, "m").test(attachmentHelp)) {
    fail(`bundled CLI does not expose --attachment-id for attachments ${action}`, attachmentHelp);
  }
}

const folderHelp = step("bundled CLI exposes folder browsing", () =>
  run(["openmail", "--account", "validate", "--", "help", "folders"]),
);
if (!/^\s+list\b/m.test(folderHelp) || !/^\s+messages --folder-id\b/m.test(folderHelp)) {
  fail("bundled CLI is missing a folder command", folderHelp);
}

const skills = step("list eligible skills", () => run(["skills", "list", "--eligible"]));
if (!/\bopenmail\b/.test(skills)) fail("openmail skill is not eligible", skills);

console.log("\nvalidate-plugin passed");
