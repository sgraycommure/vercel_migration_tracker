begin;

create table tooling_tracker_private.testing_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  actor text not null,
  session_id uuid,
  tool_key text check (tool_key in ('px','customer-ops','launch','efficiency','capacity')),
  occurred_at timestamptz not null default clock_timestamp(),
  environment text check (environment in ('Preview','Production','Local')),
  page text not null,
  action text not null,
  outcome text not null check (outcome in ('Not recorded','Viewed','Succeeded','Failed'))
);
alter table tooling_tracker_private.testing_activity enable row level security;
revoke all on tooling_tracker_private.testing_activity from public, anon, authenticated;
create index tracker_testing_activity_time on tooling_tracker_private.testing_activity (occurred_at desc);

create function tooling_tracker_private.log_testing_activity(
  browser_session uuid, tool text, app_page text, app_action text, result text, build_environment text
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if tooling_tracker_private.workspace_role() is null then
    raise exception 'Tracker access required' using errcode = '42501';
  end if;
  if app_page not in ('Overview','Launch Management','Features & metrics','Feedback','Build plans','Usage tracker')
    or result not in ('Not recorded','Viewed','Failed')
    or char_length(app_action) not between 1 and 100 then
    raise exception 'Invalid tracker activity';
  end if;
  insert into tooling_tracker_private.testing_activity
    (user_id, actor, session_id, tool_key, environment, page, action, outcome)
  values (auth.uid(), lower(auth.jwt()->>'email'), browser_session, tool, build_environment, app_page, app_action, result);
end;
$$;

create function public.vercel_migration_tracker_log_activity(
  browser_session uuid, tool text, app_page text, app_action text, result text, build_environment text
)
returns void language sql security invoker set search_path = ''
as $$ select tooling_tracker_private.log_testing_activity(browser_session,tool,app_page,app_action,result,build_environment) $$;

create function tooling_tracker_private.audit_tracker_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or new.kind = 'test' or (new.kind = 'feedback' and new.feedback_sheet_tab is not null) then
    return new;
  end if;
  insert into tooling_tracker_private.testing_activity (user_id,actor,tool_key,page,action,outcome)
  values (
    auth.uid(), lower(auth.jwt()->>'email'), new.tool_key,
    case new.kind when 'launch' then 'Launch Management' when 'plan' then 'Build plans'
      when 'feedback' then 'Feedback' when 'tool' then 'Overview' else 'Features & metrics' end,
    case when new.kind = 'launch' and tg_op = 'UPDATE' and new.status is distinct from old.status
      then case when new.status = 'Complete' then 'Complete checklist item' else 'Reopen checklist item' end
      else case when tg_op = 'INSERT' then 'Add ' else 'Save ' end ||
        case new.kind when 'launch' then 'checklist item' when 'plan' then 'build plan' else new.kind end
    end,
    'Succeeded'
  );
  return new;
end;
$$;

create trigger audit_tracker_writes after insert or update on public.vercel_migration_tracker
for each row execute function tooling_tracker_private.audit_tracker_write();

revoke execute on function tooling_tracker_private.log_testing_activity(uuid,text,text,text,text,text),
  public.vercel_migration_tracker_log_activity(uuid,text,text,text,text,text),
  tooling_tracker_private.audit_tracker_write() from public, anon, authenticated;
grant execute on function tooling_tracker_private.log_testing_activity(uuid,text,text,text,text,text),
  public.vercel_migration_tracker_log_activity(uuid,text,text,text,text,text) to authenticated;

commit;
