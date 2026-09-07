# @openmail/openclaw

Give your [OpenClaw](https://openclaw.ai) agent its own email address.

Inbound mail wakes the agent; its reply goes out in the same thread. The
gateway holds the OpenMail websocket itself — no bridge process, no hook
tokens, nothing to keep alive.

## Install

```bash
openclaw plugins install @openmail/openclaw
openclaw channels add --channel openmail --api-key <key>
openclaw gateway restart
```

Get a key from [app.openmail.sh](https://app.openmail.sh) or with the
[OpenMail CLI](https://github.com/openmailsh/cli) (`openmail inbox keys create`).

## What `channels add` does with your key

| You pass | Result |
| --- | --- |
| an inbox-scoped key | stored as-is; that inbox is the channel |
| an account or pod key | picks your inbox (or **creates one if you have none**), mints an inbox-scoped key for it, stores only that. The broad key is never written to `openclaw.json`. |
| `--mailbox-name sales` | creates `sales@omail.sh` (add `--display-name "Sales bot"` for the sender name) |
| `--inbox-id <id>` | uses that existing inbox — needed when the key can see several |
| `--keep-key` | store the given key unchanged, skip minting |

The address to email is printed at the end. Re-running against an existing
account is a no-op.

## Several inboxes

One OpenClaw account per inbox. Each gets its own websocket, status line, and
can be bound to a different agent:

```bash
openclaw channels add --channel openmail --account support --api-key <key> --mailbox-name support
openclaw channels add --channel openmail --account sales   --api-key <key> --mailbox-name sales
openclaw channels status
# - OpenMail support: enabled, configured, running, connected
# - OpenMail sales:   enabled, configured, running, connected
```

## Behaviour

- Each sender address is a separate conversation (like a WhatsApp contact), so
  the agent keeps history per correspondent.
- The agent sees `From / To / Subject / Thread / Attachments` followed by the
  plain-text body. Email content is untrusted input; the agent's system prompt
  should say so.
- Replies go to the original sender via `POST /v1/inboxes/{id}/send` with the
  thread id, so they land in-thread with a `Re:` subject and quoted original.
- The agent can also start threads: `openclaw message send --channel openmail --to a@b.com "…"`.
  The first line becomes the subject.
- Who may email the inbox is governed by OpenMail's correspondent policy
  (server-side). `channels.openmail.dmPolicy` / `allowFrom` add a local filter
  on top: `"open"` (default), `"allowlist"` with entries like
  `"someone@x.com"` or `"@x.com"`, or `"disabled"`.

## Config

```json5
{
  "channels": {
    "openmail": {
      "apiKey": "om_…",          // inbox-scoped
      "inboxId": "…",
      "dmPolicy": "allowlist",   // optional
      "allowFrom": ["@yourcompany.com"],
      "accounts": {
        "sales": { "apiKey": "om_…", "inboxId": "…" }
      }
    }
  }
}
```

`OPENMAIL_API_KEY` / `OPENMAIL_INBOX_ID` / `OPENMAIL_BASE_URL` work as env
fallbacks for the default account.

## Not yet

- Notify mode (summarise to your chat channel instead of auto-replying).
- Attachment contents for the agent (filenames only; use the CLI's
  `openmail attachments text` from a skill).
- OpenClaw pairing flow for unknown senders.
- If the config write fails after a key was minted, the key is left behind.
  Harmless (10-key cap per inbox), visible in the dashboard.

## Develop

```bash
pnpm install
pnpm build                       # tsc; needs NODE_OPTIONS=--max-old-space-size=12288 (SDK types are large)
openclaw plugins install --link --force --accept-capabilities .
openclaw gateway restart
```

Compiles against `openclaw@2026.9.2`; `openclaw.compat.pluginApi` in
`package.json` pins the supported host range.
