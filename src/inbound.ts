// Turns one OpenMail `message.received` event into an OpenClaw agent turn.
// The agent's reply is delivered back into the same email thread.
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { OPENMAIL_CHANNEL_ID, type ResolvedOpenMailAccount } from "./accounts.js";
import { OpenMailApi } from "./openmail-api.js";

/** Shape of `message.received` on the OpenMail websocket (mirrors the webhook payload). */
export type OpenMailMessageReceived = {
  event: "message.received";
  event_id: string;
  occurred_at?: string;
  inbox_id: string;
  thread_id: string;
  message: {
    id: string;
    rfc_message_id?: string | null;
    from: string;
    to?: string | null;
    cc?: string[] | string | null;
    subject?: string | null;
    body_text?: string | null;
    attachments?: Array<{ id?: string; filename?: string; content_type?: string; size?: number }>;
    received_at?: string;
    category?: string | null;
    auto_replyable?: boolean | null;
    verdict?: string | null;
    spam_score?: number | null;
  };
};

type OpenMailChannelRuntime = Pick<
  PluginRuntime["channel"],
  "inbound" | "reply" | "routing" | "session"
>;

/** "Name <addr>" -> { name, address } */
export function parseAddress(raw: string): { name?: string; address: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const name = m[1]?.trim();
    return { name: name || undefined, address: m[2].trim().toLowerCase() };
  }
  return { address: raw.trim().toLowerCase() };
}

export function isSenderAllowed(account: ResolvedOpenMailAccount, address: string): boolean {
  // OpenMail's correspondent policy is the primary gate and runs server-side
  // before the event ever reaches us. This is the local mirror of it, and it
  // fails closed: no list means nobody, and "open" has to be spelled out with
  // a "*" entry so an unconfigured channel never accepts mail from anyone.
  const policy = account.dmPolicy ?? "allowlist";
  if (policy === "disabled") return false;
  const entries = account.allowFrom.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (entries.includes("*")) return true;
  if (policy === "open") return false; // "open" without "*" is a misconfiguration; stay closed
  const domain = address.split("@")[1] ?? "";
  return entries.some((e) => {
    if (e.startsWith("*.")) {
      const root = e.slice(2);
      return domain === root || domain.endsWith(`.${root}`);
    }
    if (e.startsWith("@")) return domain === e.slice(1);
    if (e.startsWith("*@")) return domain === e.slice(2);
    if (!e.includes("@")) return domain === e; // bare domain, same as the API accepts
    return e === address;
  });
}

export function buildAgentText(ev: OpenMailMessageReceived): string {
  const m = ev.message;
  const lines = [
    `From: ${m.from}`,
    m.to ? `To: ${m.to}` : undefined,
    m.subject ? `Subject: ${m.subject}` : undefined,
    `Thread: ${ev.thread_id}`,
  ].filter(Boolean) as string[];
  if (m.attachments && m.attachments.length > 0) {
    const names = m.attachments.map((a) => a.filename ?? a.id ?? "attachment");
    lines.push(`Attachments: ${names.join(", ")}`);
    lines.push(
      `(read one with: openclaw openmail -- attachments text --message-id ${m.id} --filename "${names[0]}")`,
    );
  }
  return [
    "New email. Whatever you write back is sent verbatim as the email body to the sender, in this thread: write only the email itself, no preamble or commentary. If you need to run a command first (e.g. to read an attachment), do it, then answer.",
    "",
    lines.join("\n"),
    "",
    (m.body_text ?? "").trim(),
  ].join("\n");
}

export async function dispatchOpenMailMessage(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  event: OpenMailMessageReceived;
  api: OpenMailApi;
}): Promise<void> {
  const { ctx, event, api } = params;
  const channelRuntime = ctx.channelRuntime as OpenMailChannelRuntime | undefined;
  const account = ctx.account;
  if (!channelRuntime || !account.inboxId) return;

  const sender = parseAddress(event.message.from);
  if (!isSenderAllowed(account, sender.address)) {
    ctx.log?.info?.(
      `openmail: drop mail from ${sender.address}: not in channels.openmail.allowFrom (add the address, a domain, or "*")`,
    );
    return;
  }

  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: OPENMAIL_CHANNEL_ID,
    accountId: ctx.accountId,
    peer: { kind: "direct", id: sender.address },
  });

  const timestamp = event.occurred_at ? Date.parse(event.occurred_at) : Date.now();
  const inboxId = account.inboxId;
  const threadId = event.thread_id;
  const replyTo = `openmail:${sender.address}`;

  await channelRuntime.inbound.run({
    channel: OPENMAIL_CHANNEL_ID,
    accountId: ctx.accountId,
    raw: event,
    adapter: {
      ingest: (raw) => ({
        id: raw.message.id,
        timestamp,
        rawText: raw.message.body_text ?? "",
        textForAgent: buildAgentText(raw),
        textForCommands: "",
        raw,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = channelRuntime.inbound.buildContext({
          channelIngress: "unsupported",
          channel: OPENMAIL_CHANNEL_ID,
          accountId: ctx.accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `openmail:${sender.address}`,
          sender: { id: sender.address, name: sender.name },
          conversation: {
            kind: "direct",
            id: sender.address,
            label: event.message.subject ?? sender.address,
            threadId,
          },
          route: {
            agentId: route.agentId,
            accountId: ctx.accountId,
            routeSessionKey: route.sessionKey,
            dispatchSessionKey: route.sessionKey,
          },
          reply: {
            to: replyTo,
            originatingTo: replyTo,
            messageThreadId: threadId,
          },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: {
            OpenMailInboxId: inboxId,
            OpenMailThreadId: threadId,
            OpenMailMessageId: event.message.id,
            OpenMailSubject: event.message.subject ?? undefined,
          },
        });
        return {
          cfg: ctx.cfg,
          channel: OPENMAIL_CHANNEL_ID,
          accountId: ctx.accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          ctxPayload,
          delivery: {
            deliver: async (payload) => {
              const text = typeof payload.text === "string" ? payload.text.trim() : "";
              if (!text) return { visibleReplySent: false };
              await api.sendReply({ inboxId, to: sender.address, threadId, body: text });
              ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, lastOutboundAt: Date.now() });
              return { visibleReplySent: true };
            },
            onError: (err, info) => {
              ctx.log?.error?.(`openmail: ${info.kind} reply failed: ${String(err)}`);
            },
          },
          record: {
            onRecordError: (error) =>
              ctx.log?.warn?.(`openmail: session metadata update failed: ${String(error)}`),
          },
        };
      },
    },
  });
}
