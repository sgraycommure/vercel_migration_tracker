# Tooling Tracker

Internal tracker for PX Dashboard, Customer Operations Workspace, Enterprise Launch Tracker, Enterprise Efficiency Log, and Enterprise Capacity Management.

## Data and access

Apply the two migrations in `supabase/migrations` in order to the shared Enterprise Operations Supabase project. The catalog, feedback, build plans, and test actions are rows in `public.vercel_migration_tracker`.

The app offers Google sign-in. Access requires a verified Commure identity and an active `ent_ops_users` record. All tracker members can submit feedback, build plans, and test actions. Admins and Execs manage the catalog and can edit submitted plans and feedback. Other users can edit their own plans and feedback. Test actions are append-only and the database sets the tester identity and timestamp. Use the tracker to log actions and outcomes against specific deployments and features. Activity inside the five source tools is not collected by this app.

Catalog status describes the source review. Use the usage tracker to record findings from authenticated preview and production tests.

## Run and deploy

1. Use Node.js 24, run `npm ci`, then copy `.env.example` to `.env.local`.
2. Supply the shared instance URL and Supabase publishable key. Run `npm run dev`, `npm run typecheck`, or `npm run build`.
3. On Vercel use the `vercel_migration_tracker` project, the same two public environment variables, and the `tracker-preview` branch for preview testing.
4. Ensure Supabase Auth Redirect URLs allow the preview origin's `/auth/callback`. The application uses PKCE and keeps its local session separate from the other tools.

## Feedback workbook

Feedback rows are categorized by worksheet name and linked to their original row. Admins and Execs can use **Sync Google Sheet** to refresh the snapshot after authorizing Google Sheets read access. The Google OAuth project must have Sheets API access enabled. The integration reads this workbook's five recognized tabs and stores the imported snapshot in the same tracker table. Edit imported feedback in the workbook. Tracker-created feedback remains editable in the tracker.
