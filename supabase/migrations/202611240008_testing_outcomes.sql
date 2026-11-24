begin;

create view tooling_tracker_private.test_events
  (event_key, occurred_at, tool_key, source, actor, session_id, environment, page, action, outcome, entry_id, actor_key)
as
    select 'tracker:' || a.id, a.occurred_at, a.tool_key, 'Tooling Tracker', a.actor, a.session_id::text, a.environment,
      a.page, a.action, a.outcome, null::uuid, a.actor
    from tooling_tracker_private.testing_activity a
    union all
    select 'manual:' || t.id, t.created_at, t.tool_key, 'Manual test', t.actor_email, null, t.environment,
      coalesce(parent.title, t.area, 'Test case'), t.title, t.status, t.id, t.actor_email
    from public.vercel_migration_tracker t left join public.vercel_migration_tracker parent on parent.id = t.parent_id
    where t.kind = 'test'
    union all
    select 'view:' || v.usage_id, v.visited_at,
      case v.app_name when 'CS Hub (Vercel)' then 'customer-ops' else 'launch' end, 'Vercel usage',
      coalesce(nullif(v.user_name,''), v.user_email), v.session_id, null, coalesce(nullif(v.tab_key,''), 'Application'),
      case v.event_type when 'app_open' then 'Open application' when 'tab_view' then 'View tab' else coalesce(v.event_type, 'Usage event') end,
      case when v.event_type in ('app_open','tab_view') then 'Viewed' else 'Not recorded' end, null, coalesce(nullif(v.user_email,''), v.user_name)
    from public.ent_ops_app_usage v
    where v.app_name in ('CS Hub (Vercel)','Enterprise Launch Tracker (Vercel)')
    union all
    select 'click:' || c.id, coalesce(c.event_at,c.created_at),
      case c.app_name when 'CS Hub (Vercel)' then 'customer-ops' else 'launch' end, 'Vercel usage',
      coalesce(nullif(c.user_name,''), c.user_email), null, null,
      case when strpos(c.component_id, ': ') > 0 then split_part(c.component_id, ': ', 1) else 'Application' end,
      case when c.component_type in ('link','link_button') then 'Open ' || c.component_type
        else coalesce(nullif(case when strpos(c.component_id, ': ') > 0 then substr(c.component_id, strpos(c.component_id, ': ') + 2) else c.component_id end,''), c.event_type) end,
      'Not recorded', null, coalesce(nullif(c.user_email,''), c.user_name)
    from public.ent_ops_activity_logs c
    where c.app_name in ('CS Hub (Vercel)','Enterprise Launch Tracker (Vercel)') and c.event_type is not null
    union all
    select 'efficiency:' || e.id, e.occurred_at, 'efficiency', 'Vercel usage',
      coalesce(nullif(e.user_name,''), e.user_email), e.session_id::text, initcap(e.environment), e.page,
      coalesce(nullif(e.label,''),e.kind), case when e.kind in ('session','session_start','page_view','view') then 'Viewed' else 'Not recorded' end, null, coalesce(nullif(e.user_email,''), e.user_name)
    from public.efficiency_usage_events e
    union all
    select 'audit:' || h.id, h.created_at, 'efficiency', 'Efficiency Log audit',
      a.email, null, null, coalesce(initcap(replace(h.record_type,'_',' ')),'Application'),
      initcap(replace(h.action,'_',' ')), 'Succeeded', null, a.email
    from public.efficiency_audit_events h left join auth.users a on a.id = h.actor_id;
revoke all on tooling_tracker_private.test_events from public, anon, authenticated;

create table tooling_tracker_private.test_outcomes (
  event_key text primary key,
  outcome text not null check (outcome in ('Passed', 'Failed', 'Blocked', 'Started')),
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table tooling_tracker_private.test_outcomes enable row level security;
revoke all on tooling_tracker_private.test_outcomes from public, anon, authenticated;

create or replace function tooling_tracker_private.testing_feed(
  selected_tool text, search_text text, outcome_filter text, before_time timestamptz, before_key text, page_size int
)
returns table (event_key text, occurred_at timestamptz, tool_key text, source text, actor text,
  session_id text, environment text, page text, action text, outcome text, entry_id uuid)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') <> 'admin' then
    raise exception 'Usage activity requires Admin access' using errcode = '42501';
  end if;
  return query
  select e.event_key, e.occurred_at, e.tool_key, e.source, e.actor, e.session_id, e.environment,
    e.page, e.action, coalesce(o.outcome, e.outcome), e.entry_id
  from tooling_tracker_private.test_events e
  left join tooling_tracker_private.test_outcomes o using (event_key)
  where e.occurred_at is not null and (selected_tool is null or e.tool_key = selected_tool or (selected_tool = 'tracker' and e.source = 'Tooling Tracker') or (selected_tool = 'workspace' and e.tool_key is null and e.source = 'Tooling Tracker'))
    and (outcome_filter is null or coalesce(o.outcome, e.outcome) = outcome_filter)
    and (before_time is null or (e.occurred_at,e.event_key) < (before_time,before_key))
    and (coalesce(search_text,'') = '' or strpos(lower(concat_ws(' ',e.actor,e.page,e.action,e.source,e.session_id)), lower(left(search_text,160))) > 0)
  order by e.occurred_at desc, e.event_key desc
  limit greatest(1,least(coalesce(page_size,50),101));
end;
$$;


create function tooling_tracker_private.set_test_outcome(test_event text, new_outcome text, expected_outcome text)
returns text language plpgsql security definer set search_path = ''
as $$
declare original text;
declare current_outcome text;
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') <> 'admin' then
    raise exception 'Testing outcomes require Admin access' using errcode = '42501';
  end if;
  if test_event is null or char_length(test_event) > 100
    or (new_outcome is not null and new_outcome not in ('Passed','Failed','Blocked','Started')) then
    raise exception 'Invalid testing outcome';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tracker-outcome:' || test_event, 0));
  select e.outcome, coalesce(o.outcome,e.outcome) into original,current_outcome
    from tooling_tracker_private.test_events e left join tooling_tracker_private.test_outcomes o using (event_key)
    where e.event_key = test_event and e.occurred_at is not null;
  if not found then raise exception 'Testing event no longer exists'; end if;
  if current_outcome is distinct from expected_outcome then
    raise exception 'Testing outcome changed since it was loaded' using errcode = '40001';
  end if;
  if new_outcome is null then
    delete from tooling_tracker_private.test_outcomes where event_key = test_event;
  else
    insert into tooling_tracker_private.test_outcomes (event_key,outcome,updated_by)
      values (test_event,new_outcome,auth.uid())
      on conflict (event_key) do update set outcome=excluded.outcome, updated_by=excluded.updated_by, updated_at=clock_timestamp();
  end if;
  return coalesce(new_outcome,original);
end;
$$;

create function tooling_tracker_private.testing_totals()
returns table (group_key text, testers bigint, actions bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') <> 'admin' then
    raise exception 'Usage activity requires Admin access' using errcode = '42501';
  end if;
  return query
    select coalesce(e.tool_key,'workspace'), count(distinct nullif(lower(trim(e.actor_key)),'')), count(*)
    from tooling_tracker_private.test_events e where e.occurred_at is not null
    group by coalesce(e.tool_key,'workspace');
end;
$$;

create function public.vercel_migration_tracker_set_outcome(test_event text, new_outcome text, expected_outcome text)
returns text language sql security invoker set search_path = ''
as $$ select tooling_tracker_private.set_test_outcome(test_event,new_outcome,expected_outcome) $$;

create function public.vercel_migration_tracker_testing_totals()
returns table (group_key text, testers bigint, actions bigint)
language sql stable security invoker set search_path = ''
as $$ select * from tooling_tracker_private.testing_totals() $$;

revoke execute on function tooling_tracker_private.set_test_outcome(text,text,text),
  tooling_tracker_private.testing_totals(), public.vercel_migration_tracker_set_outcome(text,text,text),
  public.vercel_migration_tracker_testing_totals() from public, anon, authenticated;
grant execute on function tooling_tracker_private.set_test_outcome(text,text,text),
  tooling_tracker_private.testing_totals(), public.vercel_migration_tracker_set_outcome(text,text,text),
  public.vercel_migration_tracker_testing_totals() to authenticated;

insert into public.vercel_migration_tracker (tool_key,kind,entry_key,title,area,details,status)
select tool.tool_key,'launch',item.key,item.title,'Punch list',item.details,'Open'
from (values ('px'),('customer-ops'),('launch'),('efficiency'),('capacity')) as tool(tool_key)
cross join (values
  ('launch-remove-tests','Remove test records before rollout','Identify and review temporary projects, entries, and other test records. Obtain approval for the cleanup, then verify the affected dashboards and reports.'),
  ('launch-data-cleanup','Complete data cleanup before rollout','Resolve or assign data gaps, duplicates, and orphaned records. Reconcile cleaned records and report totals with the source.'),
  ('launch-user-documentation','Create and publish user guides','Document key workflows, roles, reporting definitions, and how to get help. Review the guides with tool owners and link them from the launch communications.')
) as item(key,title,details)
on conflict (tool_key,entry_key) do nothing;

commit;
