# The Vibe Times

A new issue every morning from 13:00 UTC, written by an edge function, read at
[`/times`](https://myvibeverse.com/times).

The paper used to be written by hand. That is why issue №1 shipped in July and
sat on the front door into August under a masthead claiming it was written
nightly. The presses run themselves now.

## What writes it

`supabase/functions/vibe-times/index.ts`, poked by a pg_cron job
(`vibe-times-daily`) every hour from 13:00 to 20:00 UTC. One issue per
calendar day, stored as a row in `public.vibe_times_issues`.

The hourly schedule is not eight editions, it is one edition and seven
chances to notice it did not get written. A poke arriving after today's issue
exists costs a single indexed row read and returns `{skipped: true}`, so the
cheap thing is to keep asking. What it buys: a failed run, an OpenRouter
blip, or a killed invocation costs an hour rather than a day. A run that dies
without cleaning up leaves a `writing` claim behind, and any poke twenty
minutes later takes that claim over rather than politely standing down.

## Is it working?

```sql
-- did the cron fire, and did it succeed?
select status, start_time, return_message from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'vibe-times-daily')
order by start_time desc limit 10;

-- one row per day, all published, note says what each was written from
select issue, edition_date, status, note, published_at
from public.vibe_times_issues order by issue desc limit 7;
```

A `note` reading `build-log.json (missing)` means the site had not deployed
`/build-log.json` when that issue was written, so it went out without the
build record. A gap in `edition_date` means a day genuinely got skipped.

It reads three worlds and hands all of it to Claude Sonnet as **data**:

| | Where it comes from |
|---|---|
| **The build record** | `public/build-log.json` — this repo's commit log, published with the site by `tools/build-log.mjs` (which runs as `prebuild`, so every deploy refreshes it). The repo is private, so the GitHub API is closed to the function unless `VIBE_TIMES_GITHUB_TOKEN` is set, in which case it prefers that and gets the log live. |
| **The world itself** | Supabase: `world_events` (who arrived, who walked up to whom), `world_agents`, `world_graffiti`, the VIBE ledger and drops, games played, the price, and Vibey's overnight journal entries. Names and counts only — never message bodies, never wallet addresses. |
| **Outside the sky** | The actual internet, from open feeds with no API keys: ten RSS/Atom feeds (AI, tech, sports, culture), Hacker News' front page, ESPN's scoreboards for six leagues, and Wikipedia's "on this day". |

## What keeps it honest

A newspaper written by a language model has one obvious failure mode, so:

- **In-world claims** must trace to a commit or a logged event. The prompt
  says so; the brief is the only material it gets.
- **Every wire item must carry the url of a headline the function actually
  fetched.** Any dispatch whose link is not in that set is dropped before the
  issue is stored — on the first run that caught one invented link.
- **The stats block is computed in the function**, never written by the model,
  so the numbers are arithmetic.
- **The forecast is the one section allowed to invent**, and it says so on the
  page.
- Yesterday's wire urls are filtered out of today's brief, so the paper cannot
  run the same story twice.

## Reading it

`src/lib/vibeTimes.ts` is the one loader. It asks the function for the current
issue plus back issues, and falls back to the committed `public/vibe-times.json`
if the presses are unreachable — the `/times` page, the front-door strip
(`TodaysPaper`) and the newsstand in the plaza all go through it. The page
works out the age of the issue itself and says so rather than passing a
week-old front page off as today's.

## Poking it by hand

```bash
# read
curl https://efdqqnubowgwsnwvlalp.supabase.co/functions/v1/vibe-times

# write today's issue if it isn't written (safe to call repeatedly — the day
# is claimed with a unique constraint before the model is called)
curl -X POST https://efdqqnubowgwsnwvlalp.supabase.co/functions/v1/vibe-times

# rewrite today's, service-role key only
curl -X POST -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  "https://efdqqnubowgwsnwvlalp.supabase.co/functions/v1/vibe-times?force=1"
```

`tools/vibe-times-brief.mjs` still exists and still works: it prints the same
kind of brief from a local checkout, for writing an issue by hand.
