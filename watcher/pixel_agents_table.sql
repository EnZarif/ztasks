-- Run this once in the Supabase SQL editor for your central-hub project
-- (https://supabase.com/dashboard/project/qwceyzswwtyqiozxnlah/sql/new)

create table if not exists pixel_agents (
  session_id text primary key,
  project_path text,
  status text not null default 'idle',
  last_tool text,
  character_index int not null default 0,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pixel_agents enable row level security;

-- Mirrors the permissive anon-key access already used by hub_data
create policy "anon full access" on pixel_agents
  for all
  using (true)
  with check (true);
