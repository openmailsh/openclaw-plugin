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
| `--allow-from a@x.com,x.com` | who may email the agent (addresses, domains, `*.x.com`, or `"*"` for anyone). Set server-side on the inbox and mirrored locally. **Default: nobody** — a fresh channel accepts no mail until you add a sender. |
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

## Security defaults

Email is the easiest prompt-injection surface an agent has, so the channel is
closed until you open it:

- **Default-deny senders.** `dmPolicy` defaults to `allowlist`; an empty
  `allowFrom` accepts nobody. `open` only works with `"*"` in `allowFrom`.
  The list is applied server-side (OpenMail correspondent policy) when the
  key can set policy, and always enforced locally.
- **Reply-only.** The agent can reply in the thread that woke it. It cannot
  start a new thread or mail an arbitrary address unless you set
  `allowNewThreads: true`. This also gates `openclaw message send --channel openmail`.
- **Least-privilege key.** Only an inbox-scoped key is stored; it cannot list
  other inboxes, mint keys, or change policy.
- **No silent drops.** A failed agent turn is retried (2s, 10s, 30s), then the
  event is released for server replay; the cursor is persisted so a gateway
  restart replays mail that arrived while it was down.

## The bundled CLI skill

The plugin ships the OpenMail CLI and a skill that teaches the agent to use
it through the channel's credentials:

```bash
openclaw openmail -- threads get --thread-id <id> --json
openclaw openmail -- attachments text --message-id <id> --filename report.pdf
openclaw openmail --account sales -- send --to a@b.com --thread-id <id> --body "..."
```

Credentials come from the channel config only; `--api-key`, `--base-url`,
and `--state-path` are rejected, and proxy env vars are stripped. That is how
the agent reads attachments (PDF, DOCX, XLSX, PPTX, images via OCR): the
inbound notification names them and the skill says how to read them.

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
- OpenClaw pairing flow for unknown senders.
- Secret refs (`apiKey: { source: "env", ... }`); plain strings only for now.
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
