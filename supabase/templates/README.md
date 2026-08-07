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

## If you change the dialog

If sign-in ever stops offering a code box, this template can go back to being a
link alone. Until then, `{{ .Token }}` is load-bearing.
