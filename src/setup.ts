// Setup surface: `openclaw channels add openmail --api-key ... --inbox-id ...`
// and the onboarding wizard. Kept import-light so setup never loads `ws`.
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPatchedAccountSetupAdapter,
  formatDocsLink,
  setSetupChannelEnabled,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { OpenMailApi, type OpenMailInbox } from "./openmail-api.js";
import {
  listOpenMailAccountIds,
  OPENMAIL_CHANNEL_ID,
  resolveDefaultOpenMailAccountId,
  resolveOpenMailAccount,
  type ResolvedOpenMailAccount,
} from "./accounts.js";

type OpenMailSetupInput = ChannelSetupInput & {
  apiKey?: string;
  inboxId?: string;
  baseUrl?: string;
  mailboxName?: string;
  displayName?: string;
  /** Skip minting an inbox-scoped key; store the given key as-is. */
  keepKey?: boolean;
  /** Senders allowed to reach the agent. `*` opens the inbox to everyone. */
  allowFrom?: string[] | string;
};

/** "a@x.com, y.com" | ["a@x.com","y.com"] -> lowercased, deduped list. */
export function normalizeAllowFrom(raw: string[] | string | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  return [...new Set(parts.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

export const OPENMAIL_META = {
  id: OPENMAIL_CHANNEL_ID,
  label: "OpenMail",
  selectionLabel: "OpenMail (email)",
  docsPath: "/channels/openmail",
  docsLabel: "openmail",
  blurb:
    "Give your agent its own email address. Inbound mail wakes the agent; replies go out in-thread. Needs an inbox to exist; creates one if the key has none.",
  order: 80,
} as const;

const baseSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: OPENMAIL_CHANNEL_ID,
  buildPatch: (input) => {
    const i = input as OpenMailSetupInput;
    const patch: Record<string, string | string[]> = {};
    const apiKey = normalizeOptionalString(i.apiKey);
    const inboxId = normalizeOptionalString(i.inboxId);
    const baseUrl = normalizeOptionalString(i.baseUrl);
    const allowFrom = normalizeAllowFrom(i.allowFrom);
    if (apiKey) patch.apiKey = apiKey;
    if (inboxId) patch.inboxId = inboxId;
    if (baseUrl) patch.baseUrl = baseUrl;
    if (allowFrom.length > 0) {
      patch.allowFrom = allowFrom;
      patch.dmPolicy = allowFrom.includes("*") ? "open" : "allowlist";
    }
    return patch;
  },
});

/**
 * Turn whatever key the user gave us into the narrowest key that works.
 *
 *   inbox-scoped key      -> stored as-is (it cannot mint; 403 tells us so)
 *   account/pod key       -> pick or create the inbox, mint an inbox-scoped
 *                            key for it, store THAT. The broad key is never
 *                            written to openclaw.json.
 *
 * Re-running against an already-provisioned account is a no-op: the stored
 * key is inbox-scoped, so the 403 path short-circuits.
 */
export async function provisionOpenMailAccount(params: {
  api: OpenMailApi;
  accountId: string;
  inboxId?: string;
  create: { mailboxName?: string; displayName?: string };
  keepKey: boolean;
  allowFrom: string[];
  log: (line: string) => void;
}): Promise<{ inboxId: string; apiKey?: string; address: string; created: boolean }> {
  const { api, accountId, keepKey, allowFrom, log } = params;

  let inbox: OpenMailInbox;
  let created = false;
  const wantsNew = Boolean(params.create.mailboxName || params.create.displayName);
  if (params.inboxId) {
    inbox = await api.getInbox(params.inboxId);
  } else if (wantsNew) {
    inbox = await api.createInbox(params.create);
    created = true;
  } else {
    const result = await api.resolveInbox({ displayName: `OpenClaw ${accountId}` });
    if (result.kind === "ambiguous") {
      const list = result.inboxes.map((x) => `  ${x.id}  ${x.address}`).join("\n");
      throw new Error(
        `This key can see ${result.inboxes.length} inboxes. Pick one with --inbox-id <id>, or create a new one with --mailbox-name <name>:\n${list}`,
      );
    }
    inbox = result.inbox;
    created = result.created;
  }
  log(
    created
      ? `Created OpenMail inbox ${inbox.address} (${inbox.id}) on your account.`
      : `Using OpenMail inbox ${inbox.address} (${inbox.id}).`,
  );

  // Server-side gate, set before we narrow the key (inbox keys cannot set
  // policy). Only for inboxes we created or when the user gave a list: an
  // existing inbox may carry a policy the user configured elsewhere.
  if (created || allowFrom.length > 0) {
    const outcome = await api.setInboundAllowlist(inbox.id, allowFrom);
    if (outcome === "forbidden") {
      log("Note: this key cannot set the inbox's inbound policy; only the local allowFrom filter applies.");
    } else if (outcome === "inherited") {
      log(
        `Inbound policy: allowlist, inheriting your pod/account allow rules (a pod key cannot add its own). Locally only ${allowFrom.join(", ")} reach the agent.`,
      );
    } else if (allowFrom.includes("*")) {
      log(`Inbound policy: open. Anyone can email ${inbox.address} and reach the agent.`);
    } else if (allowFrom.length > 0) {
      log(`Inbound policy: allowlist (${allowFrom.join(", ")}). Other senders are rejected server-side.`);
    } else {
      log(
        `Inbound policy: allowlist, currently empty, so nobody can reach the agent yet. Re-run with --allow-from you@example.com (or "*" to open it).`,
      );
    }
  }

  if (keepKey) {
    return { inboxId: inbox.id, address: inbox.address, created };
  }

  const minted = await api.mintInboxKey(inbox.id, `openclaw:${accountId}`);
  if (!minted) {
    // 403: the key we hold is already inbox-scoped. Nothing to narrow.
    return { inboxId: inbox.id, address: inbox.address, created };
  }
  log(`Minted an inbox-scoped API key for ${inbox.address}; the key you passed is not stored.`);
  return { inboxId: inbox.id, apiKey: minted.token, address: inbox.address, created };
}

function ownInboxId(cfg: OpenClawConfig, accountId: string): string | undefined {
  const section = (cfg.channels?.[OPENMAIL_CHANNEL_ID] ?? {}) as {
    inboxId?: string;
    accounts?: Record<string, { inboxId?: string }>;
  };
  if (accountId === DEFAULT_ACCOUNT_ID) return normalizeOptionalString(section.inboxId);
  return normalizeOptionalString(section.accounts?.[accountId]?.inboxId);
}

const setupAdapter: typeof baseSetupAdapter = {
  ...baseSetupAdapter,
  // Runs before the config write, so what lands in openclaw.json is the
  // resolved inbox id and (when we could mint one) an inbox-scoped key.
  prepareAccountConfigInput: async ({ cfg, accountId, input, runtime }) => {
    const i = input as OpenMailSetupInput;
    const current = resolveOpenMailAccount({ cfg, accountId });
    const apiKey = normalizeOptionalString(i.apiKey) ?? current.apiKey;
    if (!apiKey) return input;

    const baseUrl = normalizeOptionalString(i.baseUrl) ?? current.baseUrl;
    const api = new OpenMailApi(baseUrl, apiKey);
    const result = await provisionOpenMailAccount({
      api,
      accountId,
      // Not `current.inboxId`: named accounts inherit root fields through the
      // account merge, and a new account must not adopt the default inbox.
      inboxId: normalizeOptionalString(i.inboxId) ?? ownInboxId(cfg, accountId),
      create: {
        mailboxName: normalizeOptionalString(i.mailboxName),
        displayName: normalizeOptionalString(i.displayName),
      },
      keepKey: i.keepKey === true,
      allowFrom: normalizeAllowFrom(i.allowFrom),
      log: (line) => runtime.log?.(line),
    });
    runtime.log?.(`Email ${result.address} to talk to this agent.`);
    return {
      ...i,
      inboxId: result.inboxId,
      ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    } as typeof input;
  },
  validateInput: ({ cfg, accountId, input }) => {
    const i = input as OpenMailSetupInput;
    const current = resolveOpenMailAccount({ cfg, accountId });
    const apiKey = normalizeOptionalString(i.apiKey) ?? current.apiKey;
    if (!apiKey) {
      return "OpenMail needs an API key (--api-key). Create one with `openmail inbox keys create` or at https://app.openmail.sh.";
    }
    return null;
  },
};

export const openmailSetupContract = defineChannelSetupContract({
  fields: {
    apiKey: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--api-key <key>", description: "OpenMail API key (any scope; an inbox-scoped key is minted for you)" },
    },
    inboxId: {
      kind: "string",
      cli: { flags: "--inbox-id <id>", description: "Use an existing inbox (only needed when the key can see several)" },
    },
    mailboxName: {
      kind: "string",
      cli: { flags: "--mailbox-name <name>", description: "Create a new inbox with this local part, e.g. sales -> sales@omail.sh" },
    },
    displayName: {
      kind: "string",
      cli: { flags: "--display-name <name>", description: "Sender name for a newly created inbox" },
    },
    keepKey: {
      kind: "boolean",
      cli: { flags: "--keep-key", description: "Store the given key as-is instead of minting an inbox-scoped key" },
    },
    allowFrom: {
      kind: "string-list",
      cli: {
        flags: "--allow-from <senders>",
        description: 'Who may email the agent: addresses or domains, comma-separated. "*" opens it to everyone. Default: nobody.',
      },
    },
    baseUrl: {
      kind: "string",
      cli: { flags: "--base-url <url>", description: "OpenMail API base URL (default https://api.openmail.sh)" },
    },
  },
  legacyAdapter: setupAdapter,
});

export const openmailSetupPlugin: ChannelPlugin<ResolvedOpenMailAccount> = {
  id: OPENMAIL_CHANNEL_ID,
  meta: OPENMAIL_META,
  capabilities: { chatTypes: ["direct"] },
  setupContract: openmailSetupContract,
  config: {
    listAccountIds: listOpenMailAccountIds,
    resolveAccount: (cfg, accountId) => resolveOpenMailAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultOpenMailAccountId,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
  },
  setupWizard: {
    channel: OPENMAIL_CHANNEL_ID,
    resolveShouldPromptAccountIds: () => false,
    status: {
      configuredLabel: "configured",
      unconfiguredLabel: "needs an API key and inbox id",
      configuredHint: "configured",
      unconfiguredHint: "create an inbox at app.openmail.sh",
      configuredScore: 1,
      unconfiguredScore: 3,
      resolveConfigured: ({ cfg, accountId }) =>
        accountId
          ? resolveOpenMailAccount({ cfg, accountId }).configured
          : listOpenMailAccountIds(cfg).some(
              (id) => resolveOpenMailAccount({ cfg, accountId: id }).configured,
            ),
    },
    introNote: {
      title: "OpenMail setup",
      lines: [
        "Paste any OpenMail API key (dashboard: app.openmail.sh -> API keys).",
        "With an account key, OpenClaw picks your inbox (or creates one if you have none)",
        "and mints an inbox-scoped key for it; the account key itself is never stored.",
        `Docs: ${formatDocsLink("/channels/openmail", "channels/openmail")}`,
      ],
    },
    credentials: [],
    textInputs: [
      {
        inputKey: "apiKey",
        message: "OpenMail API key",
        sensitive: true,
        required: true,
        currentValue: ({ cfg, accountId }) =>
          resolveOpenMailAccount({ cfg, accountId }).apiKey ?? undefined,
        validate: ({ value }) => (normalizeOptionalString(value) ? undefined : "Required"),
        normalizeValue: ({ value }) => normalizeOptionalString(value) ?? "",
      },
      {
        inputKey: "inboxId",
        message: "OpenMail inbox id (leave empty to resolve from the key)",
        required: false,
        applyEmptyValue: false,
        currentValue: ({ cfg, accountId }) =>
          resolveOpenMailAccount({ cfg, accountId }).inboxId ?? undefined,
        normalizeValue: ({ value }) => normalizeOptionalString(value) ?? "",
      },
      {
        inputKey: "allowFrom",
        message: 'Who may email the agent? Addresses or domains, comma-separated. "*" = anyone. Empty = nobody yet.',
        required: false,
        applyEmptyValue: false,
        currentValue: ({ cfg, accountId }) => {
          const list = resolveOpenMailAccount({ cfg, accountId }).allowFrom;
          return list.length > 0 ? list.join(", ") : undefined;
        },
        normalizeValue: ({ value }) => normalizeAllowFrom(value).join(","),
      },
    ],
    completionNote: {
      title: "OpenMail next steps",
      lines: [
        "Restart the Gateway. Send an email to the inbox address; the agent replies in the same thread.",
        `Docs: ${formatDocsLink("/channels/openmail", "channels/openmail")}`,
      ],
    },
    disable: (cfg) => setSetupChannelEnabled(cfg, OPENMAIL_CHANNEL_ID, false),
  },
};
