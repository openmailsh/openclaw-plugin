// Minimal OpenMail REST client. Only what the channel needs: inbox lookup,
// in-thread replies, attachment text. Everything else stays in the CLI.
import { randomUUID } from "node:crypto";

export type OpenMailInbox = {
  id: string;
  address: string;
  name?: string | null;
  displayName?: string | null;
};

export type OpenMailAttachment = {
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  url?: string | null;
  /** Server-side text extraction (PDF, docx, csv...). Absent for binary media. */
  parsedText?: string | null;
};

export type OpenMailMessage = {
  id: string;
  threadId: string;
  direction?: "inbound" | "outbound";
  fromAddr?: string | null;
  toAddr?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  attachments?: OpenMailAttachment[];
  createdAt?: string;
};

export type SendResult = {
  id?: string;
  messageId?: string;
  threadId?: string;
  [key: string]: unknown;
};

export class OpenMailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(
    readonly filename: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`Attachment ${filename} (${bytes} bytes) exceeds the ${maxBytes} byte media budget`);
  }
}

export class OpenMailApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async getInbox(inboxId: string): Promise<OpenMailInbox> {
    const data = (await this.request("GET", `/v1/inboxes/${encodeURIComponent(inboxId)}`)) as
      | { inbox?: OpenMailInbox }
      | OpenMailInbox;
    return "inbox" in data && data.inbox ? data.inbox : (data as OpenMailInbox);
  }

  /** Inboxes visible to this key. Inbox-scoped keys return exactly one. */
  async listInboxes(): Promise<OpenMailInbox[]> {
    const data = (await this.request("GET", "/v1/inboxes?limit=50")) as {
      data?: OpenMailInbox[];
      inboxes?: OpenMailInbox[];
    };
    return data.data ?? data.inboxes ?? [];
  }

  async createInbox(params: { displayName?: string; mailboxName?: string }): Promise<OpenMailInbox> {
    const body: Record<string, string> = {};
    if (params.displayName) body.displayName = params.displayName;
    if (params.mailboxName) body.mailboxName = params.mailboxName;
    return (await this.request("POST", "/v1/inboxes", body)) as OpenMailInbox;
  }

  /**
   * Mint an inbox-scoped key. Returns null when the calling key is itself
   * inbox-scoped (403: such keys cannot mint), which tells the caller the key
   * it already holds is the narrowest possible one.
   */
  async mintInboxKey(inboxId: string, name: string): Promise<{ id: string; token: string } | null> {
    try {
      const key = (await this.request(
        "POST",
        `/v1/inboxes/${encodeURIComponent(inboxId)}/api-keys`,
        { name },
      )) as { id: string; token?: string };
      if (!key.token) throw new Error("OpenMail did not return the key token");
      return { id: key.id, token: key.token };
    } catch (err) {
      if (err instanceof OpenMailApiError && err.status === 403) return null;
      throw err;
    }
  }

  async revokeInboxKey(inboxId: string, keyId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/inboxes/${encodeURIComponent(inboxId)}/api-keys/${encodeURIComponent(keyId)}`,
    );
  }

  /**
   * Server-side gate: only these senders may email the inbox; everyone else
   * is rejected before the event ever reaches the gateway. An empty list
   * denies all (fail closed).
   *
   *  "applied"   rules written as given
   *  "inherited" a pod key may not add allow rules on top of a parent
   *              allowlist, so only the mode was set; the parent's rules apply
   *  "forbidden" inbox-scoped keys cannot set policy at all
   */
  async setInboundAllowlist(
    inboxId: string,
    allowFrom: string[],
  ): Promise<"applied" | "inherited" | "forbidden"> {
    const open = allowFrom.includes("*");
    const put = (rules: { type: "allow"; value: string }[]) =>
      this.request("PUT", `/v1/policy?inboxId=${encodeURIComponent(inboxId)}`, {
        inbound: open ? { mode: "none", rules: [] } : { mode: "allowlist", rules },
      });
    try {
      await put(allowFrom.map((value) => ({ type: "allow", value })));
      return "applied";
    } catch (err) {
      if (!(err instanceof OpenMailApiError) || err.status !== 403) throw err;
      if (open || allowFrom.length === 0) return "forbidden";
      try {
        await put([]);
        return "inherited";
      } catch (retryErr) {
        if (retryErr instanceof OpenMailApiError && retryErr.status === 403) return "forbidden";
        throw retryErr;
      }
    }
  }

  /**
   * Which inbox does this key drive? An inbox-scoped key answers by itself;
   * a broader key works when it sees exactly one inbox, or none (we create
   * one). Several inboxes is ambiguous and the caller must pick.
   */
  async resolveInbox(create: { displayName?: string; mailboxName?: string }): Promise<
    | { kind: "resolved"; inbox: OpenMailInbox; created: boolean }
    | { kind: "ambiguous"; inboxes: OpenMailInbox[] }
  > {
    const inboxes = await this.listInboxes();
    if (inboxes.length === 1) return { kind: "resolved", inbox: inboxes[0], created: false };
    if (inboxes.length === 0) {
      return { kind: "resolved", inbox: await this.createInbox(create), created: true };
    }
    return { kind: "ambiguous", inboxes };
  }

  /** Messages in a thread, oldest first. Scoped keys only see their own inbox. */
  async listThreadMessages(threadId: string): Promise<OpenMailMessage[]> {
    const data = (await this.request(
      "GET",
      `/v1/threads/${encodeURIComponent(threadId)}/messages`,
    )) as { data?: OpenMailMessage[]; messages?: OpenMailMessage[] };
    return data.data ?? data.messages ?? [];
  }

  /**
   * Authoritative copy of one message, fetched through the thread it claims
   * to belong to. Null when the thread is not visible to this key or does not
   * contain the message — i.e. the (messageId, threadId) pair was not issued
   * by OpenMail for this inbox.
   */
  async findMessage(threadId: string, messageId: string): Promise<OpenMailMessage | null> {
    try {
      const messages = await this.listThreadMessages(threadId);
      return messages.find((m) => m.id === messageId) ?? null;
    } catch (err) {
      if (err instanceof OpenMailApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  /** Raw attachment bytes; `maxBytes` aborts the download once exceeded. */
  async downloadAttachment(
    messageId: string,
    filename: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; contentType: string | undefined }> {
    const response = await fetch(
      `${this.baseUrl}/v1/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(filename)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    if (!response.ok) {
      throw new OpenMailApiError(
        `OpenMail API ${response.status}: attachment download failed`,
        response.status,
        await response.text().catch(() => ""),
      );
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new AttachmentTooLargeError(filename, declared, maxBytes);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) return { buffer: Buffer.alloc(0), contentType: undefined };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AttachmentTooLargeError(filename, total, maxBytes);
      }
      chunks.push(value);
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType: response.headers.get("content-type")?.split(";")[0].trim() || undefined,
    };
  }

  /**
   * Reply in an existing thread. The API derives "Re: <subject>" from the
   * thread, so no subject is sent. `to` is the original sender.
   */
  async sendReply(params: {
    inboxId: string;
    to: string;
    threadId: string;
    body: string;
    subject?: string;
  }): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      to: params.to,
      body: params.body,
      threadId: params.threadId,
    };
    if (params.subject) payload.subject = params.subject;
    return (await this.request(
      "POST",
      `/v1/inboxes/${encodeURIComponent(params.inboxId)}/send`,
      payload,
      { "Idempotency-Key": randomUUID() },
    )) as SendResult;
  }

  async sendNew(params: {
    inboxId: string;
    to: string;
    subject: string;
    body: string;
  }): Promise<SendResult> {
    return (await this.request(
      "POST",
      `/v1/inboxes/${encodeURIComponent(params.inboxId)}/send`,
      { to: params.to, subject: params.subject, body: params.body },
      { "Idempotency-Key": randomUUID() },
    )) as SendResult;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : text.slice(0, 200);
      throw new OpenMailApiError(
        `OpenMail API ${response.status}: ${detail}`,
        response.status,
        parsed ?? text,
      );
    }
    return parsed ?? text;
  }
}

function tryParseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
