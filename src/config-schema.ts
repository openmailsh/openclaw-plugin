import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

// Literal string or SecretRef object; the host materialises refs before we read them.
const SecretInputSchema = buildSecretInputSchema();

const OpenMailAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    apiKey: SecretInputSchema.optional(),
    inboxId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    allowNewThreads: z.boolean().optional(),
    mediaMaxMb: z.number().min(0).max(100).optional(),
  })
  .strict();

export const openmailChannelConfigSchema = buildChannelConfigSchema(
  buildMultiAccountChannelSchema(OpenMailAccountSchema),
  {
    uiHints: {
      apiKey: { label: "API key", sensitive: true },
      inboxId: { label: "Inbox id" },
      baseUrl: { label: "API base URL", advanced: true },
      allowFrom: {
        label: "Allowed senders",
        help: 'Addresses or domains that may email the agent. "*" = anyone.',
      },
      dmPolicy: {
        label: "Sender policy",
        help: 'allowlist (default): only allowFrom. open: requires "*" in allowFrom.',
      },
      allowNewThreads: {
        label: "Allow new threads",
        help: "Off (default): the agent can only reply in-thread. On: it may email any address.",
      },
      mediaMaxMb: {
        label: "Attachment budget (MB)",
        help: "Total size of inbound attachments handed to the agent as files per email. 0 disables.",
        advanced: true,
      },
    },
  },
);
