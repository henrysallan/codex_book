-- Graph layout: one row per user. Positions are regenerated whenever the
-- topology (nodes + backlinks + containment) changes; there is no manual
-- graph editing. Run this in the Supabase SQL editor.

create table if not exists graph_layouts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  topology_hash text not null,
  positions jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone default now()
);

create trigger graph_layouts_updated_at
  before update on graph_layouts
  for each row execute function update_updated_at();

alter table graph_layouts enable row level security;

create policy "Users can view own graph layout"
  on graph_layouts for select
  using (auth.uid() = user_id);

create policy "Users can insert own graph layout"
  on graph_layouts for insert
  with check (auth.uid() = user_id);

create policy "Users can update own graph layout"
  on graph_layouts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own graph layout"
  on graph_layouts for delete
  using (auth.uid() = user_id);
