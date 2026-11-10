-- Box Dokkan : une ligne par utilisateur, la box entière en JSON
-- { "<id carte>": { "count": 2, "linkLv": 7, "saLv": 12 }, ... }
create table if not exists public.dokkan_box (
  user_id uuid primary key references auth.users (id) on delete cascade,
  box jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.dokkan_box enable row level security;

create policy "box : lecture perso" on public.dokkan_box
  for select using (auth.uid() = user_id);
create policy "box : création perso" on public.dokkan_box
  for insert with check (auth.uid() = user_id);
create policy "box : modification perso" on public.dokkan_box
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
