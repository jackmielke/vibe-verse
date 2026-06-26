
-- VIBE BALANCES
CREATE TABLE public.vibe_balances (
  owner_kind text NOT NULL CHECK (owner_kind IN ('user','agent')),
  owner_ref text NOT NULL,
  balance numeric NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_kind, owner_ref)
);
GRANT SELECT ON public.vibe_balances TO anon, authenticated;
GRANT ALL ON public.vibe_balances TO service_role;
ALTER TABLE public.vibe_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "balances readable by all" ON public.vibe_balances FOR SELECT USING (true);

-- LEDGER
CREATE TABLE public.vibe_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind text, from_ref text,
  to_kind text, to_ref text,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL DEFAULT 'transfer',
  memo text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vibe_ledger_to_idx ON public.vibe_ledger (to_kind, to_ref, created_at DESC);
CREATE INDEX vibe_ledger_from_idx ON public.vibe_ledger (from_kind, from_ref, created_at DESC);
GRANT SELECT ON public.vibe_ledger TO anon, authenticated;
GRANT ALL ON public.vibe_ledger TO service_role;
ALTER TABLE public.vibe_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ledger readable by all" ON public.vibe_ledger FOR SELECT USING (true);

-- AGENT ECONOMY
CREATE TABLE public.agent_economy (
  agent_id uuid PRIMARY KEY REFERENCES public.world_agents(id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'wandering the vibeverse',
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs jsonb NOT NULL DEFAULT '{"energy":1.0,"hunger":1.0,"mood":1.0}'::jsonb,
  asleep boolean NOT NULL DEFAULT false,
  asleep_until timestamptz,
  last_tick timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.agent_economy TO anon, authenticated;
GRANT ALL ON public.agent_economy TO service_role;
ALTER TABLE public.agent_economy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agent_economy readable by all" ON public.agent_economy FOR SELECT USING (true);

-- BOUNTIES
CREATE TABLE public.agent_bounties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.world_agents(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  reward numeric NOT NULL CHECK (reward > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','paid','cancelled')),
  claimed_by_kind text,
  claimed_by_ref text,
  claimed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bounties_status_idx ON public.agent_bounties (status, created_at DESC);
CREATE INDEX bounties_agent_idx ON public.agent_bounties (agent_id);
GRANT SELECT ON public.agent_bounties TO anon, authenticated;
GRANT ALL ON public.agent_bounties TO service_role;
ALTER TABLE public.agent_bounties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bounties readable by all" ON public.agent_bounties FOR SELECT USING (true);

-- INVENTORY
CREATE TABLE public.vibe_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL,
  owner_ref text NOT NULL,
  item_key text NOT NULL,
  item_title text NOT NULL,
  cosmetic_key text,
  source_agent_id uuid REFERENCES public.world_agents(id) ON DELETE SET NULL,
  acquired_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_owner_idx ON public.vibe_inventory (owner_kind, owner_ref);
GRANT SELECT ON public.vibe_inventory TO anon, authenticated;
GRANT ALL ON public.vibe_inventory TO service_role;
ALTER TABLE public.vibe_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "inventory readable by all" ON public.vibe_inventory FOR SELECT USING (true);

-- Realtime so balances + bounties update live
ALTER PUBLICATION supabase_realtime ADD TABLE public.vibe_balances;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vibe_ledger;
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_bounties;
