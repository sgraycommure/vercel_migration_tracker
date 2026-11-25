begin;

alter table public.vercel_migration_tracker
  add column readiness_deleted_at timestamptz,
  add constraint tracker_readiness_deletion_kind check (readiness_deleted_at is null or kind = 'launch');

alter policy tracker_read on public.vercel_migration_tracker
  using (readiness_deleted_at is null and (select tooling_tracker_private.workspace_role()) is not null);

create function tooling_tracker_private.delete_readiness(
  selected_tool text, item_key uuid, versions jsonb
) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  deleted_ids uuid[];
  expected integer;
begin
  if auth.uid() is null or coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin', 'exec') then
    raise insufficient_privilege;
  end if;

  perform pg_advisory_xact_lock(hashtext('vercel_migration_tracker_readiness_order'));

  select count(*) into expected from jsonb_object_keys(versions);
  with deleted as (
    update public.vercel_migration_tracker as item set readiness_deleted_at = now()
    where item.kind = 'launch' and item.readiness_deleted_at is null
      and case when selected_tool is null then coalesce(item.readiness_group, item.id) = item_key
               else item.tool_key = selected_tool and item.id = item_key end
      and item.updated_at = (versions->>item.id::text)::timestamptz
    returning item.id
  )
  select array_agg(id) into deleted_ids from deleted;

  if deleted_ids is null or cardinality(deleted_ids) <> expected or exists (
    select from public.vercel_migration_tracker as item where item.kind = 'launch' and item.readiness_deleted_at is null
      and case when selected_tool is null then coalesce(item.readiness_group, item.id) = item_key
               else item.tool_key = selected_tool and item.id = item_key end
  ) then
    raise exception 'Readiness item changed. Reload and try again.' using errcode = '40001';
  end if;

  return deleted_ids;
end;
$$;

create function public.vercel_migration_tracker_delete_readiness(
  selected_tool text, item_key uuid, versions jsonb
) returns uuid[]
language sql security invoker set search_path = '' as $$
  select tooling_tracker_private.delete_readiness(selected_tool, item_key, versions);
$$;

revoke execute on function tooling_tracker_private.delete_readiness(text, uuid, jsonb) from public, anon;
revoke execute on function public.vercel_migration_tracker_delete_readiness(text, uuid, jsonb) from public, anon;
grant execute on function tooling_tracker_private.delete_readiness(text, uuid, jsonb) to authenticated;
grant execute on function public.vercel_migration_tracker_delete_readiness(text, uuid, jsonb) to authenticated;

commit;
