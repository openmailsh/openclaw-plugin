import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCliEnv, resolveBundledCliPath } from "./cli.js";
import { stageInboundAttachments } from "./media.js";
import { OpenMailApi } from "./openmail-api.js";

describe("same-named message attachments", () => {
  const attachments = [{ id: "second", filename: "report.txt" }, { id: "first", filename: "report.txt" }];
  const message = { id: "msg", threadId: "thread", attachments };
  const files = new Map([
    ["/v1/attachments/msg/first", "first report"],
    ["/v1/attachments/msg/second", "second report"],
    ["/v1/attachments/msg/old%20report.txt", "legacy report"],
  ]);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer om_test") return res.writeHead(403).end();
    const url = new URL(req.url ?? "/", "http://localhost").pathname;
    if (url === "/v1/threads/thread/messages" || url === "/v1/inboxes/inbox/messages") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [message] }));
    }
    const content = files.get(url.replace(/\/text$/, ""));
    if (!content) return res.writeHead(404).end();
    if (url.endsWith("/text")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: content }));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" }).end(content);
    }
  });
  let stateDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "openclaw-attachments-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
  });

  it("stages distinct files under their original names and handles ID-less messages", async () => {
    const api = new OpenMailApi(baseUrl, "om_test");
    const [listed] = await api.listThreadMessages("thread");
    expect(listed.attachments).toEqual(attachments);
    const staged = await stageInboundAttachments({
      api,
      messageId: listed.id,
      attachments: [
        ...listed.attachments!,
        { filename: "old report.txt" }, { id: "large", filename: "report.txt", sizeBytes: 2048 },
      ],
      maxBytes: 1024,
    });
    expect(await Promise.all(staged.paths.map((p) => readFile(p, "utf8"))))
      .toEqual(["second report", "first report", "legacy report"]);
    expect(staged.paths[0]).not.toBe(staged.paths[1]);
    for (const path of staged.paths.slice(0, 2)) expect(basename(path)).toContain("report");
    expect(staged.skipped).toEqual(["report.txt [id=large]"]);
  });

  it("lists attachment IDs and uses them for text and raw downloads with the bundled CLI", async () => {
    const env = buildCliEnv({ HOME: stateDir, PATH: process.env.PATH }, { apiKey: "om_test", inboxId: "inbox", baseUrl });
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, [resolveBundledCliPath(), ...args, "--json"], { env });
      return JSON.parse(stdout);
    };
    const thread = await cli("threads", "get", "--thread-id", "thread");
    const inbox = await cli("messages", "list", "--inbox-id", "inbox");
    for (const listing of [thread, inbox]) expect(listing.data[0]).toEqual(message);
    for (const att of thread.data[0].attachments) {
      const args = ["--message-id", thread.data[0].id, "--attachment-id", att.id];
      expect((await cli("attachments", "text", ...args)).text).toBe(`${att.id} report`);
    }
    for (const att of inbox.data[0].attachments) {
      const out = join(stateDir, `${att.id}.txt`);
      await cli("attachments", "get", "--message-id", inbox.data[0].id, "--attachment-id", att.id, "--out", out);
      expect(await readFile(out, "utf8")).toBe(`${att.id} report`);
    }
  });
});
