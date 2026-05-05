-- Tabela usada pelo axe-whatsapp-service (Railway) para persistir o estado Baileys (multi-file virtual em JSON).
-- Aplicação no Dashboard: SQL Editor > New query > colar e Run.

create table if not exists public.whatsapp_sessions (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_sessions_updated_at_idx on public.whatsapp_sessions (updated_at desc);

comment on table public.whatsapp_sessions is 'id = tenant_id; data = JSON dos arquivos virtuais Baileys (creds/pre-keys).';
comment on column public.whatsapp_sessions.id is 'UUID do tenant (Supabase).';
comment on column public.whatsapp_sessions.data is 'Mapa nome-arquivo -> conteúdo (BufferJSON), espelho do useMultiFileAuthState.';

-- Se você criou a versão antiga com tenant_id/session_files, renomeie antes de usar este app:
-- alter table public.whatsapp_sessions rename column tenant_id to id;
-- alter table public.whatsapp_sessions rename column session_files to data;

alter table public.whatsapp_sessions enable row level security;

-- Com SUPABASE_SERVICE_ROLE_KEY o PostgREST ignora RLS (uso típico neste serviço).
-- Sem policies para anon/authenticated = cliente público não lê nem escreve esta tabela.
-- Se algum dia usar anon key no servidor, crie policies explícitas para INSERT/SELECT/Upsert.
