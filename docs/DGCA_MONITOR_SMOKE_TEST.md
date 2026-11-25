# DGCA monitoring smoke test

This workflow runs one monitoring cycle against the migrated Neon `deployment-test` branch. It uses the normal IST window and slot claim, DGCA publication storage, and built-in summary code. It skips the background queue, CAR refresh, archive processing, and worker heartbeat. SMTP stays disabled even if the branch has saved email settings, and monitoring leaves email delivery decisions untouched.

## Configure GitHub after approval

1. In Neon Console, select the `deployment-test` branch, open **Connect**, and turn **Connection pooling** off. Select the writable compute and the same database that the Vercel test deployment uses. Copy the direct URL. Separately note the test compute's direct hostname and the production compute's direct hostname from their respective branch pages. Supply only hostnames for the two variables below. [Neon connection instructions](https://neon.com/docs/connect/connect-from-any-app)
2. In `chiragprabhat/dgca_monitor_indigo`, open **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Name it `DEPLOYMENT_TEST_DATABASE_URL` and paste the direct test URL into the secret field. [GitHub secret instructions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository)
3. In the **Variables** tab, add `DEPLOYMENT_TEST_NEON_HOST` and `PRODUCTION_NEON_HOST` with the independently confirmed direct hostnames. Keep `DGCA_MONITOR_ENABLED=false`. The smoke workflow uses the existing monitoring-window variables and the saved interval on the test branch.
4. On `deployment-test`, confirm that the saved `summaryProvider` is `basic` or that no provider is saved. Use the test deployment's Settings page. The smoke runner refuses to scrape when a different engine is saved and enforces the built-in engine for the duration of the run.

## Run and verify after approval

Once the workflow is present on GitHub `main` and manual dispatch is approved, open **Actions → DGCA monitoring smoke test → Run workflow**, select `main`, and dispatch once. Start inside the configured IST window and in a slot the test database has not already claimed. Use the monitor-only job log to review the baseline and outcome. [GitHub manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

- `scraped` requires a nonempty scrape, exactly one new successful monitoring log, and an unchanged notification count. Publication counts may be identical when DGCA has no unseen publications.
- `outside-monitoring-window`, `slot-already-claimed`, and `monitor-busy` mean scraping did not occur. They fail the smoke test and are reported individually.
- `invalid-summary-provider` means the test database selected another engine. `monitor-error` means the monitoring cycle did not finish successfully. `preflight-or-monitor-error` covers connection, settings, and unexpected errors. Invariant failures identify notification-count changes or a missing or unexpected monitoring log.

Compare the two counts and latest monitoring log IDs in the workflow output, then verify the log on the Vercel test deployment's Activity Log. This workflow intentionally does not mark the recurring scheduler as running.
