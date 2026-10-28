// `openclaw openmail -- <args>`: run the bundled OpenMail CLI with the
// channel's credentials. This is what the skill tells the agent to call, so
// the agent never sees the key and the CLI never needs its own setup.
//
// Credentials come only from the resolved account config (inbox-scoped key
// minted at `channels add`); argument flags cannot override them, and proxy
// env is stripped so a poisoned environment cannot redirect requests.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveCommandSecretRefsViaGateway } from "openclaw/plugin-sdk/runtime";
import {
  OPENMAIL_CHANNEL_ID,
  type ResolvedOpenMailAccount,
  resolveDefaultOpenMailAccountId,
  resolveOpenMailAccount,
} from "./accounts.js";
import { secretTargetRegistryEntries } from "./secret-contract.js";

const BLOCKED_FLAGS = new Set(["--api-key", "--base-url", "--state-path"]);
const STRIPPED_ENV = /^(https?_proxy|all_proxy|no_proxy)$/i;
const SECRET_TARGET_IDS = new Set(secretTargetRegistryEntries.map((entry) => entry.id));

/**
 * Config paths whose SecretRefs this command needs: the account's own apiKey
 * and the root one it may inherit. Other accounts' refs are left alone so an
 * unrelated unresolvable ref cannot block this one.
 */
export function cliSecretPaths(accountId: string): Set<string> {
  return new Set([
    `channels.${OPENMAIL_CHANNEL_ID}.apiKey`,
    `channels.${OPENMAIL_CHANNEL_ID}.accounts.${accountId}.apiKey`,
  ]);
}

/**
 * The CLI context hands plugins the raw config file, so a SecretRef apiKey is
 * still `{ source, provider, id }` here. Ask the running gateway for the
 * resolved value (falling back to local resolution) the way OpenClaw's own
 * `message` command does, so this command works wherever sending does.
 */
async function resolveCliConfig(config: OpenClawConfig, accountId: string): Promise<OpenClawConfig> {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config,
    commandName: "openmail",
    targetIds: SECRET_TARGET_IDS,
    allowedPaths: cliSecretPaths(accountId),
  });
  for (const entry of diagnostics) console.error(`[secrets] ${entry}`);
  return resolvedConfig;
}

export function resolveBundledCliPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@openmail/cli/package.json");
  return path.join(path.dirname(pkg), "dist", "index.js");
}

/** Reject attempts to swap credentials or endpoint from the argument list. */
export function findBlockedFlag(args: readonly string[]): string | undefined {
  return args.find((a) => BLOCKED_FLAGS.has(a) || [...BLOCKED_FLAGS].some((f) => a.startsWith(`${f}=`)));
}

export function buildCliEnv(base: NodeJS.ProcessEnv, account: {
  apiKey: string;
  inboxId: string | null;
  baseUrl: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!STRIPPED_ENV.test(k) && k !== "OPENMAIL_INBOX_ID") env[k] = v;
  }
  env.OPENMAIL_API_KEY = account.apiKey;
  // Pod scope has no single inbox: commands take --inbox-id, or the CLI
  // picks the first one the key sees.
  if (account.inboxId) env.OPENMAIL_INBOX_ID = account.inboxId;
  env.OPENMAIL_BASE_URL = account.baseUrl;
  // Keep the CLI's own state file away from any user install.
  env.OPENMAIL_STATE_PATH = path.join(base.HOME ?? "", ".openclaw", "openmail", "cli-state.json");
  return env;
}

export function registerOpenMailCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, config }) => {
      program
        .command("openmail")
        .description("Run the OpenMail CLI with this channel's inbox credentials")
        .option("--account <id>", "OpenMail channel account to use")
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .argument("[args...]", "arguments passed to the openmail CLI (after --)")
        .action(async (args: string[], opts: { account?: string }) => {
          const accountId = opts.account ?? resolveDefaultOpenMailAccountId(config);
          let account: ResolvedOpenMailAccount;
          try {
            account = resolveOpenMailAccount({ cfg: await resolveCliConfig(config, accountId), accountId });
          } catch (err) {
            console.error(`failed to resolve OpenMail account "${accountId}": ${String(err)}`);
            process.exitCode = 1;
            return;
          }
          if (!account.apiKey || !(account.inboxId || account.podId)) {
            console.error(
              `OpenMail account "${accountId}" is not configured. Run: openclaw channels add --channel openmail --api-key <key>`,
            );
            process.exitCode = 1;
            return;
          }
          const blocked = findBlockedFlag(args);
          if (blocked) {
            console.error(`${blocked} is managed by the channel config and cannot be passed here.`);
            process.exitCode = 1;
            return;
          }
          const child = spawn(process.execPath, [resolveBundledCliPath(), ...args], {
            stdio: "inherit",
            env: buildCliEnv(process.env, {
              apiKey: account.apiKey,
              inboxId: account.inboxId,
              baseUrl: account.baseUrl,
            }),
          });
          await new Promise<void>((resolve) => {
            child.on("exit", (code) => {
              process.exitCode = code ?? 1;
              resolve();
            });
            child.on("error", (err) => {
              console.error(`failed to start openmail CLI: ${String(err)}`);
              process.exitCode = 1;
              resolve();
            });
          });
        });
    },
    {
      commands: ["openmail"],
      descriptors: [
        { name: "openmail", description: "OpenMail CLI with the channel's credentials", hasSubcommands: false },
      ],
    },
  );
}
