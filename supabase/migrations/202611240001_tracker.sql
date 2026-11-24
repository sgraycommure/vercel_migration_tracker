begin;

create table if not exists public.vercel_migration_tracker (
  id uuid primary key default gen_random_uuid()
);

alter table public.vercel_migration_tracker
  add column tool_key text not null check (tool_key in ('px', 'customer-ops', 'launch', 'efficiency', 'capacity')),
  add column kind text not null check (kind in ('tool', 'feature', 'metric', 'feedback', 'plan', 'test')),
  add column entry_key text,
  add column title text not null check (length(trim(title)) between 1 and 160),
  add column area text check (length(area) <= 80),
  add column details text not null default '' check (length(details) <= 5000),
  add column status text not null,
  add column owner text check (length(owner) <= 160),
  add column due_date date,
  add column environment text check (environment in ('Preview', 'Production', 'Local')),
  add column deployment_url text check (length(deployment_url) <= 1000 and deployment_url like 'https://%'),
  add column source_url text check (length(source_url) <= 1000 and source_url like 'https://%'),
  add column parent_id uuid,
  add column created_by uuid default auth.uid(),
  add column actor_email text default lower(auth.jwt()->>'email'),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint tracker_tool_id_unique unique (tool_key, id),
  add constraint tracker_parent_tool foreign key (tool_key, parent_id)
    references public.vercel_migration_tracker (tool_key, id),
  add constraint tracker_entry_key_unique unique (tool_key, entry_key),
  add constraint tracker_status check (
    (kind in ('tool', 'feature', 'metric') and status in ('Implemented', 'Needs verification', 'Data gap', 'Removed', 'Planned')) or
    (kind = 'feedback' and status in ('New', 'Triaged', 'Resolved')) or
    (kind = 'plan' and status in ('Backlog', 'Planned', 'In progress', 'Ready for testing', 'Shipped')) or
    (kind = 'test' and status in ('Started', 'Passed', 'Failed', 'Blocked'))
  ),
  add constraint tracker_test_environment check ((kind = 'test') = (environment is not null));

create unique index tracker_one_tool on public.vercel_migration_tracker (tool_key) where kind = 'tool';
create index tracker_tool_kind_time on public.vercel_migration_tracker (tool_key, kind, created_at desc);
alter table public.vercel_migration_tracker enable row level security;

create schema if not exists tooling_tracker_private;
revoke all on schema tooling_tracker_private from public;
grant usage on schema tooling_tracker_private to authenticated;

create function tooling_tracker_private.workspace_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce(u.access_role::text, 'User')
  from auth.users a
  join public.ent_ops_users u on lower(trim(u.email)) = lower(a.email)
  where a.id = auth.uid() and a.email_confirmed_at is not null and u.active is true
    and lower(a.email) = lower(auth.jwt()->>'email')
    and lower(a.email) ~ '^[^@]+@commure[.]com$'
  order by case lower(coalesce(u.access_role::text, 'User')) when 'admin' then 0 when 'exec' then 1 else 2 end
  limit 1
$$;

revoke execute on function tooling_tracker_private.workspace_role() from public, anon;
grant execute on function tooling_tracker_private.workspace_role() to authenticated;

revoke all on table public.vercel_migration_tracker from public, anon, authenticated;
grant select on table public.vercel_migration_tracker to authenticated;
grant insert (tool_key, kind, title, area, details, status, owner, due_date, environment, deployment_url, source_url, parent_id)
  on public.vercel_migration_tracker to authenticated;
grant update (title, area, details, status, owner, due_date, deployment_url, source_url, parent_id)
  on public.vercel_migration_tracker to authenticated;

create policy tracker_read on public.vercel_migration_tracker for select to authenticated
  using ((select tooling_tracker_private.workspace_role()) is not null);

create policy tracker_add on public.vercel_migration_tracker for insert to authenticated
  with check (
    (select tooling_tracker_private.workspace_role()) is not null
    and created_by = (select auth.uid())
    and (
      kind in ('feedback', 'plan', 'test')
      or (kind in ('feature', 'metric') and lower((select tooling_tracker_private.workspace_role())) in ('admin','exec'))
    )
  );

create policy tracker_update on public.vercel_migration_tracker for update to authenticated
  using (
    kind <> 'test' and (select tooling_tracker_private.workspace_role()) is not null and (
      lower((select tooling_tracker_private.workspace_role())) in ('admin','exec')
      or (kind in ('feedback','plan') and created_by = (select auth.uid()))
    )
  )
  with check (
    kind <> 'test' and (select tooling_tracker_private.workspace_role()) is not null and (
      lower((select tooling_tracker_private.workspace_role())) in ('admin','exec')
      or (kind in ('feedback','plan') and created_by = (select auth.uid()))
    )
  );

create function tooling_tracker_private.touch_entry()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tracker_touch before update on public.vercel_migration_tracker
  for each row execute function tooling_tracker_private.touch_entry();

create function public.vercel_migration_tracker_access()
returns text
language sql stable security invoker
set search_path = ''
as $$ select tooling_tracker_private.workspace_role() $$;

revoke execute on function public.vercel_migration_tracker_access() from public, anon;
grant execute on function public.vercel_migration_tracker_access() to authenticated;

commit;
