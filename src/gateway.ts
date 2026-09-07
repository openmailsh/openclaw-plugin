// Gateway lifecycle: hold the OpenMail websocket for the account's lifetime,
// reconnect with backoff, dedupe by event_id, hand each inbound mail to the
// turn kernel. The gateway is already a daemon, so no separate bridge process.
import WebSocket from "ws";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { OPENMAIL_CHANNEL_ID, type ResolvedOpenMailAccount } from "./accounts.js";
import { dispatchOpenMailMessage, type OpenMailMessageReceived } from "./inbound.js";
import { OpenMailApi } from "./openmail-api.js";

// Server closes we must not retry: revoked key, forbidden, connection cap.
const FATAL_CLOSE_CODES = new Set([4001, 4003, 4008]);
const MIN_STABLE_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

type ReplayEvent = { accountId: string; eventId: string };

function createReplayGuard(onDiskError: (error: unknown) => void) {
  return createChannelReplayGuard<ReplayEvent>({
    dedupe: {
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 2_000,
      pluginId: OPENMAIL_CHANNEL_ID,
      namespacePrefix: "openmail-event-dedupe",
      stateMaxEntries: 20_000,
      onDiskError,
    },
    buildReplayKey: (event) => event.eventId,
    namespace: (event) => event.accountId,
  });
}

function toWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://")}/v1/ws`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function startOpenMailGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>,
): Promise<void> {
  const account = ctx.account;
  if (!account.enabled) {
    await waitUntilAbort(ctx.abortSignal);
    return;
  }
  if (!account.apiKey || !account.inboxId) {
    throw new Error(`OpenMail account "${ctx.accountId}" needs apiKey and inboxId.`);
  }
  if (!ctx.channelRuntime) {
    throw new Error("OpenMail requires OpenClaw channel runtime support. Update OpenClaw and retry.");
  }

  const api = new OpenMailApi(account.baseUrl, account.apiKey);
  const inbox = await api.getInbox(account.inboxId);
  ctx.log?.info?.(`[${ctx.accountId}] OpenMail inbox ${inbox.address}`);

  const replayGuard = createReplayGuard((error) =>
    ctx.log?.warn?.(`openmail: dedupe storage failed: ${String(error)}`),
  );

  const signal = ctx.abortSignal;
  let retries = 0;
  let lastEventId: string | undefined;
  let stopError: unknown;

  try {
    while (!signal?.aborted) {
      if (retries > 0) {
        const delay = Math.min(1_000 * 2 ** retries, MAX_BACKOFF_MS);
        ctx.log?.info?.(`openmail: reconnecting in ${delay}ms (attempt ${retries})`);
        await sleep(delay, signal);
        if (signal?.aborted) break;
      }

      const startedAt = Date.now();
      let fatal: string | undefined;
      try {
        fatal = await connectOnce({
          ctx,
          api,
          wsUrl: toWsUrl(account.baseUrl),
          apiKey: account.apiKey,
          inboxId: account.inboxId,
          lastEventId: () => lastEventId,
          onEvent: async (event) => {
            const result = await replayGuard.processGuarded(
              { accountId: ctx.accountId, eventId: event.event_id },
              async () => {
                ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, lastInboundAt: Date.now() });
                await dispatchOpenMailMessage({ ctx, event, api });
              },
              // A failed dispatch should not be retried on the next replay; the
              // mail is still in the inbox and the agent can read it via the CLI.
              { onError: "commit" },
            );
            if (result.kind === "duplicate") {
              ctx.log?.info?.(`openmail: skip duplicate event ${event.event_id}`);
            }
            lastEventId = event.event_id;
          },
        });
      } catch (err) {
        ctx.log?.warn?.(`openmail: websocket error: ${String(err)}`);
      }

      if (fatal) {
        throw new Error(`OpenMail websocket refused: ${fatal}`);
      }
      retries = Date.now() - startedAt >= MIN_STABLE_MS ? 0 : retries + 1;
    }
  } catch (error) {
    stopError = error;
    throw error;
  } finally {
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
      ...(stopError ? { lastError: String(stopError) } : {}),
    });
  }
}

/** Resolves when the socket closes. Returns a reason string for fatal closes. */
function connectOnce(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  api: OpenMailApi;
  wsUrl: string;
  apiKey: string;
  inboxId: string;
  lastEventId: () => string | undefined;
  onEvent: (event: OpenMailMessageReceived) => Promise<void>;
}): Promise<string | undefined> {
  const { ctx } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(params.wsUrl, {
      headers: { Authorization: `Bearer ${params.apiKey}` },
    });
    let settled = false;
    let ping: NodeJS.Timeout | undefined;
    // Serialize inbound turns so lastEventId advances in receive order and
    // same-sender sessions do not run concurrently.
    let eventTail: Promise<void> = Promise.resolve();

    const finish = (fatal?: string, err?: Error) => {
      if (settled) return;
      settled = true;
      if (ping) clearInterval(ping);
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        // already closed
      }
      void eventTail.finally(() => {
        if (err) reject(err);
        else resolve(fatal);
      });
    };
    const onAbort = () => finish();
    ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
      const subscribe: Record<string, unknown> = {
        type: "subscribe",
        inbox_ids: [params.inboxId],
        event_types: ["message.received"],
      };
      const last = params.lastEventId();
      if (last) subscribe.last_event_id = last;
      ws.send(JSON.stringify(subscribe));
      ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
      ctx.setStatus(channelReadyPatch({ accountId: ctx.accountId, lastStartAt: Date.now() }));
      ctx.log?.info?.("openmail: websocket connected");
    });

    ws.on("message", (raw) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.type === "error") {
        ctx.log?.warn?.(`openmail: server error: ${String(payload.message)}`);
        return;
      }
      if (payload.event !== "message.received") return;
      const event = payload as unknown as OpenMailMessageReceived;
      eventTail = eventTail
        .then(() => params.onEvent(event))
        .catch((handlerErr) => {
          ctx.log?.warn?.(`openmail: event handler error: ${String(handlerErr)}`);
        });
    });

    ws.on("close", (code, reason) => {
      const text = reason.toString();
      ctx.log?.info?.(`openmail: websocket closed (${code}) ${text}`);
      finish(FATAL_CLOSE_CODES.has(code) ? `${code} ${text}`.trim() : undefined);
    });

    ws.on("error", (err) => finish(undefined, err instanceof Error ? err : new Error(String(err))));
  });
}
