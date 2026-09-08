// Inbound event admission. Two implementations behind one surface:
//
//  durable  SDK ingress queue + drain (dedupe by event_id, crash-safe rows,
//           backoff retries, dead-letter). Only for trusted installs: ClawHub,
//           or npm with a valid provenance attestation. The host refuses the
//           state APIs to anything else (path links, hand-published tarballs).
//  memory   Serial in-process dispatch with bounded retries and a file cursor.
//           Loses in-flight events on a crash, but the server replays from the
//           cursor on reconnect so nothing is permanently lost.
import fs from "node:fs/promises";
import path from "node:path";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { ResolvedOpenMailAccount } from "./accounts.js";
import { parseAddress, type DispatchOutcome, type OpenMailMessageReceived } from "./inbound.js";
import { getOpenMailRuntime } from "./runtime.js";

const CURSOR_NAMESPACE = "openmail-ws-cursor";
const MEMORY_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

export type Dispatch = (
  event: OpenMailMessageReceived,
  lifecycle?: ChannelIngressMonitorLifecycle,
) => Promise<DispatchOutcome>;

export type Ingress = {
  mode: "durable" | "memory";
  /** Admit one event. Resolves once it is safe to advance the cursor. */
  receive: (event: OpenMailMessageReceived) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

export type CursorStore = {
  load: () => Promise<string | undefined>;
  save: (lastEventId: string) => Promise<void>;
};

/** Serialize turns per sender so one correspondent's mails run in order. */
export function laneKeyFor(event: OpenMailMessageReceived): string {
  return `sender:${parseAddress(event.message.from).address}`;
}

class OpenMailIngressPayloadError extends Error {
  override name = "OpenMailIngressPayloadError";
}

function isTrustRefusal(error: unknown): boolean {
  return error instanceof Error && /only available for trusted plugins/.test(error.message);
}

/**
 * Prefer the SDK's durable machinery; fall back to memory when the host
 * refuses it for this install origin.
 */
export function createIngress(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  dispatch: Dispatch;
}): { ingress: Ingress; cursor: CursorStore } {
  const { ctx } = params;
  try {
    const runtime = getOpenMailRuntime();
    const store = runtime.state.openKeyedStore<{ lastEventId: string }>({
      namespace: CURSOR_NAMESPACE,
      maxEntries: 200,
    });
    const queue = runtime.state.openChannelIngressQueue<{ version: 1; rawEvent: string }>({
      accountId: ctx.accountId,
    });
    return {
      ingress: createDurableIngress({ ...params, queue }),
      cursor: {
        load: async () => (await store.lookup(ctx.accountId))?.lastEventId,
        save: (lastEventId) => store.register(ctx.accountId, { lastEventId }),
      },
    };
  } catch (error) {
    if (!isTrustRefusal(error)) throw error;
    ctx.log?.warn?.(
      "openmail: durable ingress needs a trusted install (npm with provenance, or ClawHub); this install is untrusted, so retries are in memory only. Check: openclaw plugins inspect openmail",
    );
    return { ingress: createMemoryIngress(params), cursor: createFileCursor(ctx.accountId) };
  }
}

function createDurableIngress(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  dispatch: Dispatch;
  queue: ReturnType<ReturnType<typeof getOpenMailRuntime>["state"]["openChannelIngressQueue"]>;
}): Ingress {
  const { ctx, dispatch } = params;
  const monitor = createStandardRawEventIngressMonitor<
    OpenMailMessageReceived,
    unknown,
    { eventId: string; laneKey: string }
  >({
    queue: params.queue as never,
    abortSignal: ctx.abortSignal,
    inspect: (raw) => ({ eventId: raw.event_id, laneKey: laneKeyFor(raw) }),
    payload: {
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as OpenMailMessageReceived,
      createClaimError: (kind, claim) =>
        new OpenMailIngressPayloadError(
          kind === "invalid-version"
            ? `OpenMail ingress row ${claim.id} has an unsupported payload version.`
            : `OpenMail ingress row ${claim.id} changed event identity.`,
        ),
    },
    classifyAdmissionError: (error) =>
      error instanceof SyntaxError || error instanceof OpenMailIngressPayloadError
        ? error.message
        : undefined,
    deliver: async (event, lifecycle) => {
      try {
        const outcome = await dispatch(event, lifecycle);
        if (outcome.kind === "dropped") {
          ctx.log?.info?.(`openmail: drop event ${event.event_id}: ${outcome.reason}`);
        }
        // Idempotent when inbound.run already adopted through the bound lifecycle.
        await lifecycle.onAdopted();
        return { kind: "completed" };
      } catch (error) {
        ctx.log?.warn?.(`openmail: dispatch of ${event.event_id} failed; will retry: ${String(error)}`);
        return { kind: "failed-retryable", error };
      }
    },
    onError: (error) => ctx.log?.error?.(`openmail: ingress error: ${String(error)}`),
    createStoppedError: () => new Error("OpenMail ingress is stopped."),
  });
  return {
    mode: "durable",
    receive: async (event) => {
      const admission = await monitor.receive(event);
      if (admission.kind === "invalid") {
        throw new Error(`malformed event ${event.event_id}: ${admission.message}`);
      }
    },
    start: monitor.start,
    stop: monitor.stop,
  };
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

export function createMemoryIngress(params: {
  ctx: ChannelGatewayContext<ResolvedOpenMailAccount>;
  dispatch: Dispatch;
  retryDelaysMs?: readonly number[];
}): Ingress {
  const { ctx, dispatch } = params;
  const delays = params.retryDelaysMs ?? MEMORY_RETRY_DELAYS_MS;
  const seen = new Set<string>();
  let tail: Promise<void> = Promise.resolve();
  let running = false;

  const handle = async (event: OpenMailMessageReceived): Promise<boolean> => {
    if (seen.has(event.event_id)) {
      ctx.log?.info?.(`openmail: skip duplicate event ${event.event_id}`);
      return true;
    }
    seen.add(event.event_id);
    if (seen.size > 5_000) seen.delete(seen.values().next().value as string);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const outcome = await dispatch(event);
        if (outcome.kind === "dropped") {
          ctx.log?.info?.(`openmail: drop event ${event.event_id}: ${outcome.reason}`);
        }
        return true;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || ctx.abortSignal?.aborted) {
          seen.delete(event.event_id);
          ctx.log?.error?.(
            `openmail: giving up on event ${event.event_id} after ${attempt} retries; it will be replayed on reconnect: ${String(error)}`,
          );
          return false;
        }
        ctx.log?.warn?.(
          `openmail: dispatch of ${event.event_id} failed, retry ${attempt + 1} in ${delay}ms: ${String(error)}`,
        );
        await sleep(delay, ctx.abortSignal);
      }
    }
  };

  return {
    mode: "memory",
    receive: async (event) => {
      if (!running) throw new Error("OpenMail ingress is stopped.");
      // Nothing is persisted, so "admitted" can only mean "handled": the
      // caller advances the cursor after we resolve, and a give-up throws so
      // the cursor stays put and the server replays the event on reconnect.
      const done = tail.then(() => handle(event));
      tail = done.then(() => undefined, () => undefined);
      if (!(await done)) throw new Error(`event ${event.event_id} was not handled`);
    },
    start: () => {
      running = true;
    },
    stop: async () => {
      running = false;
      await tail;
    },
  };
}

/** `{ lastEventId }` per account under the OpenClaw state dir. */
export function createFileCursor(accountId: string, stateDir = resolveStateDir()): CursorStore {
  const file = path.join(stateDir, "openmail", `cursor-${accountId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  return {
    async load() {
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as { lastEventId?: unknown };
        return typeof raw.lastEventId === "string" ? raw.lastEventId : undefined;
      } catch {
        return undefined;
      }
    },
    async save(lastEventId) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ lastEventId }), "utf8");
    },
  };
}
