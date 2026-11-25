begin;

create policy tracker_owner_build_plans on public.vercel_migration_tracker as restrictive
for all to authenticated
using (kind <> 'plan' or lower(coalesce((select auth.jwt())->>'email', '')) = 'sgray@commure.com')
with check (kind <> 'plan' or lower(coalesce((select auth.jwt())->>'email', '')) = 'sgray@commure.com');

insert into public.vercel_migration_tracker
  (tool_key, kind, entry_key, title, area, status, readiness_group)
select tool, 'launch', 'launch-complete-punch-lists', 'Complete punch lists', 'Punch list', 'Open',
  '642a31a7-6544-4057-8f60-ab210a68ae10'::uuid
from unnest(array['px', 'customer-ops', 'launch', 'efficiency', 'capacity']) as tool
on conflict (tool_key, entry_key) do nothing;

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
    visible.page, e.action, coalesce(o.outcome, e.outcome), e.entry_id
  from tooling_tracker_private.test_events e
  left join tooling_tracker_private.test_outcomes o using (event_key)
  left join public.vercel_migration_tracker test on test.id = e.entry_id
  left join public.vercel_migration_tracker parent on parent.id = test.parent_id
  cross join lateral (
    select case when parent.kind = 'plan' and lower(coalesce(auth.jwt()->>'email', '')) <> 'sgray@commure.com'
      then coalesce(test.area, 'Test case') else e.page end as page
  ) visible
  where e.occurred_at is not null and e.source <> 'Tooling Tracker'
    and (selected_tool is null or e.tool_key = selected_tool)
    and (outcome_filter is null or coalesce(o.outcome, e.outcome) = outcome_filter)
    and (before_time is null or (e.occurred_at,e.event_key) < (before_time,before_key))
    and (coalesce(search_text,'') = '' or strpos(lower(concat_ws(' ', e.actor, visible.page, e.action, e.source, e.session_id)), lower(left(search_text,160))) > 0)
  order by e.occurred_at desc, e.event_key desc
  limit greatest(1,least(coalesce(page_size,50),101));
end;
$$;

create or replace function tooling_tracker_private.testing_totals()
returns table (group_key text, testers bigint, actions bigint)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') <> 'admin' then
    raise exception 'Usage activity requires Admin access' using errcode = '42501';
  end if;
  return query
    select coalesce(e.tool_key,'workspace'), count(distinct nullif(lower(trim(e.actor_key)),'')), count(*)
    from tooling_tracker_private.test_events e where e.occurred_at is not null and e.source <> 'Tooling Tracker'
    group by coalesce(e.tool_key,'workspace');
end;
$$;

commit;
