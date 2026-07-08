# Getting the 6-digit code into the sign-in email

The `/start` onboarding (and the Vibe login dialog) already speak both
languages: they listen for the magic-link session **and** accept a typed
6-digit code (`supabase.auth.verifyOtp`). The only missing piece is the
email itself — Supabase's default **Magic Link** template only contains
the link (`{{ .ConfirmationURL }}`), so no code ever reaches the inbox.

This is hosted-project config, not code — it can't be changed from the
repo. It's a one-time paste in the dashboard:

## The one-time fix (~1 minute)

1. Open the Supabase dashboard → project `efdqqnubowgwsnwvlalp`
   → **Authentication → Email Templates → Magic Link**
   (direct link: https://supabase.com/dashboard/project/efdqqnubowgwsnwvlalp/auth/templates)
2. Replace the template body with the HTML below (subject suggestion:
   `Your VibeVerse code: {{ .Token }}`).
3. Save. Done — no deploy needed; the next email has the code.

```html
<div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 440px; margin: 0 auto; background: #0d1524; border-radius: 16px; padding: 32px 28px; color: #eafcff;">
  <p style="font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: #7af0ff; margin: 0 0 4px;">every builder grows the universe</p>
  <h1 style="font-size: 26px; letter-spacing: 0.12em; margin: 0 0 18px; color: #ffffff;">VIBEVERSE</h1>
  <p style="font-size: 15px; color: #c9d8e8; margin: 0 0 18px;">Vibey here 🤖 — your sign-in code:</p>
  <p style="font-size: 40px; font-weight: bold; letter-spacing: 0.35em; text-align: center; background: rgba(255,255,255,0.07); border-radius: 12px; padding: 18px 0; margin: 0 0 18px; color: #ffe9b3;">{{ .Token }}</p>
  <p style="font-size: 13px; color: #8fa3b8; margin: 0 0 22px;">Type it on the page you came from. Or take the one-tap door:</p>
  <p style="text-align: center; margin: 0 0 22px;">
    <a href="{{ .ConfirmationURL }}" style="display: inline-block; background: #34d399; color: #052e1e; font-weight: bold; font-size: 15px; text-decoration: none; border-radius: 12px; padding: 13px 30px;">Enter the VibeVerse →</a>
  </p>
  <p style="font-size: 11px; color: #5c6f82; margin: 0;">Didn't ask for this? Just ignore it — nothing happens without the code.</p>
</div>
```

## Why keep both the code AND the link

- The `/start` account step already shows a code input the moment the
  email is sent, and its cross-tab auth listener finishes onboarding if
  the link is tapped instead. Either path lands on the island.
- Corporate/School email scanners sometimes "click" links to inspect
  them, which can consume a magic link before the human sees it. A typed
  code is immune — that's the code-first argument, straight from
  Supabase's own troubleshooting guide.
- `{{ .Token }}` and `{{ .ConfirmationURL }}` are both valid in the same
  template; sending both costs nothing.

## After pasting

Update the copy in `src/pages/StartFlow.tsx` (account step) from
"if your email shows a 6-digit code" to lead with the code — search for
`one-tap sign-in link` — and flip the order of the sent-state hint. The
UI works unchanged either way; this is just wording.
