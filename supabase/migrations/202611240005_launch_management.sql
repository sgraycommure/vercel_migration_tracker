begin;

alter table public.vercel_migration_tracker
  drop constraint vercel_migration_tracker_kind_check,
  add constraint vercel_migration_tracker_kind_check
    check (kind in ('tool','feature','metric','feedback','plan','test','launch')),
  drop constraint tracker_status,
  add constraint tracker_status check (
    (kind in ('tool','feature','metric') and status in ('Implemented','Needs verification','Data gap','Removed','Planned')) or
    (kind = 'feedback' and status in ('New','Triaged','Resolved')) or
    (kind = 'plan' and status in ('Backlog','Planned','In progress','Ready for testing','Shipped')) or
    (kind = 'test' and status in ('Started','Passed','Failed','Blocked')) or
    (kind = 'launch' and status in ('Open','Complete'))
  ),
  add constraint tracker_launch_category check (
    kind <> 'launch' or (area is not null and area in (
      'Punch list','Training','Office hours','Testing','Stakeholder approval','Communications','Cutover & support'
    ))
  );

alter policy tracker_add on public.vercel_migration_tracker
  with check (
    created_by = (select auth.uid()) and
    (select tooling_tracker_private.workspace_role()) is not null and
    (kind in ('feedback','plan','test') or
      (kind in ('feature','metric','launch') and lower((select tooling_tracker_private.workspace_role())) in ('admin','exec')))
  );

with schedule(tool_key, wave, workshop, exercise, testing, reconciliation) as (
  values
    ('launch', 1, 'Implementation PM and manager walkthrough', 'Update a milestone, manage a task, and find projects that need updates.',
      'Pilot across the three business lines. Exercise project/task edits, Client assignment, LOB filters, role access, and usage reporting.',
      'Reconcile weekly notes, missing actual go-lives, LOB inactivity, exports, and the approved report delivery schedule.'),
    ('px', 2, 'PX analyst and lead walkthrough', 'Filter to an account, find a contact or opportunity, and review a Needs Attention item.',
      'Verify the Salesforce-backed views, opportunity ordering, contact filters, PX user administration, and Needs Attention details.',
      'Reconcile account coverage, opportunity counts and values, and Needs Attention totals. Check stale and unavailable data states.'),
    ('customer-ops', 2, 'CSM and manager walkthrough', 'Open an account, find its projects, add a follow-up, and review renewals and weighted pipeline.',
      'Verify account and child-account matching, links, CSM logistics editing, notes, tasks, follow-ups, and the usage export.',
      'Reconcile renewals, Salesforce account eligibility, product exclusions, and ACV weighted by probability.'),
    ('capacity', 3, 'Resource planner and manager walkthrough', 'Create an allocation and check the affected capacity, available hours, and forecast cost.',
      'Verify manager and employee filters, project and product selection, allocation and capacity forms, eligible tasks, and calendar views.',
      'Reconcile capacity, allocations, utilization, hourly forecast cost, the individual chart, and revised-date go-live rules.'),
    ('efficiency', 3, 'Time submitter and approver walkthrough', 'Practice time entry, approval, rejection, and resubmission with test records.',
      'Test duplicate and zero-hour validation, role-scoped access, and a complete approval cycle including review details and the resubmission email.',
      'Reconcile Salesforce account rollups, internal hours, weekly reporting, approval states, and six-month labor spend.')
)
insert into public.vercel_migration_tracker (tool_key, kind, entry_key, title, area, details, status, owner)
select tool_key, 'launch', 'launch-check-' || item.key, item.title, item.area, item.details, 'Open', item.owner
from schedule
cross join lateral (values
  ('blockers', 'Punch list', 'Triage launch defects and dependencies', 'Assign owners and dates. Close critical and high-severity defects. Record accepted workarounds and deferred issues.', 'Tool owner'),
  ('testing', 'Testing', 'Complete role-based preview testing', testing, 'UAT lead'),
  ('metrics', 'Testing', 'Reconcile launch metrics and data', reconciliation, 'Data owner'),
  ('access', 'Testing', 'Verify sign-in, branding, and role access', 'Check the canonical production sign-in name, Google redirect, access by role, and a separate preview session.', 'Engineering release owner'),
  ('training', 'Training', workshop, exercise || ' Record the live walkthrough and publish the quick-start guide.', 'Training champion'),
  ('office-hours', 'Office hours', 'Schedule first-week office hours', 'Set the date and time, name a facilitator and backup, and record the meeting link or joining details.', 'Support lead'),
  ('owners', 'Stakeholder approval', 'Confirm rollout owners and pilot group', 'Confirm the tool owner, sponsor, release owner, UAT lead, data or access owner, pilot participants, and support backup.', 'Launch lead'),
  ('signoff', 'Stakeholder approval', 'Record go/no-go decision and approvals', 'Capture the approved build, tool owner and engineering sign-off, data or access approval, and any exceptions.', 'Launch lead'),
  ('readout', 'Communications', 'Send readiness and pilot communications', 'Confirm the wave date and audience. Prepare the preview link, test instructions, training invitation, and feedback deadline.', 'Tool owner'),
  ('announcement', 'Communications', 'Prepare launch announcement', 'Prepare the production link, quick-start guide, primary action, cutover instructions, and support contact. Send after the smoke test passes.', 'Launch lead'),
  ('cutover', 'Cutover & support', 'Prepare cutover, smoke tests, and recovery', 'Record the previous build, primary write path, scheduled jobs, production verification steps, and rollback criteria.', 'Engineering release owner'),
  ('handoff', 'Cutover & support', 'Assign triage and adoption follow-up', 'Confirm who covers the first three business days, monitors issues, reviews day 7 and day 30 results, and owns ongoing support.', 'Support lead')
) as item(key, area, title, details, owner)
on conflict (tool_key, entry_key) do nothing;

-- Linked punch-list rows keep local notes, due dates, and completion independent of catalog descriptions.
insert into public.vercel_migration_tracker (tool_key, kind, entry_key, title, area, details, status, parent_id)
select tool_key, 'launch', 'launch-punch-' || entry_key, title, 'Punch list', details, 'Open', id
from public.vercel_migration_tracker
where kind = 'metric' and status in ('Needs verification','Data gap') and entry_key is not null
on conflict (tool_key, entry_key) do nothing;

commit;
