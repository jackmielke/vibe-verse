# Vibecoin

The currency of the vibeverse. This document is the map: what exists today,
where it lives in the code, what the rules are, and what the next few moves
look like.

---

## 1. There are two Vibecoins, and it matters which one you mean

This is the single most important thing to hold on to, because almost every
confused conversation about "the coin" is really two people meaning different
objects.

| | **The ledger** | **$VIBE on Base** |
|---|---|---|
| What it is | Rows in `vibe_balances` / `vibe_ledger` | An ERC-20 at `0x7255…a7d1` |
| Who has one | Everyone, instantly, signed in or not | Anyone who bought or was sent some |
| Starting balance | 100, granted on first touch | Zero |
| How you get more | Play worlds, win in the arcade | Buy it, or someone sends it |
| Who can move it | Only the `vibe-economy` edge function | The holder, with their own wallet |
| Is it money? | No. It is a game balance. | Yes, in the way any small token is |
| Code | `src/lib/vibecoin.ts` | `src/lib/vibe-wallet.ts` |
| Surface | The chip in the top-right, `/arcade` | `/coin` |

**The app never sends a transaction.** `/coin` links a wallet with a signature
and reads balances off a public RPC. `VibeShopPanel` is the one exception and
it hands the transaction to the user's own wallet to sign — we never hold a
key.

They are kept apart on purpose. The ledger can be generous, reversible,
inflationary and played with; the token cannot be any of those things. The
bridge between them — earn in the ledger, settle on-chain — is a decision with
real money on the other side of it and should be made deliberately rather than
by an import. See §6.

---

## 2. Where it lives

```
src/lib/vibecoin.ts            the one currency module: brand, owner, store, actions
src/hooks/use-vibecoin.ts      useVibecoin() — shared fetch, realtime, ref-counted
src/components/VibeCoinMark.tsx    the coin's face
src/components/VibeCoinChip.tsx    the balance in the corner + the ledger popover
src/arcade/cabinets.ts         the three machines and their payout curves
src/arcade/sounds.ts           blip, chime, coin drop
src/pages/VibeArcade.tsx       /arcade — the floor, the cabinet, the results card
src/lib/vibe-wallet.ts         the on-chain half: connect, sign, read, send
src/pages/VibeHub.tsx          /coin — price, holders, market
supabase/functions/vibe-economy/index.ts    every write to every balance
```

### Who a wallet belongs to

`currentOwner()` returns the signed-in user's uuid, or a stable guest id from
`localStorage["city.guestId"]`. The key is named for Vibe City because Vibe City
minted it first and there are real balances keyed to it in production —
renaming it would orphan every guest wallet that exists.

**Signing in does not merge a guest wallet into an account.** They are separate
rows. Pretending otherwise would silently double or destroy someone's balance
depending on which way we merged, and that is a product decision, not a default.
See §6.

### Why every write goes through an edge function

`vibe_balances` has RLS on and the browser has no path to it. The edge function
holds the service-role key, so a cheat has to beat the server's own clamps
rather than a client-side `if`. Concretely:

- Scores are **clamped to what a perfect run can produce** before any payout
  curve is applied. The worst a modified client can claim is "I was perfect",
  and perfect has a fixed price.
- Payouts are **capped per day**, per wallet.
- Arcade plays are **settled exactly once**, against a real debit.

It is not tamper-*proof*. A determined player can claim a perfect run they did
not have. For a browser game with no server-side simulation that is the right
trade, and the daily ceilings bound what it is worth doing.

---

## 3. Faucets and sinks

A currency is its faucets and its sinks. Everything below is enforced
server-side in `vibe-economy`.

### Faucets — where Vibecoin is created

| Source | Amount | Limit | Reason code |
|---|---|---|---|
| Welcome grant | 100 | Once per wallet | `starter` |
| Sky-island mini-games (Vibe City) | up to 120/run | 3 rewarded runs per game per day | `game_reward` |
| Arcade payouts | see paytables | 400/day total | `arcade_win` |
| Daily allowance | tops you up to 30 | Once a day, only if you are under 30 | `arcade_allowance` |
| Invite links | set per code | Once per person, capped per code | `invite` |

Invite grants are the one faucet an operator opens by hand, and the only one
that can mint an arbitrary amount. That is deliberate — "the first ten people
through this link get 250" is a party, not an economy — but it means the codes
are the thing to be careful with. See §5.

The allowance exists because the alternative is a dead end: spend your hundred,
lose every run, and the arcade becomes a room full of machines you can never
use again. That is a fine rule for a casino and a terrible one for a place
people are meant to come back to.

### Sinks — where Vibecoin is destroyed or moved

| Sink | Cost | Reason code |
|---|---|---|
| Arcade: Stacker | 10 | `arcade_play` |
| Arcade: Pattern | 8 | `arcade_play` |
| Arcade: Reflex | 6 | `arcade_play` |
| Agent services (Vibe City) | 5–19 | `service` |
| Agent items | 20–50 | `item` |
| Tips to agents | any | `tip` |
| Cosmetics (the shop) | 25–400 | `cosmetic` |
| ORBIT round buy-in | set per round | `round_stake` |
| Rock-paper-scissors ante | 25 | `rps_ante` |

The round stake is a *move*, not a burn: it goes to `system/round` and comes
straight back out as `round_win` (or `round_refund` if nobody scored). What goes
into a pot is exactly what comes out of it, so a round cannot inflate the
currency however popular it gets — see §5.

Before the arcade, **there were no sinks that took coin out of circulation** —
agent purchases move it to the agent's wallet, they do not burn it. The arcade
is the first thing in the vibeverse that charges, and that is why it exists as
much as because it is fun.

### The current balance of the system

A player who plays perfectly can clear the 400/day arcade ceiling plus ~330/day
from sky islands. A player who is bad at everything loses ~24/day to the
cabinets and gets topped back up to 30. Both numbers are deliberately small
relative to the 100 welcome grant: the economy should feel like it rewards
turning up, not like a job.

---

## 4. The arcade

`/arcade`. Three coin-operated cabinets, each a 2D canvas that starts on the
frame after you pay.

| Cabinet | Cost | Score | Top prize | Feel |
|---|---|---|---|---|
| **Stacker** | 10 | 12 rows | 88 | Timing. The classic. |
| **Pattern** | 8 | 14 rounds | 118 | Memory, curve accelerates |
| **Reflex** | 6 | 24 points | 58 | Reaction, eight windows |

### The transaction, in order

1. `arcade_insert` debits the stake and returns the **ledger row id of the
   debit**. That id is the play.
2. The cabinet runs. Nothing touches the network.
3. `arcade_settle` quotes the play id. The server checks it is real, is yours,
   is for this cabinet, is under an hour old, and has not already been settled —
   then clamps the score, applies the curve, applies the daily ceiling, and
   writes an `arcade_win` row that quotes the play id back.

That last part is the whole locking scheme: a settled play already has a
winning row naming it, so the second attempt finds it. No extra table, and it
survives a redeploy.

### The curve is written twice, on purpose

`CABINETS` in `src/arcade/cabinets.ts` and `ARCADE_SPECS` in the edge function
hold the same numbers. The client's copy exists so a cabinet can print an
honest paytable *before* you pay; the server's is the authority.

`src/test/arcade.test.ts` reads the edge function's source, pulls the curves
back out of it, and asserts the two agree at every reachable score. Drift fails
a test instead of a payroll.

### Adding a cabinet

1. Add a `Cabinet` to `CABINETS` with a `create()` returning a `CabinetRun`.
2. Mirror `{cost, maxScore, payout}` into `ARCADE_SPECS`.
3. Run the tests. That is it — the floor, the paytable and the ledger labels
   are all views of the one list.

---

## 5. Rounds and invites — the party

The arcade is a machine you play alone. A round is the other thing a currency
needs: a reason for two people to care about the same number at the same time.

Both live in **`vibe-rounds`**, a sibling edge function to `vibe-economy`. They
write the same balances through the same rules; the split is purely that
`vibe-economy` is a thousand lines of agent shops and wardrobe, every deploy
re-uploads all of it, and the pot shares nothing with Jerry's haiku stand but a
table name.

### The shape of a round

Everyone stakes the same amount into one pot, everyone flies the **same seeded
run** of ORBIT, and the best score takes the lot. A pool rather than a duel,
because for a party of ten a pool needs no matchmaking, no lobby, no presence
and no disconnect handling — latecomers just join, and the leaderboard is the
whole social object. One person can test the entire thing in two browser tabs.

Three properties make it worth betting on:

- **One sky.** The seed is per round, so everyone attempts the identical gate
  layout. A wager on a game where the obstacles differ is a raffle. ORBIT runs
  on a fixed 1/120 s timestep for the same reason — a player on a 144 Hz screen
  must not get a different game from one on a laptop.
- **The seed is not yours until you have paid.** `vibe_rounds` has no RLS read
  policy at all; the seed comes back from `round_enter`, and from
  `round_current` only once you are in. Otherwise you could practise the exact
  layout before deciding whether to stake on it, which is the one cheat that
  would make the whole thing pointless.
- **The pot is the stakes.** Nothing is minted. `settleDueRounds` pays the pot
  to the top scorer, or refunds every stake if nobody scored — a house that
  wins when the game breaks is not a good look for a party.

Settlement is idempotent by the status flip: the update that marks a round
settled is filtered on `status = 'open'`, so two callers racing cannot both pay.
It runs opportunistically inside `round_current`, so results appear without a
cron and without anybody having to trigger them.

### What stops a made-up score

Scores are client-reported, same as the arcade — this is a party game, not an
exchange, and the page says so in words. Two things narrow it:

- A hard ceiling (`ROUND_MAX_SCORE`).
- A **floor on the clock**: `round_score` takes `durationMs` and caps the
  accepted score at `durationMs / MIN_MS_PER_GATE`, where that constant is the
  narrowest gate spacing divided by the top angular rate in `src/orbit/orbit.ts`.
  A run cannot have cleared more gates than there was time for. It turns "post
  any number" into "post any number and sit there for it", which is about the
  right amount of rigour for play money.

The write itself is a single `update … set best_score = greatest(best_score, …)`
inside `vibe_round_record_score()`, not a read-then-write in the function. Two
tabs finishing at once would otherwise both read the old best and the worse run,
landing second, would clobber the better one.

### Invite links

A code, a grant, and a cap — `/join/:code`. The only interesting part is that
the cap is enforced per **person** rather than per click, which is why
`vibe_invite_claims` has `(code, owner_ref)` as its primary key and the insert
*is* the lock. After taking the claim the count is re-read and the slot handed
back if the cap filled underneath, so a stampede cannot over-issue.

`invite_peek` is unauthenticated and thin on purpose: the landing page has to
say "250 ✦, six left" before anyone signs in, and it must not become an oracle
that tells a stranger anything they could not already read off the link they
were sent. `vibe_invites` likewise has no read policy — the code is the secret.

**Claiming works as a guest.** A sign-in wall in front of a gift is how you lose
eight of the ten people you invited. The account and the wallet are offered
after, framed as ways to keep what they now have.

### The island table

Walk up to the half-round table on the Vibe Island plaza and play one hand of
rock-paper-scissors against the house for 25 ✦. It is the smallest possible
complete bet — no lobby, no opponent to find, ten seconds start to finish — and
it exists to prove the shape works before anything larger is built on it.

**Dead fair, and that is a decision.** A win returns 2× the ante, a tie returns
the ante, a loss returns nothing. Over decided hands the expected return is
exactly the stake. There is no rake, and ties push rather than going to the
house — the usual quiet way this game is rigged is to keep the tie, which is
about a 33% edge on a game people read as 50/50.

**The house holds a real float.** `agent/rps-house`, seeded at 50,000 ✦. Two
constraints on `vibe_balances` force this shape and are easy to trip over:
`owner_kind` is CHECKed to `('user','agent')`, so there is no `system` wallet —
which is why the arcade's take is an effective burn rather than a pot anyone
could spend — and `balance >= 0`, so the house has to hold money before it can
lose any. `rps_open` refuses to deal when the float cannot cover a win, which is
the honest version of the same limit.

#### Why a commitment, and what it proves

A house that picks its throw *after* seeing yours never loses, and from the
outside that is indistinguishable from luck. So a hand is two round trips with a
commitment between them:

1. `rps_open` — the server picks a throw and a random nonce, stores both, takes
   the ante, and returns **only** `sha256("<throw>:<nonce>")`.
2. You throw, having seen that hash and nothing else.
3. `rps_throw` — the server resolves, pays, and reveals its throw and nonce.

The browser then re-hashes the reveal and compares it to the commitment it was
handed in step 1 (`verifyCommit` in `src/rps/rps.ts`). A house that swapped its
throw would publish a hash that no longer matches, and the result panel says so
on screen. That is a check the player watches happen rather than a promise in a
FAQ — which is the whole reason the hash is on the table at all.

The throw itself comes from `crypto.getRandomValues` with rejection sampling,
not `Math.random`: 256 does not divide evenly into 3, and the naive modulo would
quietly bias the house toward rock.

#### What it does not claim

The ante is 25 ✦, not "a dollar". Ledger Vibecoin and $VIBE are different
objects with no rate between them (§1), so no dollar figure appears anywhere on
the table. Every hand does record the live $VIBE price at the moment it was
played, in `vibe_rps_rounds.vibe_price_usd`, together with the player's payout
address if they have linked one — so that if a rate is ever set, the whole
history can be priced. Reconstructing that from a chart afterwards is not
possible; recording it now costs two columns.

### Issuing codes

There is no admin UI; codes are rows.

```sql
insert into vibe_invites (code, grant_amount, max_claims, note, expires_at)
values ('ORBIT-A1', 250, 1, 'Opening Night', now() + interval '14 days');
```

One code per person with `max_claims = 1` is the version to prefer for a small
event: a shared code with a cap of ten is one screenshot away from being claimed
by ten strangers, and you cannot tell afterwards who was who.

### Opening a round

```sql
insert into vibe_rounds (game, title, seed, stake, closes_at)
values ('orbit', 'Opening Night', 'orbit-opening-night-01', 25,
        now() + interval '7 days');
```

`round_current` picks the open round closing soonest, so overlapping rounds are
technically possible but only one is ever live to the client. Pick a seed nobody
can guess — it is the layout everybody is betting on.

---

## 6. The MCP arcade — Jack's friend's proposal, worked through

The pitch, as received:

> The vibe arcade could be an MCP skill connection. Kids pay a small monthly
> fee for tokens to use to play in the arcade; they can also get MCP access to
> vibe new games or make changes and versions of other games collaboratively.
> The frontend would be the arcade, with token tracking and the games hosted.
> Payments would be buy-and-issue tokens. That would add utility and $ into the
> LP. You'd have to sell some tokens to cover server costs at the start.
> Promo/ads would be a collaborative place to play and build games with AI
> (whatever AI they want, since it'd be MCP-based). There'd need to be a
> specific framework for the games defined in the MCP so hosting them is easier
> and a consistent, preferably automated process.

This is a good idea and it is closer than it looks. Here is the honest state of
it.

### What is already true

- **The frontend is the arcade, with token tracking and the games hosted.**
  Built, shipped, live. `/arcade`.
- **A game framework exists.** `CabinetRun` is exactly the "specific framework
  for the games defined in the MCP" the note asks for: `frame(ctx, dt)`,
  `press(p)`, `done`. It is three methods and no dependencies. A cabinet is a
  single file that exports one function.
- **Hosting is consistent and automated.** A cabinet is a data entry plus a
  factory function; there is no per-game deploy step.
- **Payout enforcement is server-side.** A community-contributed cabinet cannot
  mint coins, because it does not decide what it pays — it reports a score to a
  curve that lives on the server.

### What the proposal actually needs next

**a. Cabinets have to become data, not code.** Today adding a cabinet means a
commit. For MCP-authored games it means a row: a `arcade_cabinets` table
holding `{key, name, cost, max_score, payout_expr, source, author, status}`,
with the game's source stored and loaded into a sandboxed worker. The payout
curve must stay a small, non-Turing-complete expression the server evaluates —
never author-supplied JavaScript with access to the ledger.

**b. Review is the whole security model.** A stranger's canvas code running on
our origin, next to a wallet, is the risk. Two layers: run the cabinet in a
Worker with no network and no storage (it only gets a canvas and returns a
score), and gate `status: published` on a human or agent review. The economy is
already safe from a hostile cabinet; the *page* is not, and that is the gap to
close before opening submissions.

**c. The MCP server is thin.** Four tools is the whole surface:
`list_cabinets`, `get_cabinet(key)`, `propose_cabinet(source, spec)`,
`test_cabinet(source)`. An author's agent writes a `CabinetRun`, runs it against
a headless harness (`scripts/arcade-shot.mjs` is most of that harness already),
and submits. Any model, any client — that is the point of MCP.

**d. The subscription is the part that is not built and not free.** Taking
money from anyone, and especially from kids, means Stripe, a real account
system, refunds, parental consent, and tax. The current ledger has none of that
and should not grow it by accident. **Recommendation: keep the in-app balance
free and non-purchasable for now.** Ship the MCP authoring loop first — that is
where all the interesting energy is, and it costs nothing to be wrong about.
The monetisation question gets much easier to answer once there are fifty
community cabinets and you can see which ones people actually play.

**e. On "adds utility and $ into the LP".** Be careful here, and be careful in
public. A token whose price depends on subscription revenue routed into a
liquidity pool is a security in most jurisdictions that matter, and the fact
that the customers are children makes it worse rather than better. The version
of this that is unambiguously fine: **$VIBE buys nothing and unlocks nothing.**
It is a community asset that exists alongside the arcade. The ledger balance is
what the arcade runs on, it cannot be bought, and it cannot be cashed out. Keep
that wall and the whole thing stays a game with a token next to it rather than
a token that needs a game.

### Suggested order

1. `arcade_cabinets` table + worker sandbox + one migrated cabinet, to prove
   data-driven works.
2. The four MCP tools, read-only first (`list`, `get`, `test`).
3. `propose_cabinet` into a review queue.
4. A `/arcade/new` page that is the same flow for people without an agent.
5. Only then: think about money.

---

## 7. Open decisions

These are real forks, listed so they get decided rather than defaulted into.

**~~Do guest and account wallets ever merge?~~ Decided: yes, once, one way.**
`claim_guest` moves a guest balance into the signed-in caller's account and
records the guest ref in `vibe_guest_claims`, whose primary key makes a replay
a constraint violation rather than a second payout. Claiming an *empty* guest
wallet is the common case and had to be handled specially — `vibe_ledger` has
`CHECK (amount > 0)`, so there is nothing to write there, which is the other
reason the claim needed its own table.

**Does the ledger ever touch $VIBE?** The tempting version is a seasonal
airdrop: top arcade earners get a real distribution. It is also the version
that turns every payout bug into a financial one. If it happens it should be a
manual, reviewed, off-cycle transfer against a published snapshot — never an
automatic bridge. `VibeWalletConnect` is built for exactly that shape: it
collects a *proven* address and nothing else, and the app still never sends a
transaction.

**Is the ledger's owner key the same thing as the payout address?** No, and
this is the sharp edge. A balance is keyed by `auth.uid` or a guest id;
`link-wallet` writes a row keyed by `wallet_address`. Nothing joins the two —
which is precisely the query an airdrop needs ("balance, by address"). Until
something does, a distribution has to be assembled by hand. Fixing it properly
means one identity with an optional address hanging off it, not three tables
that each think they are the user.

**What happens to `arcade_play` coin?** It currently goes to
`system/arcade`, which is a real wallet nobody spends from — an effective burn.
Worth deciding whether that pot funds something visible (a weekly prize, a
community bounty) so the sink has a story.

**Should the sky-island games move behind the arcade's insert/settle flow?**
They pre-date it and mint without charging. Unifying would be tidier and would
make `game_reward` redundant, but it also makes free worlds cost money, which
is probably wrong.

---

## 8. Quick reference

```ts
import { useVibecoin } from "@/hooks/use-vibecoin";
const { balance, display, ledger, refresh } = useVibecoin();

// Pay out for a world's mini-game. The server decides the amount.
import { award } from "@/lib/vibecoin";
await award("mole-meadow", score);

// Charge for something.
import { arcadeInsert, arcadeSettle } from "@/lib/vibecoin";
const { playId } = await arcadeInsert("stacker");  // throws if they cannot pay
const result = await arcadeSettle(playId, "stacker", score);  // null if offline
```

Every read falls back to a localStorage cache and every failure resolves rather
than rejects, except `arcadeInsert` — "the machine did not take your coin" is
the one failure a player has to be told about in words.
