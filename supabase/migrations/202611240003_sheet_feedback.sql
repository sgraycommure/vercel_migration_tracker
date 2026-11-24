begin;

alter table public.vercel_migration_tracker
  add column metric_source text,
  add column feedback_requester text,
  add column feedback_sheet_tab text,
  add column feedback_sheet_status text,
  add column feedback_response text,
  add column feedback_sheet_present boolean not null default true;

grant insert (metric_source), update (metric_source) on public.vercel_migration_tracker to authenticated;

-- Store the latest complete sheet snapshot while retaining IDs used by plans and tests.
create function tooling_tracker_private.import_feedback_sheet(snapshot jsonb)
returns int
language plpgsql
set search_path = ''
as $$
declare
  tab jsonb;
  expected_tool text;
  matched_tools text[] := '{}';
  refreshed_keys text[] := '{}';
  record_item record;
  key_value text;
  link_prefix constant text := 'https://docs.google.com/spreadsheets/d/10xuhvk-AlT83RaYQ3en2jD3n3L1zNmNpJ2oRHirJ6RM/edit';
begin
  if jsonb_typeof(snapshot) is distinct from 'array' or jsonb_array_length(snapshot) <> 5 then
    raise exception 'A complete five-tab workbook is required';
  end if;
  perform pg_advisory_xact_lock(2048137269);
  for tab in select value from jsonb_array_elements(snapshot) loop
    expected_tool := case lower(trim(tab->>'name'))
      when 'implementation tracker' then 'launch'
      when 'launch tracker' then 'launch'
      when 'enterprise launch tracker' then 'launch'
      when 'efficiency log' then 'efficiency'
      when 'enterprise efficiency log' then 'efficiency'
      when 'px dashboard' then 'px'
      when 'capacity management' then 'capacity'
      when 'enterprise capacity management' then 'capacity'
      when 'customer operations' then 'customer-ops'
      when 'customer operations workspace' then 'customer-ops'
    end;
    if expected_tool is null or expected_tool = any(matched_tools)
      or tab->>'tool' is distinct from expected_tool
      or coalesce(tab->>'gid', '') !~ '^[0-9]{1,10}$'
      or jsonb_typeof(tab->'rows') is distinct from 'array'
      or jsonb_array_length(tab->'rows') > 10000 then
      raise exception 'Invalid feedback tab';
    end if;
    matched_tools := array_append(matched_tools, expected_tool);

    for record_item in
      select *, row_number() over (partition by lower(trim(title)), lower(trim(requester)) order by row) as occurrence
      from jsonb_to_recordset(tab->'rows') as item(row int, title text, requester text, notes text, status text, response text)
    loop
      if coalesce(trim(record_item.title), '') = '' or coalesce(record_item.row, 0) < 2 then
        raise exception 'Invalid feedback row';
      end if;
      key_value := 'sheet-feedback-' || expected_tool || '-' || md5(jsonb_build_array(
        lower(trim(record_item.title)), lower(trim(coalesce(record_item.requester, ''))), record_item.occurrence)::text);
      refreshed_keys := array_append(refreshed_keys, key_value);

      insert into public.vercel_migration_tracker as entry
        (tool_key, kind, entry_key, title, details, status, source_url, created_by, actor_email,
         feedback_requester, feedback_sheet_tab, feedback_sheet_status, feedback_response, feedback_sheet_present)
      values (expected_tool, 'feedback', key_value, left(trim(record_item.title), 160),
        coalesce(left(record_item.notes, 5000), ''),
        case
          when lower(trim(record_item.status)) in ('done','resolved','closed','complete','completed','no change','no code changes') then 'Resolved'
          when lower(trim(record_item.status)) in ('triaged','in progress','planned','reviewing','under review') then 'Triaged'
          else 'New'
        end,
        link_prefix || '#gid=' || (tab->>'gid') || '&range=A' || record_item.row,
        null, null, nullif(left(record_item.requester, 300), ''), tab->>'name',
        nullif(left(record_item.status, 300), ''), nullif(left(record_item.response, 10000), ''), true)
      on conflict (tool_key, entry_key) do update set
        title = excluded.title, details = excluded.details, status = excluded.status, source_url = excluded.source_url,
        feedback_requester = excluded.feedback_requester, feedback_sheet_tab = excluded.feedback_sheet_tab,
        feedback_sheet_status = excluded.feedback_sheet_status, feedback_response = excluded.feedback_response,
        feedback_sheet_present = true
      where (entry.title, entry.details, entry.status, entry.source_url, entry.feedback_requester,
             entry.feedback_sheet_tab, entry.feedback_sheet_status, entry.feedback_response, entry.feedback_sheet_present)
        is distinct from
            (excluded.title, excluded.details, excluded.status, excluded.source_url, excluded.feedback_requester,
             excluded.feedback_sheet_tab, excluded.feedback_sheet_status, excluded.feedback_response, true);
    end loop;
  end loop;

  update public.vercel_migration_tracker
  set feedback_sheet_present = false
  where kind = 'feedback' and feedback_sheet_tab is not null and feedback_sheet_present
    and not (entry_key = any(refreshed_keys));

  return cardinality(refreshed_keys);
end;
$$;

revoke execute on function tooling_tracker_private.import_feedback_sheet(jsonb) from public, anon, authenticated;

create function tooling_tracker_private.sync_feedback_sheet(snapshot jsonb)
returns int
language plpgsql security definer
set search_path = ''
as $$
begin
  if coalesce(lower(tooling_tracker_private.workspace_role()), '') not in ('admin','exec') then
    raise exception 'Feedback synchronization requires tracker management access' using errcode = '42501';
  end if;
  return tooling_tracker_private.import_feedback_sheet(snapshot);
end;
$$;

revoke execute on function tooling_tracker_private.sync_feedback_sheet(jsonb) from public, anon;
grant execute on function tooling_tracker_private.sync_feedback_sheet(jsonb) to authenticated;

create function public.vercel_migration_tracker_sync_feedback(snapshot jsonb)
returns int
language sql security invoker
set search_path = ''
as $$ select tooling_tracker_private.sync_feedback_sheet(snapshot) $$;

revoke execute on function public.vercel_migration_tracker_sync_feedback(jsonb) from public, anon;
grant execute on function public.vercel_migration_tracker_sync_feedback(jsonb) to authenticated;
commit;
