begin;

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
  with events(event_key, occurred_at, tool_key, source, actor, session_id, environment, page, action, outcome, entry_id) as (
    select 'tracker:' || a.id, a.occurred_at, a.tool_key, 'Tooling Tracker', a.actor, a.session_id::text, a.environment,
      a.page, a.action, a.outcome, null::uuid
    from tooling_tracker_private.testing_activity a
    union all
    select 'manual:' || t.id, t.created_at, t.tool_key, 'Manual test', t.actor_email, null, t.environment,
      coalesce(parent.title, t.area, 'Test case'), t.title, t.status, t.id
    from public.vercel_migration_tracker t left join public.vercel_migration_tracker parent on parent.id = t.parent_id
    where t.kind = 'test'
    union all
    select 'view:' || v.usage_id, v.visited_at,
      case v.app_name when 'CS Hub (Vercel)' then 'customer-ops' else 'launch' end, 'Vercel usage',
      coalesce(nullif(v.user_name,''), v.user_email), v.session_id, null, coalesce(nullif(v.tab_key,''), 'Application'),
      case v.event_type when 'app_open' then 'Open application' when 'tab_view' then 'View tab' else coalesce(v.event_type, 'Usage event') end,
      case when v.event_type in ('app_open','tab_view') then 'Viewed' else 'Not recorded' end, null
    from public.ent_ops_app_usage v
    where v.app_name in ('CS Hub (Vercel)','Enterprise Launch Tracker (Vercel)')
    union all
    select 'click:' || c.id, coalesce(c.event_at,c.created_at),
      case c.app_name when 'CS Hub (Vercel)' then 'customer-ops' else 'launch' end, 'Vercel usage',
      coalesce(nullif(c.user_name,''), c.user_email), null, null,
      case when strpos(c.component_id, ': ') > 0 then split_part(c.component_id, ': ', 1) else 'Application' end,
      case when c.component_type in ('link','link_button') then 'Open ' || c.component_type
        else coalesce(nullif(case when strpos(c.component_id, ': ') > 0 then substr(c.component_id, strpos(c.component_id, ': ') + 2) else c.component_id end,''), c.event_type) end,
      'Not recorded', null
    from public.ent_ops_activity_logs c
    where c.app_name in ('CS Hub (Vercel)','Enterprise Launch Tracker (Vercel)') and c.event_type is not null
    union all
    select 'efficiency:' || e.id, e.occurred_at, 'efficiency', 'Vercel usage',
      coalesce(nullif(e.user_name,''), e.user_email), e.session_id::text, initcap(e.environment), e.page,
      coalesce(nullif(e.label,''),e.kind), case when e.kind in ('session','session_start','page_view','view') then 'Viewed' else 'Not recorded' end, null
    from public.efficiency_usage_events e
    union all
    select 'audit:' || h.id, h.created_at, 'efficiency', 'Efficiency Log audit',
      a.email, null, null, coalesce(initcap(replace(h.record_type,'_',' ')),'Application'),
      initcap(replace(h.action,'_',' ')), 'Succeeded', null
    from public.efficiency_audit_events h left join auth.users a on a.id = h.actor_id
  )
  select e.* from events e
  where e.occurred_at is not null and (selected_tool is null or e.tool_key = selected_tool or (selected_tool = 'tracker' and e.source = 'Tooling Tracker'))
    and (outcome_filter is null or e.outcome = outcome_filter)
    and (before_time is null or (e.occurred_at,e.event_key) < (before_time,before_key))
    and (coalesce(search_text,'') = '' or strpos(lower(concat_ws(' ',e.actor,e.page,e.action,e.source,e.session_id)), lower(left(search_text,160))) > 0)
  order by e.occurred_at desc, e.event_key desc
  limit greatest(1,least(coalesce(page_size,50),101));
end;
$$;

create or replace function public.vercel_migration_tracker_testing_feed(
  selected_tool text, search_text text, outcome_filter text, before_time timestamptz, before_key text, page_size int
)
returns table (event_key text, occurred_at timestamptz, tool_key text, source text, actor text,
  session_id text, environment text, page text, action text, outcome text, entry_id uuid)
language sql stable security invoker set search_path = ''
as $$ select * from tooling_tracker_private.testing_feed(selected_tool,search_text,outcome_filter,before_time,before_key,page_size) $$;

revoke execute on function tooling_tracker_private.testing_feed(text,text,text,timestamptz,text,int),
  public.vercel_migration_tracker_testing_feed(text,text,text,timestamptz,text,int) from public, anon, authenticated;
grant execute on function tooling_tracker_private.testing_feed(text,text,text,timestamptz,text,int),
  public.vercel_migration_tracker_testing_feed(text,text,text,timestamptz,text,int) to authenticated;

commit;
