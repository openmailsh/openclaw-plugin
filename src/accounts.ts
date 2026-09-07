// Account resolution: each OpenClaw "account" is one OpenMail inbox.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const OPENMAIL_CHANNEL_ID = "openmail" as const;
export const DEFAULT_BASE_URL = "https://api.openmail.sh";

export type OpenMailAccountConfig = {
  name?: string;
  enabled?: boolean;
  apiKey?: string;
  inboxId?: string;
  baseUrl?: string;
  dmPolicy?: string;
  allowFrom?: string[];
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
  const apiKey =
    normalizeOptionalString(merged.apiKey) ??
    (isDefault ? normalizeOptionalString(process.env.OPENMAIL_API_KEY) : undefined) ??
    null;
  const inboxId =
    normalizeOptionalString(merged.inboxId) ??
    (isDefault ? normalizeOptionalString(process.env.OPENMAIL_INBOX_ID) : undefined) ??
    null;
  const baseUrl = (
    normalizeOptionalString(merged.baseUrl) ??
    normalizeOptionalString(process.env.OPENMAIL_BASE_URL) ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  return {
    accountId,
    name: normalizeOptionalString(merged.name),
    enabled: channel?.enabled !== false && merged.enabled !== false,
    configured: Boolean(apiKey && inboxId),
    apiKey,
    inboxId,
    baseUrl,
    dmPolicy: normalizeOptionalString(merged.dmPolicy),
    allowFrom: Array.isArray(merged.allowFrom) ? merged.allowFrom.map(String) : [],
  };
}
