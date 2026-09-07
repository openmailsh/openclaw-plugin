# @openmail/openclaw

An email address for your [OpenClaw](https://openclaw.ai) agent.

Mail to `sales@omail.sh` reaches the agent as a conversation with the sender,
and whatever it writes back goes out in the same thread. Notifications and
newsletters are announced rather than answered. The agent can also read
attachments, start new threads, and create more inboxes, all through the
gateway you already run.

## Install

```bash
openclaw plugins install @openmail/openclaw
openclaw channels add --channel openmail --api-key <key>
openclaw gateway restart
```

Keys come from [app.openmail.sh](https://app.openmail.sh) or the
[OpenMail CLI](https://github.com/openmailsh/cli) (`openmail inbox keys create`).

## What `channels add` does with the key

| You pass | Result |
| --- | --- |
| an inbox-scoped key | stored as-is; that inbox is the channel |
| an account or pod key | picks your inbox (creates one if you have none), mints an inbox-scoped key for it and stores only that. The broad key never touches `openclaw.json`. |
| `--mailbox-name sales` | creates `sales@omail.sh`; `--display-name "Sales bot"` sets the sender name |
| `--inbox-id <id>` | uses that inbox; needed when the key can see several |
| `--pod <id\|name>` | one account for a whole pod, see [Several inboxes](#several-inboxes) |
| `--mode notify` / `--mode tool` | how inbound mail reaches the agent, see [Modes](#modes) |

## Several inboxes

**One account per inbox.** Each has its own key, websocket and status line,
and can be bound to a different agent:

```bash
openclaw channels add --channel openmail --account support --api-key <key> --mailbox-name support
openclaw channels add --channel openmail --account sales   --api-key <key> --mailbox-name sales
openclaw channels status
# - OpenMail support: enabled, configured, running, connected
# - OpenMail sales:   enabled, configured, running, connected
```

**One account per pod.** A pod is an OpenMail group of inboxes. The account
holds a pod-scoped key and covers every inbox in the pod, including ones the
agent creates later:

```bash
openclaw channels add --channel openmail --account outreach --api-key <account key> --pod outreach
# Minted a pod-scoped API key for outreach (pod_…), 2 inbox(es); the account key you passed is not stored.
```

At runtime the agent, or a subagent it hands an inbox id to, can:

```bash
openclaw openmail --account outreach -- inbox create --mailbox-name outreach-3
openclaw openmail --account outreach -- send --inbox-id <id> --thread-id <thr> --to … --body …
```

A new inbox streams mail within a minute; the gateway re-subscribes on a
timer. Each `(inbox, sender)` pair is its own conversation and replies leave
from the inbox that received the mail. Inboxes inherit the account's `mode`
unless overridden by address or id:

```json5
"inboxes": {
  "support@omail.sh": { "mode": "channel" },
  "me@omail.sh":      { "mode": "notify" },
  "signups@omail.sh": { "mode": "tool" }   // inbound ignored; CLI only
}
```

The trade-off: a pod key reads every inbox in the pod, not one.

## Modes

Set per account with `--mode` or `channels.openmail.mode`.

| Mode | Inbound mail | Who replies |
| --- | --- | --- |
| `channel` (default) | wakes the agent as a conversation with the sender | the agent, in-thread |
| `notify` | the agent tells you on your usual chat (WhatsApp, Telegram…) | you, by asking the agent |
| `tool` | ignored; no websocket | nobody unless you ask; email is a skill the agent has |

`channel` is for an inbox that *is* the agent (support@, sales@). `notify` is
for your own inbox: "Stripe says your card expires Friday", and the agent only
writes to Stripe if you tell it to. `tool` is for "sign up for X and tell me
the code", where the agent polls the inbox itself via the CLI.

### Only people get an automatic reply

OpenMail classifies each inbound mail on the server: `personal`, `automated`,
`marketing`, `bounce`, `spam` or `malicious`. In `channel` mode only
`personal` mail opens a reply turn. A GitHub notification, a verification
code or a newsletter is handed to the agent as information, the way `notify`
delivers everything; the agent learns the code arrived and doesn't email
`noreply@` back. Spam and malicious mail is dropped in every mode with one log
line. Mail the classifier predates keeps the plain `channel` behaviour.

In production this is 70% of inbound.

## Security defaults

Email is the widest prompt-injection surface an agent has, and the inbox has
to stay open because an agent that signs up for things must receive mail from
strangers. So the defences are on what the agent can do, not on who can write.

- **Sender rules live in OpenMail.** Who may email an inbox is decided by
  OpenMail's allow/block policy (console or `openmail policy …`) before
  delivery. The plugin keeps no second list.
- **Narrow key.** An inbox account stores an inbox-scoped key; it can't list
  other inboxes, mint keys or change policy. A pod account stores a pod key.
- **Re-authorized replies.** The websocket frame is a hint. Before the agent
  sees anything, the message is fetched again from the API and the reply goes
  to the API's `From`, so a forged frame can't redirect it.
- **Nothing dropped silently.** Installed from npm, events pass through
  OpenClaw's durable ingress queue: deduped by `event_id`, written to disk
  before the agent runs, retried with backoff, dead-lettered instead of lost.
  A path-linked dev install retries in memory (2s, 10s, 30s). Both persist
  the cursor, so a gateway restart replays whatever arrived while it was down.

## The bundled CLI skill

The plugin ships the OpenMail CLI plus a skill that teaches the agent to use
it with the channel's credentials:

```bash
openclaw openmail -- threads get --thread-id <id> --json
openclaw openmail -- attachments text --message-id <id> --filename report.pdf
openclaw openmail --account sales -- send --to a@b.com --thread-id <id> --body "..."
```

Credentials come from the channel config only. `--api-key`, `--base-url` and
`--state-path` are rejected; proxy env vars are stripped.

## Attachments

1. **Extracted text, inline.** OpenMail parses PDF, DOCX, XLSX, PPTX, CSV and
   images (OCR) server-side. That text is appended to the notification, capped
   at 8k chars per file and 24k in total.
2. **Staged files.** Anything without extracted text is downloaded into
   OpenClaw's media store and passed as `MediaPaths`, so a vision model sees
   the picture. `mediaMaxMb` caps the total per email (default 20, `0`
   disables); oversized files are skipped and named.
3. **The CLI.** For the rest, the notification says exactly what to run.

## Behaviour

- One conversation per sender address, like a WhatsApp contact, so the agent
  keeps history per correspondent.
- The agent sees `From / To / Subject / Thread / Attachments` then the
  plain-text body. Email is untrusted input; say so in the system prompt.
- Replies use `POST /v1/inboxes/{id}/send` with the thread id and land
  in-thread with a `Re:` subject and the original quoted.
- New threads: `openclaw message send --channel openmail --to a@b.com "…"`
  (first line becomes the subject) or the CLI `send`. Outbound allow/block
  rules, if you want them, live in OpenMail (`openmail policy … --direction outbound`).
- Mail from one sender is processed in order; different senders run in parallel.

## Config

```json5
{
  "channels": {
    "openmail": {
      "apiKey": "om_…",          // inbox-scoped, or a SecretRef (below)
      "inboxId": "…",            // or "podId" for a whole pod
      "mode": "channel",         // "notify" | "tool"; pod accounts may override per inbox (above)
      "mediaMaxMb": 20,
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

`OPENMAIL_API_KEY`, `OPENMAIL_INBOX_ID` and `OPENMAIL_BASE_URL` are env
fallbacks for the default account. `apiKey` accepts OpenClaw SecretRefs
(`env`, `file`, `exec`, `store`); the host resolves them before the channel
starts, so the key never sits in `openclaw.json`.

## Known gaps

- No pairing flow for unknown senders; use OpenMail's policy instead.
- If the config write fails after a key was minted, the key is left behind.
  Harmless (10-key cap per inbox) and visible in the dashboard.

## Develop

```bash
pnpm install
pnpm build            # tsc; needs NODE_OPTIONS=--max-old-space-size=12288 (SDK types are large)
pnpm test             # vitest: provisioning, re-auth, classification, ingress, CLI guards
pnpm manifest         # regenerate openclaw.plugin.json + package.json#openclaw from src
pnpm validate-plugin  # install into a throwaway OpenClaw host and assert it loads
pnpm check            # all of the above; runs on publish and in CI
openclaw plugins install --link --force --accept-capabilities .
openclaw gateway restart
```

`openclaw.plugin.json` and the `openclaw` block of `package.json` are
generated from `src/config-schema.ts` and `src/setup.ts`. Edit those, then run
`pnpm manifest`; CI fails on a stale manifest.

Compiles against `openclaw@2026.9.2` (pinned in `devDependencies`); the
generated `compat` and `install.minHostVersion` follow that pin.
