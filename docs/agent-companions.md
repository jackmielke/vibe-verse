# Agent Companions — deploy your own agent that messages you

Let anyone create a personal agent (pet / collaborator) that lives in the
VibeVerse **and** can message them on Telegram — and that they can message
back to steer. Built on top of what already exists (`world_agents`,
`agent-reply`, the shared-bot Telegram send used by `god-orb-wish` /
`agent-selfie`).

## The bot model — dedicated shared bot + per-user chat link

We use **one dedicated VibeVerse Telegram bot** for everyone, and link each
user's Telegram `chat_id` to their account. We do **not** ask users to make
their own bot with BotFather — that's a ~6-step developer flow that kills
adoption (especially for kids) and makes us store everyone's bot tokens (a
password-grade liability).

- **Reaching a user = knowing their `chat_id`.** Once linked, the shared bot
  can DM them; the agent's identity lives in the message (`🐸 Pip: …`).
- **BYO-bot (BotFather) is a future optional upgrade** for power users who
  want their agent to have its own @handle. The `chat_id` link is the
  universal primitive; BYO-bot just swaps which bot sends.

### Linking flow (2 taps, zero BotFather)
1. In-game: tap **Connect Telegram**. Client asks the server for a short
   one-time `link_code` and opens `t.me/<VibeVerseBot>?start=<link_code>`.
2. User taps **Start**. Telegram delivers `/start <link_code>` to our
   webhook; we look up the pending code, store `message.chat.id` against the
   user, and reply "✅ linked — your companion can reach you here."

## Data model

- `world_agents.owner_id uuid null` — the user who created this agent
  (null = system/seed residents). RLS: a user may insert/update/delete their
  own agents; everyone may read agents in their room.
- `telegram_links` — `user_id uuid`, `chat_id bigint`, `linked_at`,
  and a transient `link_code`/`code_expires_at` for the handshake
  (or a separate `telegram_link_codes` table). One active chat per user.

## Edge functions

- **`telegram-webhook`** (new) — the dedicated bot's webhook target.
  - `/start <code>` → resolve code → store `chat_id` → confirm.
  - Any other message → route to the sender's agent: append to the agent's
    backlog and/or call `agent-reply`, then reply through the bot. **This is
    the "message an agent → backlog + voice" roadmap item**: the user's
    Telegram thread *is* the agent's backlog. Voice notes come free later.
- **`agent-dm`** (new, or fold into an existing fn) — outbound: given
  `{ agentId | ownerId, text }`, look up the owner's `chat_id` and
  `sendMessage` via the dedicated bot, prefixed with the agent's name/emoji.
  Reuses the exact send pattern in `god-orb-wish` / `agent-selfie`.

Proactive triggers for v1 (keep it a real companion, not a gimmick):
- "come back soon 👋" when the owner's been away a while
- relays an in-world message left for the owner
- a daily check-in / nudge

## In-game flow — "hatch your companion"

A small **Agent Nursery** near the town square (or via Vibey):
1. **Personality** — name + one line "what's it like / what should it do for
   you?" (this line becomes the agent `prompt`) + pick a look. One screen.
2. **Connect Telegram** (optional, encouraged) — the 2-tap link above.
3. **It's alive** — inserts a `world_agents` row `owner_id = you`, spawns
   wandering near you, talkable in-world (`agent-reply` already works), and
   able to DM you once linked.

## Setup (one-time, needs the bot owner)

1. BotFather → `/newbot` → name + username → copy the token.
2. Store the token as a Supabase **secret** `VIBEVERSE_BOT_TOKEN` (dashboard
   → Edge Functions → Secrets, or CLI). **Never** commit/log/print it.
3. Point the webhook at the function:
   `https://api.telegram.org/bot<token>/setWebhook?url=<telegram-webhook url>`.
4. Note the bot @username for the deep link (client env / config).

## Sequencing (ship in chunks)

1. **chat-id link** — `telegram-webhook` + Connect-Telegram deep link.
   Unlocks everything; testable the moment the bot exists.
2. **companion create** — `owner_id` migration + Agent Nursery UI; your
   agent spawns and wanders (independent of Telegram).
3. **proactive messages** — `agent-dm` + away/relay/daily triggers.
4. **reply-to-steer** — inbound TG routes to the agent backlog + reply.

## Security / scale notes

- Never log or commit `VIBEVERSE_BOT_TOKEN`. Treat inbound webhook payloads
  as untrusted (validate the `link_code`; rate-limit).
- A shared bot DMing many users is well within Telegram's model (a bot may
  DM anyone who has `/start`-ed it). No rate concern at current scale.
- RLS so a user can only create/steer their own companions.
