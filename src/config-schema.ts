import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { OPENMAIL_MODES } from "./accounts.js";

// Literal string or SecretRef object; the host materialises refs before we read them.
const SecretInputSchema = buildSecretInputSchema();

const OpenMailAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    apiKey: SecretInputSchema.optional(),
    inboxId: z.string().min(1).optional(),
    podId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    mode: z.enum(OPENMAIL_MODES).optional(),
    allowNewThreads: z.boolean().optional(),
    mediaMaxMb: z.number().min(0).max(100).optional(),
  })
  .strict();

export const openmailChannelConfigSchema = buildChannelConfigSchema(
  buildMultiAccountChannelSchema(OpenMailAccountSchema),
  {
    uiHints: {
      apiKey: { label: "API key", sensitive: true },
      inboxId: { label: "Inbox id", help: "One inbox. Leave empty when podId is set." },
      podId: {
        label: "Pod id",
        help: "Whole pod: every inbox in it, including ones the agent creates later. Needs a pod-scoped key.",
        advanced: true,
      },
      baseUrl: { label: "API base URL", advanced: true },
      allowFrom: {
        label: "Sender filter",
        help: "Optional. Only these addresses or domains reach the agent. Empty = everyone the inbox receives from. Server-side allow/block rules live in the OpenMail console or CLI.",
      },
      dmPolicy: {
        label: "Sender policy",
        help: "open (default): everyone. allowlist: only allowFrom. disabled: nobody.",
      },
      mode: {
        label: "Mode",
        help: "channel (default): mail wakes the agent and it replies in-thread. notify: the agent tells you about new mail on your main chat, no auto-reply. tool: nothing inbound; email only when you ask.",
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
