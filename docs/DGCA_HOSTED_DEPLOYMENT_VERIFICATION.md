# Stage and verify the DGCA deployment

The Vercel application revision for this release is `88d059b531993cd34e05bbf90339faf235c4b356`. Use the existing Vercel project connected to `chiragprabhat/dgca_monitor_indigo`. The three cloud smoke tests exercised Neon and the worker. Their HTTP requests ran on loopback. The hosted test below will use the immutable Vercel deployment URL.

## Before an approved deployment

1. In the existing Vercel project, record the current deployment and public frontend URL. Keep the previous deployment for rollback. Confirm that the Git repository, project root, Vite preset, and Node.js runtime still match the existing project.
2. In **Settings → Environment Variables**, verify the intended deployment scope. Compare the configured pooled `DATABASE_URL` hostname in Vercel privately with the pooled **Connect** hostname for `deployment-test` in Neon Console. Production scope here means the Vercel environment. Its database must still be the Neon test branch. Keep `FRONTEND_URL`, the existing operator credentials, Vercel protection settings, and same-origin `/api` configuration unchanged. Verify both `DGCA_MONITOR_ENABLED=false` and `EMAIL_NOTIFICATIONS_ENABLED=false` on GitHub and keep email disabled in Vercel and in any saved Neon dashboard override. [Neon connection instructions](https://neon.com/docs/connect/connect-from-any-app)
3. Do not run a database migration for this deployment. The test branch has already been migrated.

## Create the Vercel deployment after approval

If the existing project is already configured to stage production deployments, open **Deployments → … → Create Deployment** in Vercel. Enter the entire SHA `88d059b531993cd34e05bbf90339faf235c4b356` and select the project’s `main` production configuration if prompted. Confirm the deployment is staged. A Git-reference deployment uses the committed tree and excludes the dirty local checkout. Keep `git.deploymentEnabled: false`. [Vercel deployment by Git reference](https://vercel.com/docs/git#creating-a-deployment-from-a-git-reference)

If production domain assignment is automatic and the release must be staged before it receives traffic, use a separate clean clone and the documented CLI staging flag. Substitute the existing project and account scope. Stop if the link dialog would create a project or link a different one.

```powershell
$dgcaReleaseSha = '88d059b531993cd34e05bbf90339faf235c4b356'
$dgcaReleaseDir = Join-Path ([IO.Path]::GetTempPath()) ('dgca-vercel-' + [Guid]::NewGuid().ToString('N'))
git clone https://github.com/chiragprabhat/dgca_monitor_indigo.git $dgcaReleaseDir
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location -LiteralPath $dgcaReleaseDir
git checkout --detach $dgcaReleaseSha
if ($LASTEXITCODE -ne 0 -or (git rev-parse HEAD) -ne $dgcaReleaseSha -or (git status --porcelain)) {
  throw 'Expected the exact clean release checkout'
}
$dgcaVercelProject = Read-Host 'Existing Vercel project name'
$dgcaVercelScope = Read-Host 'Existing Vercel account or team slug'
vercel link --project $dgcaVercelProject --scope $dgcaVercelScope
if ($LASTEXITCODE -ne 0) { throw 'Vercel project link failed' }
vercel deploy --prod --skip-domain
```

The SHA must match exactly and the status must be empty before linking. Deploy from that clone with the existing project variables. The CLI does not need an environment pull or local `.env` file. [Vercel CLI deployment flags](https://vercel.com/docs/cli/deploy#skip-domain)

In the deployment details, verify the source SHA, the production environment scope, and the staged state. Copy the generated immutable `<project>-<9-character-hash>-<scope>.vercel.app` URL from that deployment’s details. The runner checks the generated URL format and its exact match with the separately stored approval URL. The operator confirms the SHA and URL in Vercel. The runner has no Vercel management API credentials. [Vercel generated deployment URLs](https://vercel.com/docs/deployments/generated-urls)

## Publish and configure the hosted test after separate approval

Publish the new manual Actions workflow and its `ops` runner to GitHub `main` only after review. Vercel continues to use the pinned application SHA. The workflow checks out that same SHA separately for its worker code.

| GitHub setting | Value |
| --- | --- |
| Variable `HOSTED_SMOKE_URL` | The immutable Vercel URL copied from that deployment’s details. |
| Variables `HOSTED_SMOKE_TEST_RUN_ID` and `HOSTED_SMOKE_TEST_RUN_AT` | The ID and raw UTC `run_at` (`YYYY-MM-DD HH:MM:SS`) for the successful monitoring smoke test run added **after the fork** on `deployment-test`. Confirm against the previous smoke-test output and a read-only query of `monitoring_logs` on `deployment-test`. The entry must still be among the five recent runs returned by the hosted status API. |
| Secrets `HOSTED_SMOKE_OPERATOR_USERNAME` and `HOSTED_SMOKE_OPERATOR_PASSWORD` | The existing operator credentials for that deployment. Supply them only in GitHub secret settings and leave Vercel’s credentials in place. |
| Optional secret `HOSTED_SMOKE_VERCEL_BYPASS` | The project’s authorized automation bypass secret if Vercel Deployment Protection covers the generated URL. Keep Vercel protection and operator authentication enabled. If no authorized bypass is available, stop. |
| Existing test database configuration | Reuse `DEPLOYMENT_TEST_DATABASE_URL` and the independently confirmed `DEPLOYMENT_TEST_NEON_HOST` and `PRODUCTION_NEON_HOST` values. Keep `DGCA_MONITOR_ENABLED=false` and `EMAIL_NOTIFICATIONS_ENABLED=false`. |

[GitHub Actions secret setup](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-a-repository) · [Vercel protection bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)

## Run and verify after approval

1. Choose **Actions → DGCA hosted Vercel job smoke test → Run workflow**, select `main`, enter `RUN HOSTED SYNTHETIC TEST`, and paste the generated deployment URL again in `deployment_url`. Before writing a marker, the runner verifies the direct Neon endpoint and TLS and compares the approved post-fork monitoring log with the read-only hosted status response. It requires the operator challenge and confirms hosted email is off. While holding the worker lock, it creates a random test marker and requires the hosted API to read it before the first upload. Requests stay on the approved origin and reject redirects. The runner processes only the synthetic jobs it can identify by ID and exact payload. [GitHub manual workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
2. Look for `outcome=hosted-jobs-verified`, the pinned SHA, `fullUploadBytes=41943040`, `fullUploadChunks=14`, `syntheticJobsProcessed=3`, and `fixturesCleaned=true`. The three jobs are two uploads and their comparison. The test validates each completed result through the hosted jobs API, verifies both PDF hashes in Neon, and checks that upload sessions and chunks were cleaned up. It processes no SMTP, monitoring, CAR, archive, or unrelated queue jobs.
3. A branch mismatch, missing credentials, email enabled, worker lock contention, or expired or expiring unrelated upload sessions blocks the run. The expired-session guard matters because the deployed upload-opening route performs its normal cleanup. The Actions job is capped at five minutes. Hosted HTTP requests have a 25-second individual deadline and a three-minute total budget. Only one full-size PDF is sent, with 14 requests of at most 3 MiB and one small comparison PDF. Budget up to about 80 MiB of database read transfer for one run when PostgreSQL transfers PDF bytes in hexadecimal form. The hosted test uses the shared test-branch tables because the actual Vercel API cannot see the rollback-only schema used by the other smoke test. [Vercel function limits](https://vercel.com/docs/functions/limitations) · [Neon pricing and usage](https://neon.com/pricing)
4. After verification and promotion approval, promote the **same staged deployment**. Confirm that the original frontend URL serves it and that operator sign-in and the read-only dashboard work. Keep the existing workers disabled. If promotion fails, use Vercel’s previous deployment as the rollback target. [Vercel staged promotion and rollback](https://vercel.com/docs/deployments/promoting-a-deployment)

Without the separately published hosted verifier, the existing workflow can only verify scratch-schema processing over loopback, and the recurring worker would handle the general queue. Leave that worker disabled.

## Inspect an interrupted run

1. Keep both GitHub flags false and confirm the workflow has stopped. In Neon Console, explicitly select `deployment-test` and verify its direct endpoint before inspecting data.
2. From the `synthetic-fixture-ids`, `synthetic-job-owned`, and `synthetic-upload-verified` log entries, take only the generated IDs, filenames, hashes, and payloads. Read the corresponding `dgca_upload_sessions` rows by exact generated filename and byte count, `dgca_jobs` rows by ID, and `uploaded_documents` rows by exact filename and SHA-256 hash. If the comparison request timed out before ownership was recorded, use `synthetic-comparison-input` to look for that exact pair and verify it before any cleanup. Keep unrelated or ambiguous rows.
3. For separately approved cleanup, use a transaction on `deployment-test`. Delete only the matched upload sessions by ID, filename and byte count so their chunks cascade. Then delete the matched jobs by ID, kind and exact JSON input, the generated documents by ID, filename and hash, and the canary by ID, kind and logged nonce in its result. Inspect the affected rows with `RETURNING` and roll back if anything differs. Keep the general queue disabled throughout.
