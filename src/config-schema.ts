import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const OpenMailAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    apiKey: z.string().min(1).optional(),
    inboxId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    allowNewThreads: z.boolean().optional(),
  })
  .strict();

export const openmailChannelConfigSchema = buildChannelConfigSchema(
  buildMultiAccountChannelSchema(OpenMailAccountSchema),
);
