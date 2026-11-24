begin;

alter table public.vercel_migration_tracker
  drop constraint vercel_migration_tracker_kind_check,
  add constraint vercel_migration_tracker_kind_check check (kind in ('tool','feature','metric','feedback','plan','test','launch','qa')),
  drop constraint tracker_status,
  add constraint tracker_status check (
    (kind in ('tool','feature','metric') and status in ('Implemented','Needs verification','Data gap','Removed','Planned')) or
    (kind = 'feedback' and status in ('New','Triaged','Resolved')) or
    (kind = 'plan' and status in ('Backlog','Planned','In progress','Ready for testing','Shipped')) or
    (kind = 'test' and status in ('Started','Passed','Failed','Blocked')) or
    (kind = 'launch' and status in ('Open','Complete')) or
    (kind = 'qa' and status in ('Open','Passed','Failed','Blocked'))
  );

create function tooling_tracker_private.seed_catalog_qa()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.kind not in ('feature','metric') or new.status = 'Removed' then return new; end if;
  insert into public.vercel_migration_tracker
    (tool_key, kind, entry_key, title, area, status, parent_id, created_by, actor_email)
  values (new.tool_key, 'qa', 'release-test-' || new.id, new.title, new.area, 'Open', new.id, null, null)
  on conflict (tool_key,entry_key) do nothing;
  return new;
end;
$$;
revoke execute on function tooling_tracker_private.seed_catalog_qa() from public, anon, authenticated;
create trigger seed_catalog_qa after insert or update of status on public.vercel_migration_tracker
for each row when (new.kind in ('feature','metric'))
execute function tooling_tracker_private.seed_catalog_qa();

insert into public.vercel_migration_tracker (tool_key,kind,entry_key,title,area,status,parent_id)
select tool_key, 'qa', 'release-test-' || id, title, area, 'Open', id
from public.vercel_migration_tracker
where kind in ('feature','metric') and status <> 'Removed'
on conflict (tool_key,entry_key) do nothing;

insert into public.vercel_migration_tracker (tool_key,kind,entry_key,title,area,details,status)
select tool.tool_key,'qa',test.key,test.title,test.area,test.details,'Open'
from (values ('px'),('customer-ops'),('launch'),('efficiency'),('capacity')) as tool(tool_key)
cross join (values
  ('release-sign-in','Sign in, sign out, and session expiry','Access','Verify Google sign-in and redirect, sign-out, and recovery from an expired session. Verify that the production sign-in names the correct tool.'),
  ('release-roles','Verify role permissions and Usage access','Access','Test allowed and denied workflows by role, including admin-only access to Usage and direct routes.'),
  ('release-states','Verify loading, empty, error, and retry states','Reliability','Exercise an empty filter, a slow or unavailable source, and recovery. Verify the app distinguishes missing data from zero.'),
  ('release-write','Verify save, refresh, and downstream consistency','Reliability','Use approved test records. Check that core edits persist after reload, validation prevents invalid writes, and retries do not duplicate the saved record.'),
  ('release-ui','Check navigation, accessibility, and layout','Interface','Use keyboard navigation. Check the main views and forms at desktop and laptop widths and verify scrolling and filter resets.'),
  ('release-smoke','Run a smoke test on the release candidate','Release','Confirm the candidate build, canonical route, role access, and key read, write, or export paths. Record the build and evidence before release.')
) as test(key,title,area,details)
on conflict (tool_key,entry_key) do nothing;

create or replace function tooling_tracker_private.audit_tracker_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or new.kind = 'test' or (new.kind = 'feedback' and new.feedback_sheet_tab is not null)
     or (new.kind = 'qa' and new.created_by is null and tg_op = 'INSERT') then
    return new;
  end if;
  insert into tooling_tracker_private.testing_activity (user_id,actor,tool_key,page,action,outcome)
  values (
    auth.uid(), lower(auth.jwt()->>'email'), new.tool_key,
    case new.kind when 'launch' then 'Launch Management' when 'plan' then 'Build plans'
      when 'feedback' then 'Feedback' when 'tool' then 'Overview' when 'qa' then 'Release testing' else 'Features & metrics' end,
    case
      when new.kind = 'qa' then 'Set release test outcome: ' || new.status
      when new.kind = 'launch' and tg_op = 'UPDATE' and new.status is distinct from old.status
        then case when new.status = 'Complete' then 'Complete checklist item' else 'Reopen checklist item' end
      else case when tg_op = 'INSERT' then 'Add ' else 'Save ' end ||
        case new.kind when 'launch' then 'checklist item' when 'plan' then 'build plan' else new.kind end
    end,
    'Succeeded'
  );
  return new;
end;
$$;

commit;
