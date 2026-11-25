begin;

create function public.vercel_migration_tracker_move_readiness(
  tool text, item_key uuid, adjacent_key uuid, place_after boolean
) returns setof public.vercel_migration_tracker
language plpgsql security invoker set search_path = '' as $$
declare
  ordered_keys uuid[];
  from_position integer;
  target_position integer;
  to_position integer;
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin', 'exec') then
    raise insufficient_privilege;
  end if;

  perform pg_advisory_xact_lock(hashtext('vercel_migration_tracker_readiness_order'));

  select array_agg(key order by position nulls last, created, key) into ordered_keys
  from (
    select case when tool is null then coalesce(item.readiness_group, item.id) else item.id end as key,
           min(case when tool is null then item.readiness_overview_order else item.readiness_tool_order end) as position,
           min(item.created_at) as created
    from public.vercel_migration_tracker as item
    where item.kind = 'launch' and (tool is null or item.tool_key = tool)
    group by 1
  ) as items;

  from_position := array_position(ordered_keys, item_key);
  target_position := array_position(ordered_keys, adjacent_key);
  if from_position is null or target_position is null or from_position = target_position
    or (place_after is null and abs(from_position - target_position) <> 1) then
    raise exception 'Readiness order changed. Reload and try again.' using errcode = '40001';
  end if;

  to_position := target_position + coalesce(place_after, from_position < target_position)::integer
    - (from_position < target_position)::integer;
  if to_position = from_position then
    return;
  end if;

  return query
  with reordered as (
    select key, case
      when position = from_position then to_position
      when position between from_position + 1 and to_position then position - 1
      when position between to_position and from_position - 1 then position + 1
      else position
    end as position
    from unnest(ordered_keys) with ordinality as items(key, position)
  )
  update public.vercel_migration_tracker as item
  set readiness_overview_order = case when tool is null then reordered.position else item.readiness_overview_order end,
      readiness_tool_order = case when tool is not null then reordered.position else item.readiness_tool_order end
  from reordered
  where item.kind = 'launch'
    and (case when tool is null then coalesce(item.readiness_group, item.id) else item.id end) = reordered.key
    and (case when tool is null then item.readiness_overview_order else item.readiness_tool_order end)
      is distinct from reordered.position
  returning item.*;
end;
$$;

create or replace function public.vercel_migration_tracker_move_readiness(
  tool text, item_key uuid, adjacent_key uuid
) returns setof public.vercel_migration_tracker
language sql security invoker set search_path = '' as $$
  select * from public.vercel_migration_tracker_move_readiness(tool, item_key, adjacent_key, null::boolean);
$$;

revoke execute on function public.vercel_migration_tracker_move_readiness(text, uuid, uuid, boolean) from public, anon;
grant execute on function public.vercel_migration_tracker_move_readiness(text, uuid, uuid, boolean) to authenticated;

commit;
