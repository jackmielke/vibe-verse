# Auth email templates

Supabase serves these from **project configuration**, not from this repo. There
is no build step and no deploy — a file here is a record of what should be
pasted into the dashboard, not something that takes effect by being committed.

They are kept under version control anyway because the failure they prevent is
invisible from the code. `VibeAuthDialog` calls `signInWithOtp` and then offers
a six-digit box wired to `verifyOtp({ type: "email" })`. That is the good flow —
you stay in the tab you started in, which matters most on a phone. But the stock
Supabase Magic Link template renders only `{{ .ConfirmationURL }}`. With that
template the app asks for a code and the email contains none, and nothing in the
codebase looks wrong.

## Applying one

Dashboard → **Authentication → Emails** → pick the template → paste → Save.

| File | Template | Must contain |
|---|---|---|
| `magic-link.html` | Magic Link | `{{ .Token }}` — this is the six-digit code |

`{{ .ConfirmationURL }}` is kept alongside it so the link still works for anyone
who prefers to tap. Either path signs you in; they are the same OTP.

---

## The subject line is a separate field, and it matters more than the body

Set the Magic Link **Subject** to:

```
{{ .Token }} is your Vibeverse code
```

The code first, because a phone notification banner truncates the end. With
this, the code is readable from the lock screen and from the inbox list — most
sign-ins never open the email at all, which is the actual goal. The hidden
preheader at the top of `magic-link.html` puts it in the inbox preview line too,
so both halves of that row carry it.

Putting a one-time code in a subject line is a deliberate, and normal, trade: it
is visible to anything that can see notification text. It expires in an hour,
works once, and only ever grants access to the account it was sent to.

## Why the body is laid out the way it is

iOS 17+ and macOS Sonoma+ detect verification codes in Mail and offer them above
the keyboard for any input marked `autocomplete="one-time-code"` — which
`VibeAuthDialog` already sets, and which is also why the code box is **one input
and not six**. Six separate single-character boxes look nice and defeat autofill
entirely.

Apple has never documented the heuristics for *email* codes (only the SMS
`@domain #code` format), so the template just looks like every other
verification email: the words "verification code" directly above a short run of
digits, near the top. Reported behaviour is a 10–15 second delay before the
suggestion appears, and it is Apple-only — Chrome and Android have no equivalent
for email codes, which is the other reason the subject line carries its weight.

One rule when editing: **never put spaces between the digits.** The wide look
comes from CSS `letter-spacing`, which leaves the text as six contiguous
characters. `123456` parses; `1 2 3 4 5 6` does not.

---

## Custom SMTP is not optional for an event

Two things follow from Supabase's built-in email service, and the second one
will stop a party dead:

1. **You cannot change the sender name or address.** Mail arrives from
   Supabase's own domain. "From: The Vibeverse" needs your own SMTP.
2. **It is rate limited to 2 messages per hour, per project.** Not per user —
   for everything. Invite ten friends on the same evening and the third person
   to try signing in gets `429: email rate limit exceeded` and simply cannot
   get in.

Both are fixed by the same change: **Authentication → Emails → SMTP Settings**,
point it at a real sender (Resend, Postmark, SES — free tiers cover this
comfortably), and set the sender name to `The Vibeverse`. Then raise the cap
under **Authentication → Rate Limits**, which defaults to 30 new users an hour
on custom SMTP and is adjustable.

Send from a domain you have authenticated (SPF/DKIM). A free Gmail address in
the From field is the fastest route to the spam folder, which is a worse failure
than the rate limit because nobody reports it — they just never arrive.
