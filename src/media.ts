// Stage inbound attachments so the agent can open them as files (images,
// PDFs) in addition to any server-extracted text we inline in the prompt.
import { rm } from "node:fs/promises";

import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";

import type { OpenMailApi, OpenMailAttachment } from "./openmail-api.js";
import { AttachmentTooLargeError } from "./openmail-api.js";

export type StagedMedia = { paths: string[]; types: string[]; skipped: string[] };

/** Text the server already extracted is enough for the agent; don't re-stage it. */
export function needsStaging(att: OpenMailAttachment): boolean {
  return !(typeof att.parsedText === "string" && att.parsedText.trim().length > 0);
}

/**
 * Downloads attachments up to an aggregate `maxBytes` and writes them to the
 * inbound media store. Oversized files are skipped (named in `skipped`) rather
 * than failing the whole message; a partial save is rolled back so a durable
 * retry cannot leak a copy per attempt.
 */
export async function stageInboundAttachments(params: {
  api: OpenMailApi;
  messageId: string;
  attachments: OpenMailAttachment[];
  maxBytes: number;
}): Promise<StagedMedia> {
  const out: StagedMedia = { paths: [], types: [], skipped: [] };
  if (params.maxBytes <= 0) return out;
  const candidates = params.attachments.filter((a) => a.filename && needsStaging(a));
  if (candidates.length === 0) return out;

  const downloaded: { buffer: Buffer; contentType: string; filename: string }[] = [];
  let used = 0;
  for (const att of candidates) {
    const declared = typeof att.sizeBytes === "number" ? att.sizeBytes : 0;
    const remaining = params.maxBytes - used;
    if (declared > remaining) {
      out.skipped.push(att.filename);
      continue;
    }
    try {
      const { buffer, contentType } = await params.api.downloadAttachment(
        params.messageId,
        att.filename,
        remaining,
      );
      used += buffer.byteLength;
      downloaded.push({
        buffer,
        contentType: att.contentType || contentType || "application/octet-stream",
        filename: att.filename,
      });
    } catch (err) {
      if (err instanceof AttachmentTooLargeError) {
        out.skipped.push(att.filename);
        continue;
      }
      throw err;
    }
  }

  const saved: { path: string; contentType?: string }[] = [];
  try {
    for (const file of downloaded) {
      saved.push(
        await saveMediaBuffer(file.buffer, file.contentType, "inbound", params.maxBytes, file.filename),
      );
    }
  } catch (err) {
    await Promise.allSettled(saved.map((s) => rm(s.path, { force: true })));
    throw err;
  }
  out.paths = saved.map((s) => s.path);
  out.types = saved.map((s) => s.contentType ?? "application/octet-stream");
  return out;
}
