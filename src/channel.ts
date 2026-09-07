// Full channel plugin: setup surface + status + gateway lifecycle + outbound.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildBaseChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listOpenMailAccountIds,
  OPENMAIL_CHANNEL_ID,
  resolveDefaultOpenMailAccountId,
  resolveOpenMailAccount,
  type ResolvedOpenMailAccount,
} from "./accounts.js";
import { openmailChannelConfigSchema } from "./config-schema.js";
import { startOpenMailGatewayAccount } from "./gateway.js";
import { OpenMailApi } from "./openmail-api.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { OPENMAIL_META, openmailSetupPlugin } from "./setup.js";

type OpenMailProbe =
  | { ok: true; address: string; error: null }
  | { ok: false; address: null; error: string };

function stripPrefix(to: string): string {
  return to.replace(/^(openmail|email|mail):/i, "").trim();
}

export const openmailPlugin: ChannelPlugin<ResolvedOpenMailAccount, OpenMailProbe> =
  createChatChannelPlugin({
    base: {
      id: OPENMAIL_CHANNEL_ID,
      meta: OPENMAIL_META,
      capabilities: { chatTypes: ["direct"], threads: true },
      setupContract: openmailSetupPlugin.setupContract,
      setupWizard: openmailSetupPlugin.setupWizard,
      reload: { configPrefixes: ["channels.openmail"] },
      configSchema: openmailChannelConfigSchema,
      config: {
        listAccountIds: listOpenMailAccountIds,
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
          resolveOpenMailAccount({ cfg, accountId }),
        defaultAccountId: resolveDefaultOpenMailAccountId,
        isConfigured: (account) => account.configured,
        isEnabled: (account) => account.enabled,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: { inboxId: account.inboxId, baseUrl: account.baseUrl },
          }),
      },
      status: createComputedAccountStatusAdapter<ResolvedOpenMailAccount, OpenMailProbe>({
        defaultRuntime: createDefaultChannelRuntimeState("default"),
        buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
        probeAccount: async ({ account }) => {
          if (!account.apiKey || !account.inboxId) {
            return { ok: false, address: null, error: "missing apiKey or inboxId" };
          }
          try {
            const inbox = await new OpenMailApi(account.baseUrl, account.apiKey).getInbox(account.inboxId);
            return { ok: true, address: inbox.address, error: null };
          } catch (err) {
            return { ok: false, address: null, error: String(err) };
          }
        },
        formatCapabilitiesProbe: ({ probe }) => [
          probe.ok
            ? { text: `Inbox: ${probe.address}` }
            : { text: `Inbox: unreachable (${probe.error})`, tone: "error" as const },
        ],
        collectStatusIssues: (accounts) =>
          accounts.flatMap((account) =>
            account.configured
              ? []
              : [
                  {
                    channel: OPENMAIL_CHANNEL_ID,
                    accountId: account.accountId,
                    kind: "config",
                    message: "OpenMail account is missing apiKey or inboxId",
                    fix: "Run `openclaw channels add openmail --api-key <key> --inbox-id <id>`.",
                  },
                ],
          ),
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name ?? undefined,
          enabled: account.enabled,
          configured: account.configured,
          extra: { inboxId: account.inboxId },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => await startOpenMailGatewayAccount(ctx),
      },
      secrets: { secretTargetRegistryEntries, collectRuntimeConfigAssignments },
      messaging: {
        targetPrefixes: ["openmail", "email", "mail"],
        targetIdComparison: "lowercase",
        // A target is an email address, optionally prefixed.
        normalizeTarget: (raw) => {
          const address = stripPrefix(raw).toLowerCase();
          return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : undefined;
        },
        inferTargetChatType: () => "direct",
        targetResolver: {
          looksLikeId: (raw) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stripPrefix(raw)),
          hint: "an email address, e.g. person@example.com",
        },
      },
    },
    // Proactive sends (agent-initiated, cron, `openclaw message send`). In-thread
    // replies to inbound mail go through the turn's delivery adapter instead.
    outbound: {
      base: {
        deliveryMode: "direct",
        textChunkLimit: 100_000,
      },
      attachedResults: {
        channel: OPENMAIL_CHANNEL_ID,
        sendText: async ({ cfg, to, text, accountId, threadId }) => {
          const account = resolveOpenMailAccount({ cfg, accountId });
          if (!account.apiKey || !account.inboxId) {
            throw new Error("OpenMail account is not configured");
          }
          const api = new OpenMailApi(account.baseUrl, account.apiKey);
          const address = stripPrefix(to);
          const thread = threadId ? String(threadId) : undefined;
          if (!thread && !account.allowNewThreads) {
            // Reply-only by default: an injected "forward this to x@y" cannot
            // become a fresh email to an arbitrary address. Replies stay bound
            // to the thread that triggered them.
            throw new Error(
              `OpenMail channel is reply-only: cannot start a new thread to ${address}. Set channels.openmail.allowNewThreads: true to enable proactive email.`,
            );
          }
          const result = thread
            ? await api.sendReply({ inboxId: account.inboxId, to: address, threadId: thread, body: text })
            : await api.sendNew({
                inboxId: account.inboxId,
                to: address,
                subject: firstLineAsSubject(text),
                body: text,
              });
          return { messageId: String(result.id ?? result.messageId ?? "") };
        },
      },
    },
  });

function firstLineAsSubject(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "Message from your agent";
  return line.length > 78 ? `${line.slice(0, 75)}...` : line;
}
