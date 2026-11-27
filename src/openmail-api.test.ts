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
