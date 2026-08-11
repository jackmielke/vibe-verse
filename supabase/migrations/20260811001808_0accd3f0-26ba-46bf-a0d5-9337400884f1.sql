insert into public.vibe_portal_games (slug, title, tagline, author, author_url, embed_url, origin, max_award, session_budget, player_daily, daily_budget, active, note)
values (
  'blob-battle',
  'Blob Battle',
  'Eat, grow, split — last blob standing.',
  'Vibeverse community',
  'https://bloom-battle-royale.lovable.app',
  'https://bloom-battle-royale.lovable.app/embed',
  'https://bloom-battle-royale.lovable.app',
  25, 80, 150, 2000,
  true,
  'Hosted elsewhere; framed where it stands. Added by request.'
)
on conflict (slug) do update set
  title = excluded.title,
  tagline = excluded.tagline,
  embed_url = excluded.embed_url,
  origin = excluded.origin,
  active = true;