begin;

alter table public.vercel_migration_tracker
  add column readiness_group uuid,
  add column readiness_overview_order bigint,
  add column readiness_tool_order bigint,
  add constraint tracker_readiness_fields check (kind = 'launch' or
    (readiness_group is null and readiness_overview_order is null and readiness_tool_order is null));

-- Seeded tasks have stable keys. Training workshops are specific to each tool.
-- For manually entered tasks, link unambiguous matches by category and title.
with candidates as (
  select id, tool_key, case
    when entry_key is not null and entry_key <> 'launch-check-training' then jsonb_build_array('seed', entry_key)
    when entry_key is null then jsonb_build_array('manual', area, lower(trim(title)))
  end as match_key
  from public.vercel_migration_tracker where kind = 'launch'
), groups as (
  select match_key, gen_random_uuid() as group_id
  from candidates where match_key is not null
  group by match_key having count(*) > 1 and count(*) = count(distinct tool_key)
)
update public.vercel_migration_tracker as item set readiness_group = groups.group_id
from candidates join groups using (match_key) where item.id = candidates.id;

create unique index tracker_readiness_group_tool
  on public.vercel_migration_tracker (readiness_group, tool_key) where readiness_group is not null;

grant insert (readiness_group), update (readiness_overview_order, readiness_tool_order)
  on public.vercel_migration_tracker to authenticated;

create function public.vercel_migration_tracker_edit_readiness(
  item_key uuid, versions jsonb, changes jsonb
) returns setof public.vercel_migration_tracker
language plpgsql security invoker set search_path = '' as $$
declare
  affected integer;
  expected integer;
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin', 'exec') then
    raise insufficient_privilege;
  end if;

  select count(*) into expected from jsonb_object_keys(versions);
  return query
  update public.vercel_migration_tracker as item
  set title = case when changes ? 'title' then changes->>'title' else item.title end,
      area = case when changes ? 'area' then changes->>'area' else item.area end,
      status = case when changes ? 'status' then changes->>'status' else item.status end,
      details = case when changes ? 'details' then changes->>'details' else item.details end,
      owner = case when changes ? 'owner' then changes->>'owner' else item.owner end,
      due_date = case when changes ? 'due_date' then (changes->>'due_date')::date else item.due_date end,
      deployment_url = case when changes ? 'deployment_url' then changes->>'deployment_url' else item.deployment_url end
  where item.kind = 'launch' and coalesce(item.readiness_group, item.id) = item_key
    and item.updated_at = (versions->>item.id::text)::timestamptz
  returning item.*;

  get diagnostics affected = row_count;
  if affected = 0 or affected <> expected or affected <> (
    select count(*) from public.vercel_migration_tracker
    where kind = 'launch' and coalesce(readiness_group, id) = item_key
  ) then
    raise exception 'Readiness item changed. Reload and try again.' using errcode = '40001';
  end if;
end;
$$;

create function public.vercel_migration_tracker_move_readiness(
  tool text, item_key uuid, adjacent_key uuid
) returns setof public.vercel_migration_tracker
language plpgsql security invoker set search_path = '' as $$
declare
  affected integer;
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin', 'exec') then
    raise insufficient_privilege;
  end if;

  perform pg_advisory_xact_lock(hashtext('vercel_migration_tracker_readiness_order'));

  return query
  with items as (
    select case when tool is null then coalesce(item.readiness_group, item.id) else item.id end as key,
           min(case when tool is null then item.readiness_overview_order else item.readiness_tool_order end) as position,
           min(item.created_at) as created
    from public.vercel_migration_tracker as item
    where item.kind = 'launch' and (tool is null or item.tool_key = tool)
    group by 1
  ), ranked as (
    select key, row_number() over (order by position nulls last, created, key) as position from items
  ), pair as (
    select moving.position as from_position, adjacent.position as to_position
    from ranked as moving cross join ranked as adjacent
    where moving.key = item_key and adjacent.key = adjacent_key and abs(moving.position - adjacent.position) = 1
  ), reordered as (
    select ranked.key, case ranked.position when pair.from_position then pair.to_position
      when pair.to_position then pair.from_position else ranked.position end as position
    from ranked cross join pair
  )
  update public.vercel_migration_tracker as item
  set readiness_overview_order = case when tool is null then reordered.position else item.readiness_overview_order end,
      readiness_tool_order = case when tool is not null then reordered.position else item.readiness_tool_order end
  from reordered
  where item.kind = 'launch' and
    (case when tool is null then coalesce(item.readiness_group, item.id) else item.id end) = reordered.key
    and (case when tool is null then item.readiness_overview_order else item.readiness_tool_order end)
      is distinct from reordered.position
  returning item.*;

  get diagnostics affected = row_count;
  if affected = 0 then
    raise exception 'Readiness order changed. Reload and try again.' using errcode = '40001';
  end if;
end;
$$;

revoke execute on function public.vercel_migration_tracker_edit_readiness(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.vercel_migration_tracker_move_readiness(text, uuid, uuid) from public, anon;
grant execute on function public.vercel_migration_tracker_edit_readiness(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.vercel_migration_tracker_move_readiness(text, uuid, uuid) to authenticated;

commit;
