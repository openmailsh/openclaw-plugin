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
  OPENMAIL_MODES,
  type OpenMailMode,
  type ResolvedOpenMailAccount,
} from "./accounts.js";

type OpenMailSetupInput = ChannelSetupInput & {
  apiKey?: string;
  inboxId?: string;
  /** Pod id, clientId or (unique) name. Makes the account cover every inbox in the pod. */
  pod?: string;
  baseUrl?: string;
  mailboxName?: string;
  displayName?: string;
  /** Optional local sender filter. Empty (default): everyone the inbox receives from. */
  allowFrom?: string[] | string;
  mode?: OpenMailMode;
};

function describeMode(mode: OpenMailMode, where: string): string {
  if (mode === "notify") {
    return `Mode: notify. New mail at ${where} is summarised to you on your main chat; the agent does not reply by itself.`;
  }
  if (mode === "tool") return `Mode: tool. Nothing inbound wakes the agent; it uses ${where} only when you ask.`;
  return `Mode: channel. Mail to ${where} wakes the agent and it replies in the same thread.`;
}

function describeAllowFrom(allowFrom: string[], where: string): string {
  return allowFrom.length > 0
    ? `Only ${allowFrom.join(", ")} reach the agent (channels.openmail.allowFrom). Server-side allow/block rules are managed in the OpenMail console or CLI.`
    : `Anyone can email ${where} and reach the agent. To restrict senders, set --allow-from here, or manage allow/block rules in the OpenMail console or CLI.`;
}

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
    "Email for agents. Your agent gets its own address: it can receive mail, reply in-thread, send, and read attachments. Choose whether inbound mail wakes it, notifies you, or waits until asked.",
  order: 80,
} as const;

const baseSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: OPENMAIL_CHANNEL_ID,
  buildPatch: (input) => {
    const i = input as OpenMailSetupInput;
    const patch: Record<string, unknown> = {};
    const apiKey = normalizeOptionalString(i.apiKey);
    const inboxId = normalizeOptionalString(i.inboxId);
    // By the time we run, prepareAccountConfigInput has replaced the user's
    // `--pod <id|clientId|name>` with the resolved pod id.
    const podId = normalizeOptionalString(i.pod);
    const baseUrl = normalizeOptionalString(i.baseUrl);
    const allowFrom = normalizeAllowFrom(i.allowFrom);
    if (apiKey) patch.apiKey = apiKey;
    // One shape per account: switching clears the other id (undefined is
    // dropped when the config is written).
    if (podId) {
      patch.podId = podId;
      patch.inboxId = undefined;
    } else if (inboxId) {
      patch.inboxId = inboxId;
      patch.podId = undefined;
    }
    if (baseUrl) patch.baseUrl = baseUrl;
    if (allowFrom.length > 0) {
      patch.allowFrom = allowFrom;
      patch.dmPolicy = "allowlist";
    }
    if (i.mode && OPENMAIL_MODES.includes(i.mode)) patch.mode = i.mode;
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
  log: (line: string) => void;
}): Promise<{ inboxId: string; apiKey?: string; address: string; created: boolean }> {
  const { api, accountId, log } = params;

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

  const minted = await api.mintInboxKey(inbox.id, `openclaw:${accountId}`);
  if (!minted) {
    // 403: the key we hold is already inbox-scoped. Nothing to narrow.
    return { inboxId: inbox.id, address: inbox.address, created };
  }
  log(`Minted an inbox-scoped API key for ${inbox.address}; the key you passed is not stored.`);
  return { inboxId: inbox.id, apiKey: minted.token, address: inbox.address, created };
}

/**
 * Pod shape: the account covers every inbox in one pod.
 *
 *   account key  -> mint a pod-scoped key for `pod`, store THAT
 *   pod key      -> must be the key for `pod` (GET /v1/pods returns exactly it);
 *                   stored as-is. Mint returns 403 for such keys.
 *   inbox key    -> cannot see pods; refused.
 */
export async function provisionOpenMailPod(params: {
  api: OpenMailApi;
  accountId: string;
  pod: string;
  log: (line: string) => void;
}): Promise<{ podId: string; apiKey?: string; name: string; inboxCount: number }> {
  const { api, accountId, pod, log } = params;
  const visible = await api.listPods();
  const byName = visible.filter((p) => p.name?.toLowerCase() === pod.toLowerCase());
  const target =
    visible.find((p) => p.id === pod || p.clientId === pod) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!target) {
    if (byName.length > 1) {
      throw new Error(`Several pods are named "${pod}"; pass the id instead.`);
    }
    if (visible.length === 0) {
      throw new Error(
        "This key cannot see any pod. Use an account key (to mint a pod key) or the pod's own key.",
      );
    }
    const list = visible.map((p) => `  ${p.id}${p.clientId ? `  (${p.clientId})` : ""}  ${p.name ?? ""}`).join("\n");
    throw new Error(`Pod "${pod}" is not visible to this key. Pods it can see:\n${list}`);
  }
  const name = target.name ?? target.clientId ?? target.id;
  const podInboxes = (await api.listInboxes()).filter((i) => i.podId === target.id);
  const inboxCount = podInboxes.length;
  const minted = await api.mintPodKey(target.id, `openclaw:${accountId}`);
  if (!minted) {
    // 403: a pod key or an inbox key; both can see their pod. Only a pod key
    // can mint inbox keys, so probe with one (and revoke it at once). A pod
    // with no inboxes cannot have an inbox key, so nothing to probe there.
    const probeInbox = podInboxes[0];
    if (probeInbox) {
      const probe = await api.mintInboxKey(probeInbox.id, `openclaw:${accountId}:probe`);
      if (!probe) {
        throw new Error(
          `This key is scoped to one inbox, so it cannot cover pod ${name}. Use an account key or the pod's own key.`,
        );
      }
      await api.revokeInboxKey(probeInbox.id, probe.id).catch(() => undefined);
    }
    log(`Using pod ${name} (${target.id}), ${inboxCount} inbox(es).`);
    return { podId: target.id, name, inboxCount };
  }
  log(`Minted a pod-scoped API key for ${name} (${target.id}), ${inboxCount} inbox(es); the account key you passed is not stored.`);
  return { podId: target.id, apiKey: minted.token, name, inboxCount };
}

function ownInboxId(cfg: OpenClawConfig, accountId: string): string | undefined {
  const section = (cfg.channels?.[OPENMAIL_CHANNEL_ID] ?? {}) as {
    inboxId?: string;
    accounts?: Record<string, { inboxId?: string }>;
  };
  if (accountId === DEFAULT_ACCOUNT_ID) return normalizeOptionalString(section.inboxId);
  return normalizeOptionalString(section.accounts?.[accountId]?.inboxId);
}

export const setupAdapter: typeof baseSetupAdapter = {
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
    const mode: OpenMailMode = i.mode && OPENMAIL_MODES.includes(i.mode) ? i.mode : current.mode;
    const allowFrom = normalizeAllowFrom(i.allowFrom);

    const pod = normalizeOptionalString(i.pod) ?? (current.scope === "pod" ? current.podId ?? undefined : undefined);
    if (pod) {
      const result = await provisionOpenMailPod({ api, accountId, pod, log: (line) => runtime.log?.(line) });
      runtime.log?.(describeMode(mode, `any inbox in pod ${result.name}`));
      runtime.log?.(describeAllowFrom(allowFrom, `the pod's inboxes`));
      runtime.log?.(
        `The agent can create more inboxes in this pod (openclaw openmail -- inbox create --mailbox-name <name>); they join the channel automatically.`,
      );
      return {
        ...i,
        pod: result.podId,
        inboxId: undefined,
        ...(result.apiKey ? { apiKey: result.apiKey } : {}),
      } as typeof input;
    }

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
      log: (line) => runtime.log?.(line),
    });
    runtime.log?.(describeMode(mode, result.address));
    runtime.log?.(describeAllowFrom(allowFrom, result.address));
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
    pod: {
      kind: "string",
      cli: {
        flags: "--pod <id>",
        description:
          "Cover a whole pod instead of one inbox: every inbox in it, including ones the agent creates later. Pod id, clientId or name; a pod-scoped key is minted from an account key.",
      },
    },
    mailboxName: {
      kind: "string",
      cli: { flags: "--mailbox-name <name>", description: "Create a new inbox with this local part, e.g. sales -> sales@omail.sh" },
    },
    displayName: {
      kind: "string",
      cli: { flags: "--display-name <name>", description: "Sender name for a newly created inbox" },
    },
    mode: {
      kind: "choice",
      choices: OPENMAIL_MODES,
      cli: {
        flags: "--mode <mode>",
        description:
          "channel (default): mail wakes the agent, it replies in-thread. notify: agent tells you about new mail on your main chat, no auto-reply. tool: nothing inbound, email only when asked.",
      },
    },
    allowFrom: {
      kind: "string-list",
      cli: {
        flags: "--allow-from <senders>",
        description: "Optional local filter: only these senders (addresses or domains, comma-separated) reach the agent. Default: everyone.",
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
        message: "Restrict who reaches the agent? Addresses or domains, comma-separated. Empty = everyone.",
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
        "Restart the Gateway. channel mode: email the inbox, the agent replies in-thread. notify mode: the agent tells you about new mail on your usual chat. Change with --mode.",
        `Docs: ${formatDocsLink("/channels/openmail", "channels/openmail")}`,
      ],
    },
    disable: (cfg) => setSetupChannelEnabled(cfg, OPENMAIL_CHANNEL_ID, false),
  },
};
