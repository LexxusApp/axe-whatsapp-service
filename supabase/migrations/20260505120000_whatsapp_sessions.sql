-- Tabela usada pelo axe-whatsapp-service (Railway) para persistir o estado Baileys (multi-file virtual em JSON).
-- Aplicação no Dashboard: SQL Editor > New query > colar e Run.

create table if not exists public.whatsapp_sessions (
  tenant_id text primary key,
  session_files jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_sessions_updated_at_idx on public.whatsapp_sessions (updated_at desc);

comment on table public.whatsapp_sessions is 'Blob JSON dos arquivos virtuais creds/pre-keys etc. do Baileys por tenant.';

alter table public.whatsapp_sessions enable row level security;

-- Com SUPABASE_SERVICE_ROLE_KEY o PostgREST ignora RLS (uso típico neste serviço).
-- Sem policies para anon/authenticated = cliente público não lê nem escreve esta tabela.
-- Se algum dia usar anon key no servidor, crie policies explícitas para INSERT/SELECT/Upsert.
