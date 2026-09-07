import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { OPENMAIL_MODES } from "./accounts.js";

// Literal string or SecretRef object; the host materialises refs before we read them.
const SecretInputSchema = buildSecretInputSchema();

const OpenMailInboxSchema = z
  .object({
    mode: z.enum(OPENMAIL_MODES).optional(),
  })
  .strict();

const OpenMailAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    apiKey: SecretInputSchema.optional(),
    inboxId: z.string().min(1).optional(),
    podId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    mode: z.enum(OPENMAIL_MODES).optional(),
    mediaMaxMb: z.number().min(0).max(100).optional(),
    inboxes: z.record(z.string().min(1), OpenMailInboxSchema).optional(),
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
      mode: {
        label: "Mode",
            help: "channel (default): mail from people wakes the agent and it replies in-thread; automated mail is only announced. notify: the agent tells you about new mail on your main chat, no auto-reply. tool: nothing inbound; email only when you ask.",
      },
      inboxes: {
        label: "Per-inbox overrides",
        help: "Pod accounts only. Keyed by inbox address or id; each entry may set the mode for that inbox; otherwise it inherits the account's.",
        advanced: true,
      },
      mediaMaxMb: {
        label: "Attachment budget (MB)",
        help: "Total size of inbound attachments handed to the agent as files per email. 0 disables.",
        advanced: true,
      },
    },
  },
);
