import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenMailApi } from "./openmail-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenMailApi client attribution", () => {
  it("identifies itself to the API on every request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new OpenMailApi("https://api.openmail.sh", "om_test").listInboxes();

    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers["X-OpenMail-Client"]).toBe("openclaw");
    expect(init.headers["User-Agent"]).toMatch(/^openmail-openclaw\/\d+\.\d+\.\d+/);
    expect(init.headers.Authorization).toBe("Bearer om_test");
  });
});

it("addresses automatic replies by source message and reuses the key on retry", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const api = new OpenMailApi("https://api.openmail.sh", "test");
  await api.replyToSender("inbox", "message", "Hello");
  await api.replyToSender("inbox", "message", "Hello again");
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe("https://api.openmail.sh/v1/inboxes/inbox/messages/message/reply");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "openclaw-reply:message" });
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(["body"]);
  }
});
