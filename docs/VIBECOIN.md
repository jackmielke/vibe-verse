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

## 5. The MCP arcade — Jack's friend's proposal, worked through

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

## 6. Open decisions

These are real forks, listed so they get decided rather than defaulted into.

**Do guest and account wallets ever merge?** Today they do not. The cleanest
answer is probably a one-time, one-way claim: signing in offers "bring your
guest balance across", once, and burns the guest wallet. Needs a UI and a
server action that cannot be replayed.

**Does the ledger ever touch $VIBE?** The tempting version is a seasonal
airdrop: top arcade earners get a real distribution. It is also the version
that turns every payout bug into a financial one. If it happens it should be a
manual, reviewed, off-cycle transfer against a published snapshot — never an
automatic bridge.

**What happens to `arcade_play` coin?** It currently goes to
`system/arcade`, which is a real wallet nobody spends from — an effective burn.
Worth deciding whether that pot funds something visible (a weekly prize, a
community bounty) so the sink has a story.

**Should the sky-island games move behind the arcade's insert/settle flow?**
They pre-date it and mint without charging. Unifying would be tidier and would
make `game_reward` redundant, but it also makes free worlds cost money, which
is probably wrong.

---

## 7. Quick reference

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
