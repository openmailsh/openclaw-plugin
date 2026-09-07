# @openmail/openclaw

Give your [OpenClaw](https://openclaw.ai) agent its own email address.

Your agent gets an address like `sales@omail.sh`. Mail sent there reaches
it as a conversation, so it can answer in-thread, open attachments, or just
tell you what arrived and wait for instructions. Outbound works too, when you
let it. The channel runs inside the OpenClaw gateway you already have, with
one API key scoped to that single inbox.

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
| `--inbox-id <id>` | uses that existing inbox, needed when the key can see several |
| `--pod <id>` | covers a whole pod instead of one inbox; see [Several inboxes](#several-inboxes) |
| `--mode notify` / `--mode tool` | how inbound mail reaches the agent; see [Modes](#modes). Default `channel`. |
| `--allow-from a@x.com,x.com` | optional local filter: only these senders (addresses, domains, `*.x.com`) reach the agent. **Default: everyone** the inbox receives from. Server-side allow/block rules are yours to manage in the OpenMail console or CLI; the plugin never writes them. |

The address to email is printed at the end. Re-running against an existing
account is a no-op.

## Several inboxes

Two ways.

**One account per inbox.** Each gets its own key, websocket, status line, and
can be bound to a different agent:

```bash
openclaw channels add --channel openmail --account support --api-key <key> --mailbox-name support
openclaw channels add --channel openmail --account sales   --api-key <key> --mailbox-name sales
openclaw channels status
# - OpenMail support: enabled, configured, running, connected
# - OpenMail sales:   enabled, configured, running, connected
```

**One account per pod.** A pod is an OpenMail group of inboxes. The account
holds a pod-scoped key and covers every inbox in it, including ones the agent
creates later:

```bash
openclaw channels add --channel openmail --account outreach --api-key <account key> --pod outreach
# Minted a pod-scoped API key for outreach (pod_…), 2 inbox(es); the account key you passed is not stored.
```

Then, at runtime, the agent (or a subagent it hands the inbox id to) can:

```bash
openclaw openmail --account outreach -- inbox create --mailbox-name outreach-3
openclaw openmail --account outreach -- send --inbox-id <id> --thread-id <thr> --to … --body …
```

New inboxes stream inbound mail within a minute (the gateway re-subscribes on
a timer). Each `(inbox, sender)` pair is its own conversation, replies go out
from the inbox that received the mail, and `--pod` accepts the pod id, its
`clientId`, or its name. Trade-off: the stored key can read every inbox in the pod, not one.

## Security defaults

Email is the easiest prompt-injection surface an agent has. The inbox itself
is open (an agent that signs up for services must receive mail from anyone),
so the defences are on what the agent can *do*, not on who can write:

- **Sender rules stay yours.** The plugin never writes server-side allow/block
  rules; manage those in the OpenMail console or CLI (`openmail policy …`).
  `allowFrom` / `dmPolicy` in OpenClaw config add an optional local filter.
- **Least-privilege key.** Only an inbox-scoped key is stored; it cannot list
  other inboxes, mint keys, or change policy.
- **Re-authorized replies.** The websocket frame is only a hint. Before the
  agent sees anything, the message is re-fetched from the API and the
  allowlist is re-run against the *API's* `From`; a forged frame naming an
  allowed sender is dropped. Replies go to the verified address.
- **No silent drops.** Installed from npm, events go through OpenClaw's durable
  ingress queue: deduped by `event_id`, persisted before the agent runs,
  retried with backoff, dead-lettered rather than lost. A path-linked dev
  install falls back to in-memory retries (2s, 10s, 30s). Either way the
  cursor is persisted, so a gateway restart replays what arrived while down.

## The bundled CLI skill

The plugin ships the OpenMail CLI and a skill that teaches the agent to use
it through the channel's credentials:

```bash
openclaw openmail -- threads get --thread-id <id> --json
openclaw openmail -- attachments text --message-id <id> --filename report.pdf
openclaw openmail --account sales -- send --to a@b.com --thread-id <id> --body "..."
```

Credentials come from the channel config only; `--api-key`, `--base-url`,
and `--state-path` are rejected, and proxy env vars are stripped.

## Attachments

Inbound attachments reach the agent three ways, in order of preference:

1. **Extracted text, inline.** OpenMail parses PDF, DOCX, XLSX, PPTX, CSV and
   images (OCR) server-side; that text is appended to the notification
   (capped at 8k chars per file, 24k total).
2. **Staged files.** Anything without extracted text (images, archives) is
   downloaded into OpenClaw's media store and handed over as `MediaPaths`, so a
   vision-capable model sees the picture. Budget: `mediaMaxMb` per email
   (default 20; `0` disables). Oversized files are skipped and named.
3. **The CLI.** For anything else the notification says exactly what to run:
   `openclaw openmail -- attachments text --message-id <id> --filename <name>`.

## Modes

One channel, three ways to use it. Pick per account with `--mode` or
`channels.openmail.mode`.

| Mode | Inbound mail | Who replies |
| --- | --- | --- |
| `channel` (default) | wakes the agent as a conversation with the sender | the agent, in-thread, automatically |
| `notify` | the agent tells you about it on your usual chat (WhatsApp, Telegram…), no auto-reply | you, by asking the agent to reply |
| `tool` | ignored; no websocket | nobody unless you ask; email is just a skill |

`notify` fits a personal inbox: the agent relays "Stripe says your card
expires Friday" and only answers the sender when you say so. `channel` fits an
inbox that *is* the agent (support@, sales@). `tool` fits "sign up for X and
tell me the code" flows where the agent reads the inbox itself via the CLI.
Re-authorization and `allowFrom` apply in every mode.

## Behaviour

- Each sender address is a separate conversation (like a WhatsApp contact), so
  the agent keeps history per correspondent.
- The agent sees `From / To / Subject / Thread / Attachments` followed by the
  plain-text body. Email content is untrusted input; the agent's system prompt
  should say so.
- Replies go to the original sender via `POST /v1/inboxes/{id}/send` with the
  thread id, so they land in-thread with a `Re:` subject and quoted original.
- The agent can also start threads: `openclaw message send --channel openmail
  --to a@b.com "…"` (first line becomes the subject) or the CLI `send`.
  Outbound allow/block rules, if you want them, live in OpenMail
  (`openmail policy … --direction outbound`).
- Who may email the inbox is governed by OpenMail's allow/block rules
  (console or CLI). `channels.openmail.allowFrom` is an optional local filter
  with entries like `"someone@x.com"`, `"x.com"`, `"@x.com"` or `"*.x.com"`;
  setting it implies `dmPolicy: "allowlist"`. `"open"` (default) hears from
  everyone; `"disabled"` from nobody.
- Mails from the same sender are processed in order; different senders run
  in parallel.

## Config

```json5
{
  "channels": {
    "openmail": {
      "apiKey": "om_…",          // inbox-scoped, or a SecretRef (below)
      "inboxId": "…",             // or "podId": "…" for a whole pod
      "mode": "channel",         // default; or "notify" / "tool"
      "allowFrom": ["@yourcompany.com"],  // optional local filter; default: everyone
      "mediaMaxMb": 20,          // default
      "accounts": {
        "sales": {
          "apiKey": { "source": "env", "provider": "default", "id": "OPENMAIL_SALES_KEY" },
          "inboxId": "…"
        }
      }
    }
  }
}
```

`OPENMAIL_API_KEY` / `OPENMAIL_INBOX_ID` / `OPENMAIL_BASE_URL` work as env
fallbacks for the default account. `apiKey` accepts OpenClaw SecretRefs
(`env`, `file`, `exec`, `store` providers); the host resolves them before the
channel starts, so the key never sits in `openclaw.json`.

## Not yet

- Notify mode (summarise to your chat channel instead of auto-replying).
- OpenClaw pairing flow for unknown senders.
- If the config write fails after a key was minted, the key is left behind.
  Harmless (10-key cap per inbox), visible in the dashboard.

## Develop

```bash
pnpm install
pnpm build            # tsc; needs NODE_OPTIONS=--max-old-space-size=12288 (SDK types are large)
pnpm test             # vitest: allowlist, provisioning, re-auth, ingress, CLI guards
pnpm manifest         # regenerate openclaw.plugin.json + package.json#openclaw from src
pnpm validate-plugin  # install into a throwaway OpenClaw host and assert it loads
pnpm check            # all of the above; also runs on publish and in CI
openclaw plugins install --link --force --accept-capabilities .
openclaw gateway restart
```

`openclaw.plugin.json` and the `openclaw` block of `package.json` are
**generated** from `src/config-schema.ts` and `src/setup.ts`; edit those, then
`pnpm manifest`. CI fails on a stale manifest.

Compiles against `openclaw@2026.9.2` (pinned in `devDependencies`); the
generated `compat` / `install.minHostVersion` follow that pin.
