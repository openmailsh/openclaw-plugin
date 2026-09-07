// Tells the host which config paths may hold SecretRefs so it resolves them
// (env / file / exec providers) before the channel reads them.
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelSurface,
  hasOwnProperty,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

import { OPENMAIL_CHANNEL_ID } from "./accounts.js";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: OPENMAIL_CHANNEL_ID,
  account: ["apiKey"],
  channel: ["apiKey"],
});

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, OPENMAIL_CHANNEL_ID);
  if (!resolved) return;
  collectConditionalChannelFieldAssignments({
    channelKey: OPENMAIL_CHANNEL_ID,
    field: "apiKey",
    channel: resolved.channel,
    surface: resolved.surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: true,
    topLevelInheritedAccountActive: ({ account, enabled }) =>
      enabled && !hasOwnProperty(account, "apiKey"),
    accountActive: ({ enabled }) => enabled,
    topInactiveReason: "no enabled OpenMail surface inherits this top-level apiKey.",
    accountInactiveReason: "OpenMail account is disabled.",
  });
}
