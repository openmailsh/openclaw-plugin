// Account resolution: each OpenClaw "account" is one OpenMail inbox.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENMAIL_CHANNEL_ID = "openmail" as const;
export const DEFAULT_BASE_URL = "https://api.openmail.sh";
/** Aggregate size of inbound attachments staged for the agent per message. */
export const DEFAULT_MEDIA_MAX_MB = 20;

/**
 *  channel  inbound mail wakes the agent, it replies in-thread (default)
 *  notify   inbound mail is summarised to you on your main chat; no auto-reply
 *  tool     nothing inbound; the agent only uses email when you ask (CLI skill)
 */
export const OPENMAIL_MODES = ["channel", "notify", "tool"] as const;
export type OpenMailMode = (typeof OPENMAIL_MODES)[number];

export type OpenMailAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Literal key or a SecretRef ({ source: "env" | "store" | "file", provider, id }). */
  apiKey?: SecretInput;
  inboxId?: string;
  baseUrl?: string;
  dmPolicy?: string;
  allowFrom?: string[];
  mode?: OpenMailMode;
  /** Let the agent open new email threads (proactive sends). Default false: reply-only. */
  allowNewThreads?: boolean;
  /** Aggregate cap for inbound attachments handed to the agent. 0 disables staging. */
  mediaMaxMb?: number;
  accounts?: Record<string, OpenMailAccountConfig>;
  defaultAccount?: string;
};

export type ResolvedOpenMailAccount = {
  accountId: string;
  name: string | undefined;
  enabled: boolean;
  configured: boolean;
  apiKey: string | null;
  inboxId: string | null;
  baseUrl: string;
  dmPolicy: string | undefined;
  allowFrom: string[];
  mode: OpenMailMode;
  allowNewThreads: boolean;
  mediaMaxMb: number;
};

const {
  listAccountIds,
  resolveDefaultAccountId,
  resolveAccountConfig: resolveMergedAccountConfig,
} = createAccountListHelpers<OpenMailAccountConfig>(OPENMAIL_CHANNEL_ID, {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  implicitDefaultAccount: {
    channelKeys: ["apiKey", "inboxId"],
    envVars: ["OPENMAIL_API_KEY", "OPENMAIL_INBOX_ID"],
  },
});

export const listOpenMailAccountIds = listAccountIds;
export const resolveDefaultOpenMailAccountId = resolveDefaultAccountId;

function channelConfig(cfg: OpenClawConfig): OpenMailAccountConfig | undefined {
  return cfg.channels?.[OPENMAIL_CHANNEL_ID] as OpenMailAccountConfig | undefined;
}

/**
 * Literal string, or a SecretRef the host has already materialised. A ref
 * that is still unresolved throws with the config path, which is what we want
 * at gateway start: a loud "secret not available" beats a silent 401.
 */
function resolveApiKey(value: unknown, fallback: string | undefined, path: string): string | null {
  const present =
    value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
  return normalizeResolvedSecretInputString({ value: present ? value : fallback, path }) ?? null;
}

export function resolveOpenMailAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedOpenMailAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultOpenMailAccountId(params.cfg),
  );
  const channel = channelConfig(params.cfg);
  const merged = resolveMergedAccountConfig(params.cfg, accountId);

  // Env fallbacks only apply to the default account, matching other channels.
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const apiKeyPath =
    isDefault && !channel?.accounts?.[accountId]
      ? "channels.openmail.apiKey"
      : `channels.openmail.accounts.${accountId}.apiKey`;
  const apiKey = resolveApiKey(
    merged.apiKey,
    isDefault ? normalizeOptionalString(process.env.OPENMAIL_API_KEY) : undefined,
    apiKeyPath,
  );
  const inboxId =
    normalizeOptionalString(merged.inboxId) ??
    (isDefault ? normalizeOptionalString(process.env.OPENMAIL_INBOX_ID) : undefined) ??
    null;
  const baseUrl = (
    normalizeOptionalString(merged.baseUrl) ??
    normalizeOptionalString(process.env.OPENMAIL_BASE_URL) ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const mediaMaxMb =
    typeof merged.mediaMaxMb === "number" && Number.isFinite(merged.mediaMaxMb) && merged.mediaMaxMb >= 0
      ? merged.mediaMaxMb
      : DEFAULT_MEDIA_MAX_MB;

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled: channel?.enabled !== false && merged.enabled !== false,
    // A SecretRef counts as configured even before the host resolves it.
    configured: Boolean((apiKey || hasConfiguredSecretInput(merged.apiKey)) && inboxId),
    apiKey,
    inboxId,
    baseUrl,
    dmPolicy: normalizeOptionalString(merged.dmPolicy),
    allowFrom: Array.isArray(merged.allowFrom) ? merged.allowFrom.map(String) : [],
    mode: OPENMAIL_MODES.includes(merged.mode as OpenMailMode) ? (merged.mode as OpenMailMode) : "channel",
    allowNewThreads: merged.allowNewThreads === true,
    mediaMaxMb,
  };
}
