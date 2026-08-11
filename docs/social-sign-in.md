# Signing in without an email

There are four doors into the vibeverse and they all end in the same place —
a Supabase session — so nothing downstream (`useVibeIdentity`, Vibecoin, the
wardrobe, the passport, RLS) knows or cares which one somebody came through.

| Door | Where it lives | Works right now? |
| --- | --- | --- |
| Email code / magic link | `VibeAuthDialog` | yes |
| Password | `VibeAuthDialog`, behind a toggle | yes |
| **MetaMask** (or any wallet) | `src/lib/walletAuth.ts` + `supabase/functions/wallet-auth` | **yes** |
| **Google** | `src/lib/oauth.ts` + `/auth/callback` | **needs a 10-minute setup, once** — see below |
| GitHub | `src/lib/oauth.ts`, offered on the account card only | same setup, never done |

Google and GitHub also appear on `VibeAccountCard` (the account panel in the
lobby and on `/profile`), where they *link* a provider to an account somebody
is already signed into rather than starting a new one. Both directions go
through `src/lib/oauth.ts` and share the one callback path, so enabling a
provider lights up every button for it at once.

---

## MetaMask — done, nothing to configure

Everything it needs is deployed: the `vibe_wallet_nonces` table and the
`wallet-auth` edge function. There is no key to paste anywhere and no console
to visit, which is most of why this one was the easier of the two.

### What happens when somebody presses the button

1. The browser asks the wallet for an account (`eth_requestAccounts`).
2. `wallet-auth { action: "nonce" }` **writes the sentence to be signed** and
   stores it. The message names the site, the address and a one-time nonce.
3. The wallet signs that exact string with `personal_sign`.
4. `wallet-auth { action: "verify" }` checks the signature *against the stored
   message*, spends the nonce, finds or creates the account, and mints a
   single-use `token_hash`.
5. The browser trades it for a session with `verifyOtp({ type: "magiclink" })`.

The three properties worth not breaking:

- **The server picks the message.** A signature over a string the client chose
  is a bearer token that never expires; one that can be replayed is not a login
  at all. Verification runs against the bytes in the nonce row, never against
  anything in the request body.
- **The nonce is spent with one conditional `UPDATE`.** Two tabs racing the
  same signature produce one session and one 401.
- **Signature checking goes through `publicClient.verifyMessage`**, not viem's
  bare `verifyMessage`. The bare one is plain ecrecover and only ever true for
  an EOA — every smart-contract wallet (Coinbase Smart Wallet, any passkey
  account) would be turned away at the door with "signature did not verify".

### Which wallet actually opens

The button says MetaMask because that is the name people look for, but it signs
in with whatever answered EIP-6963 discovery: someone running only Rabby gets
Rabby rather than an instruction to install a second wallet. On a phone with no
wallet at all it deep-links into the MetaMask app's browser, because MetaMask on
mobile *is* a browser and "go install the extension" is a dead end there.

### Accounts, and not forking people in two

If the wallet is already on an account — because they linked it on `/wallet`,
which is a different feature (`link-wallet`, "where do my tokens go") — signing
in lands them in *that* account. If `link-wallet` made a profile row for the
wallet but no login ever existed, the new auth user **adopts** that row via
`handle_new_user`'s `invited_user_id` path, so their name and their Vibecoin
come with them. Only a wallet nobody has ever seen gets a fresh account.

Wallet accounts carry a synthetic email, `0x…@wallet.vibeverse.id`. It is never
mailed. The domain is deliberately one we do not own and cannot be registered
into a mailbox that could receive a password reset for one of our accounts.

### Checking it still works

```bash
node scripts/wallet-auth-sigcheck.mjs                    # signs with a real key
npm run build && node scripts/social-login-check.mjs     # both buttons, real browser
npx vitest run src/test/walletAuth.test.ts src/test/oauth.test.ts
```

`social-login-check.mjs` covers the Google half too — it stands in for Google
with a 302 back to `/auth/callback`, which is the only part of that flow we
own. It runs against `dist/`, so build first.

`wallet-auth-sigcheck.mjs` holds a copy of the edge function's message builder.
If you change the message in `supabase/functions/wallet-auth/index.ts`, change
it there too — the copy is the point (it proves the format round-trips), but
nothing enforces the match.

---

## Google — one setup, then it works

The code is finished and wired. Until the two steps below are done,
`signInWithOAuth` returns an error instead of redirecting and the button
explains itself rather than silently doing nothing.

### 1. Google Cloud console — get a client ID and secret

1. <https://console.cloud.google.com/> → pick or create a project.
2. **APIs & Services → OAuth consent screen.** External. Fill in app name,
   support email, developer email. Add scopes `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`. While the app is in *Testing* only accounts on
   the test-users list can sign in, so either add yourself or hit **Publish**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application.**
4. Under **Authorised redirect URIs** add exactly one entry — Supabase's
   callback, not ours:

   ```
   https://efdqqnubowgwsnwvlalp.supabase.co/auth/v1/callback
   ```

   This is the single most common thing to get wrong. Google redirects to
   *Supabase*, and Supabase redirects to us. Putting our own URL here produces
   `redirect_uri_mismatch` and nothing else.
5. Copy the **Client ID** and **Client secret**.

### 2. Supabase dashboard — switch the provider on

1. **Authentication → Providers → Google.** Enable, paste both values, save.
2. **Authentication → URL Configuration.** Set **Site URL** to the production
   origin, and add every origin the app is served from to **Redirect URLs**:

   ```
   https://<production-domain>/auth/callback
   http://localhost:5173/auth/callback
   http://127.0.0.1:5177/auth/callback
   https://*.vercel.app/auth/callback
   ```

   An unlisted redirect does not error — it silently falls back to the Site
   URL, so a preview deploy sends you to production and you appear to be signed
   out. That is the second most common thing to get wrong.

That is all. No redeploy, no code change: the button starts working on the next
page load.

### Why one callback path and not the current URL

We always ask to come back to `/auth/callback` and stash where the visitor
actually was in `sessionStorage`. One path to allow-list forever beats one per
route across fifty worlds, and a world's URL can carry state that a round trip
through Google would mangle. `takeReturnTo` refuses absolute and
protocol-relative paths (that would be an open redirect) and refuses to bounce
back into the callback itself (that would loop).

### If it misbehaves

| What you see | What it is |
| --- | --- |
| Toast: "That sign-in provider is not switched on for this project yet" | Step 2 has not been done. |
| Google says `redirect_uri_mismatch` | Step 1.4 — the Supabase callback URL is missing or has a typo. |
| Signs in but lands on production from a preview | Step 2.2 — that origin is not in Redirect URLs. |
| Back at the lobby, still signed out, no toast | The token never arrived. Check the browser console on `/auth/callback`. |
| Always signs in as the same Google account | That is `prompt: "select_account"` being ignored by an SSO-managed account, not a bug here. |

---

## Adding another provider later

Apple and Discord are the same shape and need no new code beyond a button:
widen `OAuthProvider` in `src/lib/oauth.ts`, call `signInWithProvider`, and use
the same `/auth/callback` and the same allow list. Everything except the
`prompt: "select_account"` line is already provider-agnostic.

What is *not* free is step 1 — every provider needs its own console, its own
client ID and secret, and its own copy of the Supabase callback URL in its
redirect list.
