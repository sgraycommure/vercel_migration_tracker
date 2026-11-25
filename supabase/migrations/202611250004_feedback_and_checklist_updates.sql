begin;

alter table public.vercel_migration_tracker
  add column readiness_latest_status text check (
    readiness_latest_status is null or (kind = 'launch' and length(readiness_latest_status) <= 5000)
  ),
  drop constraint tracker_status;

create function tooling_tracker_private.normalize_feedback_status()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind = 'feedback' then
    new.status := case lower(trim(coalesce(
      case when new.feedback_sheet_tab is not null then new.feedback_sheet_status end, new.status)))
      when 'reviewed - not proceeding' then 'Reviewed - Not Proceeding'
      when 'reviewed – not proceeding' then 'Reviewed - Not Proceeding'
      when 'no change' then 'Reviewed - Not Proceeding'
      when 'no code changes' then 'Reviewed - Not Proceeding'
      when 'done' then 'Resolved'
      when 'resolved' then 'Resolved'
      when 'closed' then 'Resolved'
      when 'complete' then 'Resolved'
      when 'completed' then 'Resolved'
      else 'Pending'
    end;
  end if;
  return new;
end;
$$;

create trigger a_tracker_normalize_feedback before insert or update of status
on public.vercel_migration_tracker for each row execute function tooling_tracker_private.normalize_feedback_status();

update public.vercel_migration_tracker set status = status where kind = 'feedback';

alter table public.vercel_migration_tracker add constraint tracker_status check (
  (kind in ('tool','feature','metric') and status in ('Implemented','Needs verification','Data gap','Removed','Planned')) or
  (kind = 'feedback' and status in ('Pending','Reviewed - Not Proceeding','Resolved')) or
  (kind = 'plan' and status in ('Backlog','Planned','In progress','Ready for testing','Shipped')) or
  (kind = 'test' and status in ('Started','Passed','Failed','Blocked')) or
  (kind = 'launch' and status in ('Open','Complete')) or
  (kind = 'qa' and status in ('Open','Passed','Failed','Blocked'))
);

grant insert (readiness_latest_status) on public.vercel_migration_tracker to authenticated;

drop index public.tracker_readiness_group_tool;
create unique index tracker_readiness_group_tool on public.vercel_migration_tracker (readiness_group, tool_key)
  where readiness_group is not null and readiness_deleted_at is null;

create function tooling_tracker_private.save_checklist_item(
  primary_id uuid, selected_tools text[], versions jsonb, changes jsonb, apply_to_group boolean
) returns setof public.vercel_migration_tracker
language plpgsql security definer set search_path = '' as $$
declare
  item public.vercel_migration_tracker;
  template public.vercel_migration_tracker;
  patched public.vercel_migration_tracker;
  group_id uuid;
  expected jsonb;
begin
  if auth.uid() is null or coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin', 'exec') then
    raise insufficient_privilege;
  end if;
  if coalesce(cardinality(selected_tools), 0) = 0
    or exists (select from unnest(selected_tools) tool where tool is null or tool not in ('px','capacity','launch','customer-ops','efficiency'))
    or changes - array['title','area','status','details','owner','due_date','deployment_url','readiness_latest_status','parent_id'] <> '{}'::jsonb then
    raise invalid_parameter_value;
  end if;

  perform pg_advisory_xact_lock(hashtext('vercel_migration_tracker_readiness_order'));

  select * into strict template from public.vercel_migration_tracker
    where kind = 'launch' and id = primary_id and readiness_deleted_at is null for update;
  group_id := coalesce(template.readiness_group, template.id);

  select jsonb_object_agg(id::text, updated_at) into expected from (
    select id, updated_at from public.vercel_migration_tracker
      where kind = 'launch' and readiness_deleted_at is null and coalesce(readiness_group, id) = group_id
      order by id for update
  ) copies;
  if (select count(*) from jsonb_object_keys(expected)) <> (select count(*) from jsonb_object_keys(versions))
    or exists (select from jsonb_each_text(expected) item_version
      where item_version.value::timestamptz is distinct from (versions->>item_version.key)::timestamptz) then
    raise exception 'Checklist changed. Reopen it before saving.' using errcode = '40001';
  end if;

  for item in select * from public.vercel_migration_tracker
    where kind = 'launch' and readiness_deleted_at is null and coalesce(readiness_group, id) = group_id
  loop
    if item.tool_key <> all(selected_tools) then
      update public.vercel_migration_tracker set readiness_deleted_at = now() where id = item.id;
    else
      patched := case when apply_to_group or item.id = primary_id then jsonb_populate_record(item, changes) else item end;
      update public.vercel_migration_tracker
      set readiness_group = group_id, title = patched.title, area = patched.area, status = patched.status,
          details = patched.details, owner = patched.owner, due_date = patched.due_date,
          deployment_url = patched.deployment_url, readiness_latest_status = patched.readiness_latest_status,
          parent_id = case when item.id = primary_id then patched.parent_id else item.parent_id end
      where id = item.id and (readiness_group, title, area, status, details, owner, due_date, deployment_url, readiness_latest_status, parent_id)
        is distinct from (group_id, patched.title, patched.area, patched.status, patched.details, patched.owner,
          patched.due_date, patched.deployment_url, patched.readiness_latest_status,
          case when item.id = primary_id then patched.parent_id else item.parent_id end);
    end if;
  end loop;

  patched := jsonb_populate_record(template, changes);
  insert into public.vercel_migration_tracker
    (tool_key,kind,title,area,status,details,owner,due_date,deployment_url,readiness_latest_status,readiness_group,readiness_overview_order)
  select distinct tool,'launch',patched.title,patched.area,patched.status,patched.details,patched.owner,patched.due_date,
    patched.deployment_url,patched.readiness_latest_status,group_id,template.readiness_overview_order
  from unnest(selected_tools) tool
  where not exists (select from public.vercel_migration_tracker
    where readiness_group = group_id and tool_key = tool and readiness_deleted_at is null);

  return query select * from public.vercel_migration_tracker
  where kind = 'launch' and readiness_group = group_id and readiness_deleted_at is null;
end;
$$;

create function public.vercel_migration_tracker_save_checklist_item(
  primary_id uuid, selected_tools text[], versions jsonb, changes jsonb, apply_to_group boolean
) returns setof public.vercel_migration_tracker
language sql security invoker set search_path = '' as $$
  select * from tooling_tracker_private.save_checklist_item(primary_id, selected_tools, versions, changes, apply_to_group)
$$;

revoke execute on function tooling_tracker_private.save_checklist_item(uuid,text[],jsonb,jsonb,boolean) from public, anon;
revoke execute on function public.vercel_migration_tracker_save_checklist_item(uuid,text[],jsonb,jsonb,boolean) from public, anon;
grant execute on function tooling_tracker_private.save_checklist_item(uuid,text[],jsonb,jsonb,boolean) to authenticated;
grant execute on function public.vercel_migration_tracker_save_checklist_item(uuid,text[],jsonb,jsonb,boolean) to authenticated;

commit;
