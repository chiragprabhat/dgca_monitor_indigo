# DGCA background-job smoke test

This manual workflow exercises the Vercel API handler and Actions job handlers against PostgreSQL. It verifies the direct `deployment-test` hostname against the independently configured test hostname, rejects production and pooled endpoints, and checks TLS certificate trust and hostname identity before creating any database objects. The workflow receives the dedicated database secret and no SMTP secrets.

The runner uses a loopback HTTP server with the existing Vercel handler and synthetic DGCA responses. Each job is claimed by its fixture ID. The PostgreSQL schema and fixture writes live in one rollback-only transaction, with no application schema in the search path. The runner verifies the scratch schema disappears on rollback. If the database connection closes unexpectedly, PostgreSQL rolls back the transaction.

## Background-job inventory

| Job | Production execution | Smoke coverage |
| --- | --- | --- |
| `upload` | The browser opens a session, uploads 3 MiB chunks up to 40 MiB, and finalizes a job. The worker assembles and parses the PDF, then removes the temporary session and bytes. | One full 40 MiB synthetic PDF in 14 chunks, repeated chunk/finalization requests, rejection above the limit and before all chunks arrive, authenticated result retrieval, and cleanup after completion and expiration. |
| `compare` | The API queues document IDs or a validated DGCA URL. The worker reads text and produces a diff for the polling API. | Compares the synthetic upload with a fixture CAR. Verifies duplicate queue requests share one job and an interrupted comparison can be reclaimed. |
| `revision` | The worker reads or refreshes a publication's stored revision comparison. | Reviewed as part of the shared dispatcher. The smoke does not create a separate revision job. |
| `car` | A dashboard refresh or hourly worker check queues CAR synchronization. The worker maintains current records, revision history, and change counts. | One synthetic CAR, then one amendment, with stored PDF text and a change diff. |
| `archive` | A dashboard request queues archive import. Each section writes a checkpoint for restart recovery. | One synthetic publication per section, four total. Verifies duplicate requests and the section checkpoints. |
| `archive-analysis` | The worker processes a bounded batch of pending archive rows using built-in summaries. | Analyses the four fixture rows and verifies their summary provider and count. |
| `monitor` | A manual dashboard request queues a monitoring cycle, separate from the worker's scheduled-cycle path. | Excluded. |
| `test-email` | A manual dashboard request queues a test notification. An interrupted send is failed on restart without replay. | A queued synthetic sentinel stays untouched. |
| `smtp-check` | A dashboard request queues verification of the SMTP connection. | Excluded. |

The workflow leaves email disabled when fixture settings enable it and uses the built-in engine when fixture settings select an external engine. A second unrelated queue sentinel stays queued. The application endpoints, regular job selection, and recurring workflow retain their current behaviour.

## Timeouts and resource bounds

The test verifies recoverable interrupted jobs return to the queue, stale queued comparisons expire with HTTP status 410, and a timed-out SQL statement rolls back to its savepoint. The local regression suite also verifies that a callback failure and a database-enforced session timeout leave no scratch schema behind. The Actions job has a five-minute cap and the scratch database session has statement and idle-in-transaction deadlines. The production worker still uses a runner deadline and a job admission budget. These checks do not simulate an actual hosted runner termination or add a per-job execution deadline to production.

Only one 40 MiB PDF is assembled. CAR and archive inputs are small fixtures, so no live DGCA documents are fetched. The PostgreSQL driver can transfer PDF bytes in hexadecimal form. Budget up to about 80 MiB of database read transfer for the full fixture, plus smaller metadata queries and writes. The test uses existing platforms and dependencies.

## Run after approval

1. Keep the repository variable `DGCA_MONITOR_ENABLED=false`. Reuse the existing `DEPLOYMENT_TEST_DATABASE_URL` secret and `DEPLOYMENT_TEST_NEON_HOST` and `PRODUCTION_NEON_HOST` variables from the monitoring smoke test. The test role needs permission to create temporary scratch schemas on `deployment-test`. [Monitoring smoke-test configuration](DGCA_MONITOR_SMOKE_TEST.md)
2. After the workflow is published to `main` and manual execution is approved, open **Actions → DGCA background-job smoke test → Run workflow**, select `main`, and dispatch once. [GitHub manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
3. Check the job log for `outcome: background-jobs-verified` with `bytes: 41943040`, `chunks: 14`, `archivePublications: 4`, `carRevisions: 2`, `rolledBack: true`, and `emailAttempts: 0`. No fixture records should appear in the Vercel application.

## Local verification

With `TEST_DATABASE_URL` set to a disposable loopback PostgreSQL database, run `npm test` from `backend/node_api` for the full suite. To run just this check, use `node --test test/background-job-smoke.test.js`. A local run exercises the same serverless routes and job code, with PostgreSQL on loopback. The approved Actions run will add a real Neon connection check. The test does not send requests through the deployed Vercel edge or verify live DGCA availability.
