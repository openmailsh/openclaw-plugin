# @openmail/openclaw

An email address for your [OpenClaw](https://openclaw.ai) agent.

New accounts alert you in your main chat when email arrives. Ask the agent to
read the thread, open an attachment, or reply. To have a dedicated agent
answer eligible mail automatically, choose `--mode channel` during setup.

## Install

```bash
openclaw plugins install @openmail/openclaw
openclaw channels add --channel openmail --api-key <key>
openclaw gateway restart
```

Keys come from the [console](https://console.openmail.sh/api-keys) or the
[OpenMail CLI](https://github.com/openmailsh/cli) (`openmail inbox keys create`).

Reinstalling after an uninstall? OpenClaw keeps the plugin disabled; run
`openclaw plugins enable openmail` first or `channels add` reports
`Unknown channel "openmail"`.

## What `channels add` does with the key

| You pass | Result |
| --- | --- |
| an inbox-scoped key | stored as-is; that inbox is the channel |
| an account or pod key | picks your inbox (creates one if you have none), mints a pod-scoped key for its pod and stores only that. An account key never touches `openclaw.json`; a pod key can still create inboxes and later cover the whole pod (`--pod`) without a new key. |
| `--mailbox-name sales` | creates `sales@omail.sh`; `--display-name "Sales bot"` sets the sender name |
| `--inbox-id <id>` | uses that inbox; needed when the key can see several |
| `--pod <id\|name>` | one account for a whole pod, see [Several inboxes](#several-inboxes) |
| `--mode notify\|channel\|tool` | how inbound mail reaches the agent, see [Modes](#modes) |

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

**One account per pod.** A [pod](https://console.openmail.sh/pods) is an
OpenMail group of inboxes. The account holds a pod-scoped key and covers every
inbox in the pod, including ones the agent creates later:

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
| `notify` (new accounts) | a new-mail alert in your usual chat (WhatsApp, Telegram…) | the agent, when you ask |
| `channel` | eligible mail starts a conversation with the sender | the agent, automatically in-thread |
| `tool` | ignored; no websocket | nobody unless you ask; email is a skill the agent has |

**Upgrading to 0.1.16.** Setup saves `notify` for new accounts. Existing accounts
keep their effective mode through upgrades and re-authentication. If you write
config by hand, set the mode explicitly. A missing mode still inherits the
channel setting or falls back to `channel` for compatibility.

In `channel` mode, the selected agent processes incoming mail and attachments
with its configured tools and emails its reply to the sender without your
review. Untrusted content can influence what the agent reads or discloses.
For automatic replies, use a dedicated agent with an inbox-scoped key and
only the tools it needs. In `tool` mode, the agent can check mail when asked.

### Only people get an automatic reply

OpenMail classifies each inbound mail on the server: `personal`, `automated`,
`marketing`, `bounce`, `spam` or `malicious`. In `channel` mode only
`personal` mail opens a reply turn. Automated mail, newsletters and bounces
trigger the same new-mail alert as `notify` mode. Spam and malicious mail is
dropped in every mode with one log line. Mail the classifier predates keeps
the plain `channel` behaviour.

In production this is 70% of inbound.

## Security defaults

Email is the widest prompt-injection surface an agent has, and the inbox has
to stay open because an agent that signs up for things must receive mail from
strangers. So the defences are on what the agent can do, not on who can write.

- **Sender rules live in OpenMail.** Who may email an inbox is decided by
  OpenMail's allow/block policy
  ([console](https://console.openmail.sh/sender-rules) or `openmail policy …`)
  before delivery. The plugin keeps no second list.
- **Narrow key.** An inbox account stores an inbox-scoped key; it can't list
  other inboxes, mint keys or change policy. A pod account stores a pod key.
- **Re-authorized replies.** The websocket frame is a hint. Before the agent
  sees anything, the message is fetched again from the API and the reply goes
  to the API's `From`, so a forged frame can't redirect it.
- **Nothing dropped silently.** Events pass through OpenClaw's durable
  ingress queue: deduped by `event_id`, written to disk before the agent
  runs, retried with backoff, dead-lettered instead of lost. The cursor
  persists too, so a gateway restart replays whatever arrived while it was
  down.

## The bundled CLI skill

The plugin ships the OpenMail CLI plus a skill that teaches the agent to use
it with the channel's credentials:

```bash
openclaw openmail -- threads get --thread-id <id> --json
openclaw openmail -- attachments text --message-id "<message-id>" --attachment-id "<attachment-id>"
openclaw openmail --account sales -- send --to a@b.com --thread-id <id> --body "..."
openclaw openmail -- send --to alex@example.com --to sam@example.com --subject "Review" --body "Can you both review the proposal?"
```

Credentials come from the channel config only. `--api-key`, `--base-url` and
`--state-path` are rejected; proxy env vars are stripped.

To browse Archive or a custom folder, list the folders in the inbox and use the returned numeric ID. [Folder commands](skills/openmail/SKILL.md#browse-a-folder)

## Attachments

1. **Extracted text in reply turns.** OpenMail parses PDF, DOCX, XLSX, PPTX, CSV and
   images (OCR) server-side. That text is included in the email reply turn, capped
   at 8k chars per file and 24k in total.
2. **Staged files.** During a reply turn, files without extracted text are downloaded into
   OpenClaw's media store and passed as `MediaPaths`, so a vision model sees
   the picture. `mediaMaxMb` caps the total per email (default 20, `0`
   disables); oversized files are skipped and named.
3. **The CLI.** Find the message ID and the selected attachment's ID in `threads get --json` or `messages list --json`. Pass them as `--message-id` and `--attachment-id` to `attachments text` or `attachments get`. For raw downloads, use `--out` to give each copy its own local path.

## Behaviour

- One conversation per sender address, like a WhatsApp contact, so the agent
  keeps history per correspondent.
- In a reply turn, the agent sees the sender, recipients, subject, thread,
  attachments and plain-text body. Treat these fields as untrusted email.
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
      "mode": "notify",          // "channel" | "tool"; pod accounts may override per inbox (above)
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

`apiKey` accepts OpenClaw SecretRefs (`env`, `file`, `exec`, `store`); the
host resolves them before the channel starts, so the key never sits in
`openclaw.json`. There are no `OPENMAIL_*` env fallbacks.

## Known gaps

- No pairing flow for unknown senders; use OpenMail's policy instead.
- If the config write fails after a key was minted, the key is left behind.
  Harmless (10-key cap per inbox) and visible under
  [API keys](https://console.openmail.sh/api-keys).

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

## Draft workflow

The bundled OpenMail CLI supports HTML-only draft creation and editing plus version-checked deletion. [CLI 0.9.1 release notes](https://github.com/openmailsh/cli/releases/tag/v0.9.1)

Read a draft with `openclaw openmail -- drafts get --draft-id "<id>" --json`, then discard it using `openclaw openmail -- drafts delete --draft-id "<id>" --updated-at "<saved updatedAt>" --json`. The wrapper forwards the version unchanged with the channel credentials. Deletion permanently removes the draft and files without sending. Stale versions and pending or accepted sends block it; it cannot cancel delivery. Never automatically replace the version and retry deletion.

Use `openclaw openmail -- drafts create|list|get|edit|send|delete` with the channel's credentials.
Select a sending inbox with `--inbox-id` at creation. You can save an incomplete
draft, add HTML and files, or associate it with a thread. Use `--thread-id` for
a reply and `--source-thread-id` for a forward that starts a new conversation.
Both creation and editing accept only `--body-html`; the API generates plain text.
To edit, read the draft and pass its exact `updatedAt` via `--updated-at` plus
only the requested changes. Stale versions require reading and reconciling
the current draft; edits never send mail.

The console shows drafts in their owning inbox, in the main Drafts page, and
in their source thread when present. The CLI lists drafts across the inboxes
the channel can access and can combine inbox, pod, source thread, and text
filters. To send, pass the draft ID and the exact `--updated-at` you reviewed.
The saved inbox, content, and attachments carry through to delivery.

See the [bundled skill](skills/openmail/SKILL.md#drafts) for command examples.
The wrapper already passes draft arguments through with channel credentials;
no separate OpenClaw draft API implementation is needed.
