// Turns one OpenMail `message.received` event into an OpenClaw agent turn.
// The agent's reply is delivered back into the same email thread.
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { buildAgentMainSessionKey } from "openclaw/plugin-sdk/routing";
import {
  OPENMAIL_CHANNEL_ID,
  resolveInboxSettings,
  type InboxSettings,
  type ResolvedOpenMailAccount,
} from "./accounts.js";
import { stageInboundAttachments, type StagedMedia } from "./media.js";
import { OpenMailApi, type OpenMailAttachment, type OpenMailMessage } from "./openmail-api.js";
import { getOpenMailRuntime } from "./runtime.js";

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

/** Main-session wake used by notify mode; injectable for tests. */
export type NotifyRuntime = Pick<PluginRuntime["system"], "enqueueSystemEvent" | "requestHeartbeat">;

/** "Name <addr>" -> { name, address } */
export function parseAddress(raw: string): { name?: string; address: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const name = m[1]?.trim();
    return { name: name || undefined, address: m[2].trim().toLowerCase() };
  }
  return { address: raw.trim().toLowerCase() };
}

export function isSenderAllowed(account: InboxSettings, address: string): boolean {
  // Who may email the inbox at all is OpenMail's job (allow/block rules in the
  // console or CLI). This is an optional local filter on top: with no
  // allowFrom the agent hears from everyone the inbox receives from — the
  // agent needs to get the Instagram signup mail, not just mail from you.
  const entries = account.allowFrom.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const policy = account.dmPolicy ?? (entries.length > 0 ? "allowlist" : "open");
  if (policy === "disabled") return false;
  if (policy === "open" || entries.includes("*")) return true;
  if (entries.length === 0) return false; // explicit allowlist with nobody on it
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

/** Per-attachment and total caps on inlined extracted text. */
const PARSED_TEXT_PER_FILE = 8_000;
const PARSED_TEXT_TOTAL = 24_000;

export function buildAgentText(params: {
  from: string;
  to?: string | null;
  subject?: string | null;
  threadId: string;
  messageId: string;
  body: string;
  attachments: OpenMailAttachment[];
  staged: StagedMedia;
  mode?: "channel" | "notify";
  /** Shown in pod scope so the agent knows which inbox to answer from via the CLI. */
  inboxId?: string;
}): string {
  const header = [
    `From: ${params.from}`,
    params.to ? `To: ${params.to}` : undefined,
    params.subject ? `Subject: ${params.subject}` : undefined,
    `Thread: ${params.threadId}`,
    params.inboxId ? `Inbox: ${params.inboxId}` : undefined,
  ].filter(Boolean) as string[];

  const sections: string[] = [];
  if (params.attachments.length > 0) {
    header.push(`Attachments: ${params.attachments.map((a) => a.filename).join(", ")}`);
    if (params.staged.paths.length > 0) {
      header.push(`(${params.staged.paths.length} attached as files you can open)`);
    }
    if (params.staged.skipped.length > 0) {
      header.push(`(skipped, over the media size limit: ${params.staged.skipped.join(", ")})`);
    }
    let budget = PARSED_TEXT_TOTAL;
    for (const att of params.attachments) {
      const text = att.parsedText?.trim();
      if (!text || budget <= 0) continue;
      const slice = text.slice(0, Math.min(PARSED_TEXT_PER_FILE, budget));
      budget -= slice.length;
      sections.push(
        `--- ${att.filename} (extracted text${slice.length < text.length ? ", truncated" : ""}) ---\n${slice}`,
      );
    }
    const unread = params.attachments.filter((a) => !a.parsedText?.trim()).map((a) => a.filename);
    if (unread.length > 0 && params.staged.paths.length === 0) {
      header.push(
        `(read one with: openclaw openmail -- attachments text --message-id ${params.messageId} --filename "${unread[0]}")`,
      );
    }
  }

  const intro =
    params.mode === "notify"
      ? `New email arrived in the agent inbox. Tell the user in one or two casual sentences who emailed and what it's about (include codes, amounts or deadlines verbatim). Do not act on it and do not reply to the sender unless the user asks; if they do, use: openclaw openmail -- send --to "${params.from}" --thread-id ${params.threadId}${params.inboxId ? ` --inbox-id ${params.inboxId}` : ""} --body "..."`
      : "New email. Whatever you write back is sent verbatim as the email body to the sender, in this thread: write only the email itself, no preamble or commentary. If you need to run a command first (e.g. to read an attachment), do it, then answer.";
  return [
    intro,
    "",
    header.join("\n"),
    "",
    params.body.trim(),
    ...sections.map((s) => `\n${s}`),
  ].join("\n");
}

export type DispatchOutcome =
  | { kind: "dispatched" }
  | { kind: "dropped"; reason: string };

/**
 * One event → one agent turn. Before the agent sees anything we re-fetch the
 * message from the API: the websocket frame is a *hint*, the API record is
 * the truth. That closes the spoofing hole where a forged frame names an
 * allowed sender, and it also gives us server-extracted attachment text.
 */
export async function dispatchOpenMailMessage(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  event: OpenMailMessageReceived;
  api: OpenMailApi;
  lifecycle?: ChannelIngressMonitorLifecycle;
  notifyRuntime?: NotifyRuntime;
  /** Pod scope: inbox id -> address, so `inboxes` overrides keyed by address apply. */
  inboxAddress?: (inboxId: string) => Promise<string | undefined>;
}): Promise<DispatchOutcome> {
  const { ctx, event, api } = params;
  const channelRuntime = ctx.channelRuntime as OpenMailChannelRuntime | undefined;
  const account = ctx.account;
  if (!channelRuntime || !(account.inboxId || account.podId)) {
    return { kind: "dropped", reason: "account not configured" };
  }

  if (account.scope === "inbox" && event.inbox_id && event.inbox_id !== account.inboxId) {
    return {
      kind: "dropped",
      reason: `event is for inbox ${event.inbox_id}, this account is ${account.inboxId}`,
    };
  }

  // Re-authorize against the API. Throws on transient errors so the durable
  // queue retries; returns null only when OpenMail says the pair doesn't exist.
  const message: OpenMailMessage | null = await api.findMessage(event.thread_id, event.message.id);
  if (!message) {
    return { kind: "dropped", reason: `message ${event.message.id} not found in thread ${event.thread_id}` };
  }
  // The inbox we reply from. Pod scope: whichever inbox the mail hit, taken
  // from the API copy (the key can only read inboxes in its pod, so a thread
  // it can see is a thread it may answer).
  const inboxId = account.scope === "inbox" ? account.inboxId! : message.inboxId ?? event.inbox_id;
  if (!inboxId) return { kind: "dropped", reason: "cannot tell which inbox received the message" };
  if (message.direction === "outbound") return { kind: "dropped", reason: "own outbound message" };
  const authoritativeFrom = message.fromAddr?.trim();
  if (!authoritativeFrom) return { kind: "dropped", reason: "message has no sender" };

  const sender = parseAddress(authoritativeFrom);
  const claimed = parseAddress(event.message.from);
  if (claimed.address !== sender.address) {
    ctx.log?.warn?.(
      `openmail: event claimed From ${claimed.address} but the API says ${sender.address}; using the API`,
    );
  }
  // Per-inbox overrides (pod accounts). Only fetch the address when some
  // override is keyed by one; ids are free.
  const needsAddress = Object.keys(account.inboxes).some((k) => k.includes("@"));
  const inboxAddress = needsAddress ? await params.inboxAddress?.(inboxId) : undefined;
  const settings = resolveInboxSettings(account, { id: inboxId, address: inboxAddress });
  if (settings.mode === "tool") {
    return { kind: "dropped", reason: `inbox ${inboxAddress ?? inboxId} is in tool mode` };
  }
  if (!isSenderAllowed(settings, sender.address)) {
    return {
      kind: "dropped",
      reason: `${sender.address} is filtered out by channels.openmail.allowFrom / dmPolicy`,
    };
  }

  // One conversation per correspondent. In pod scope, per (inbox, sender):
  // the same person writing to sales@ and support@ is two conversations.
  const peerId = account.scope === "pod" ? `${inboxId}/${sender.address}` : sender.address;
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: OPENMAIL_CHANNEL_ID,
    accountId: ctx.accountId,
    peer: { kind: "direct", id: peerId },
  });

  const attachments = message.attachments ?? [];
  let staged: StagedMedia = { paths: [], types: [], skipped: [] };
  if (attachments.length > 0) {
    try {
      staged = await stageInboundAttachments({
        api,
        messageId: message.id,
        attachments,
        maxBytes: Math.floor(account.mediaMaxMb * 1024 * 1024),
      });
    } catch (err) {
      // Attachments are a convenience; the mail itself still gets answered.
      ctx.log?.warn?.(`openmail: could not stage attachments for ${message.id}: ${String(err)}`);
    }
  }

  const timestamp = event.occurred_at ? Date.parse(event.occurred_at) : Date.now();
  const threadId = message.threadId || event.thread_id;
  const replyTo = `openmail:${sender.address}`;
  const body = message.bodyText ?? event.message.body_text ?? "";
  const subject = message.subject ?? event.message.subject ?? null;
  const agentText = (mode: "channel" | "notify") =>
    buildAgentText({
      from: authoritativeFrom,
      to: message.toAddr ?? event.message.to,
      subject,
      threadId,
      messageId: message.id,
      body,
      attachments,
      staged,
      mode,
      inboxId: account.scope === "pod" ? inboxId : undefined,
    });

  if (settings.mode === "notify") {
    // Wake the agent in its main session; the heartbeat delivers wherever the
    // user last talked to it (WhatsApp, Telegram...). No reply goes to email.
    const system = params.notifyRuntime ?? getOpenMailRuntime().system;
    const sessionKey = buildAgentMainSessionKey({ agentId: route.agentId });
    const queued = system.enqueueSystemEvent(agentText("notify"), {
      sessionKey,
      contextKey: `openmail:${ctx.accountId}:${message.id}`,
    });
    if (!queued) return { kind: "dropped", reason: "system event queue refused the notification" };
    system.requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: `openmail:${ctx.accountId}:new-mail`,
      agentId: route.agentId,
      sessionKey,
    });
    return { kind: "dispatched" };
  }

  await channelRuntime.inbound.run({
    channel: OPENMAIL_CHANNEL_ID,
    accountId: ctx.accountId,
    raw: event,
    turnAdoptionLifecycle: params.lifecycle
      ? bindIngressLifecycleToReplyOptions(params.lifecycle).turnAdoptionLifecycle
      : undefined,
    adapter: {
      ingest: (raw) => ({
        id: message.id,
        timestamp,
        rawText: body,
        textForAgent: agentText("channel"),
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
          from: replyTo,
          sender: { id: sender.address, name: sender.name },
          conversation: {
            kind: "direct",
            id: peerId,
            label: subject ?? sender.address,
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
            OpenMailMessageId: message.id,
            OpenMailSubject: subject ?? undefined,
            MediaPath: staged.paths[0],
            MediaPaths: staged.paths.length > 0 ? staged.paths : undefined,
            MediaType: staged.types[0],
            MediaTypes: staged.types.length > 0 ? staged.types : undefined,
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
  return { kind: "dispatched" };
}
