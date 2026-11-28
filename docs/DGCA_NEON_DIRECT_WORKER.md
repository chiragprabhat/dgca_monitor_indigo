# DGCA direct Neon worker

The Function handles the 30-minute schedule `7,37 * * * *` UTC. Vercel continues to serve the dashboard and API. GitHub stores the code and runs development tests. The original GitHub cron stays disabled and both GitHub activation flags stay false.

## Package and admission

Build from the repository root after installing the backend's locked dependencies. Pass the directory of the installed esbuild 0.28.2 package and an empty staging directory.

```powershell
node ops/neon-direct-worker-poc/build.cjs <esbuild-directory> <staging-directory>
node --check <staging-directory>/index.mjs
Compress-Archive -Path '<staging-directory>/*' -DestinationPath '<output-zip>'
```

The production archive contains `index.mjs`, `pdf.mjs`, `pdf.worker.mjs`, `schema.sql`, and `deployment.sql`. The package loader retains PDF.js as separate Node ESM files. Use the default builder mode for production. The optional `proof` mode targets only `deployment-test` and includes a synthetic scratch harness.

The production entry point requires the approved Neon branch, verified direct endpoint and TLS identity, an authenticated Neon event, a recent scheduled slot and saved basic summaries at a 30-minute interval. PostgreSQL session locks coordinate worker activity and the durable slot claim prevents a repeated invocation from running the queue twice. The worker defaults to email off and requires separate activation of real delivery.

## Separately approved canary

1. Review the candidate and record its ZIP checksum, app revision and known-good recovery manifest. Confirm available Neon Free compute, storage and egress, and verify the PostgreSQL endpoint's idle behavior.
2. Deploy to the approved production branch through the branch-scoped Neon Functions API with `NEON_WORKER_ENABLED=false`. Set `DGCA_MONITOR_ENABLED=false` and `EMAIL_NOTIFICATIONS_ENABLED=false`. Keep saved email disabled and the original GitHub cron disabled. The Function uses the branch's injected `DATABASE_URL_UNPOOLED`.
3. Create the `/trigger` schedule in its disabled state. Configure its exact ID as `NEON_WORKER_TRIGGER_ID`. For the four-slot canary set `NEON_WORKER_CUTOFF_UTC` a few minutes after the last approved slot. Check the active deployment and the disabled configuration before arming it.
4. With approval, set `NEON_WORKER_ENABLED=true` and enable only that trigger. Verify the four slots, monitoring logs, jobs, dashboard heartbeat, SMTP attempt count, PostgreSQL suspension, Function usage and project transfer. Include the first due CAR refresh. Use 80 CU-hours as a PostgreSQL warning threshold and 90 CU-hours as a stop threshold while running on Free. Review limits before a continuous rollout.

## Emergency stop and rollback

Disable the Neon trigger and verify that its next run is empty. Deploy the same known package with `NEON_WORKER_ENABLED=false`. A running invocation may finish work until its current deadline. Allow its database session and locks to close, then inspect the durable slot and job records before deciding whether recovery is needed.

Keep the original GitHub worker gated off. Preserve job progress, monitoring claims and any existing notification claims. The next approved slot recovers resumable interrupted jobs. Archive records and progress commit together in batches, CAR retains completed document reads, and uploads deduplicate by content hash. A timed-out monitor or email-capable job requires inspection before manual retry. Existing results can remain visible for up to 45 minutes after the most recent successful heartbeat.

## Initial monitoring-only rollout

Reuse the canary-verified ZIP on the production branch. Keep the trigger disabled while updating the Function configuration. Set `NEON_WORKER_ENABLED=true` with the existing trigger ID. Clear `NEON_WORKER_CUTOFF_UTC` explicitly with an empty value and verify the cutoff key is absent from the active deployment. Neon merges environment changes and retains unmentioned keys. Keep both GitHub flags false in both repositories, the original cron disabled and the private runner gated. Keep saved email disabled and leave SMTP credentials out of the Function. Verify the active deployment before enabling the existing trigger. Its first scheduled run must fall on a UTC minute ending in 07 or 37.

## Continuous production operation

The current production configuration is recorded under **Stage 2 production record**. Check the dashboard daily for the last successful heartbeat, the 30-minute interval and the next expected slot. The website derives that time from the cron and heartbeat freshness. Check the Neon trigger for the authoritative next run. The dashboard and idle CAR library pause polling in hidden tabs and refresh no more than every six minutes per visible view during normal operation. Job and CAR progress retain their faster status checks while work is pending.

Check Function logs and monitoring history daily. Each slot should account for all four sections and leave one successful monitoring log and one set of slot claims. A missing heartbeat, partial scrape, duplicate execution, unexpected write, unresolved delivery claim or persistent job error calls for investigation and an emergency stop if it cannot be explained promptly. Do not clear a durable claim to replay a slot. Check job state and committed progress before recovering interrupted work.

Record project usage daily during the initial observation period. The warning threshold calls for reviewing daily growth and reducing optional polling or test work. At the intervention threshold, disable the trigger using the emergency stop above and verify that no run remains active.

| Free-plan resource | Allowance | Warn at 75% | Intervene at 90% |
| --- | ---: | ---: | ---: |
| PostgreSQL compute | 100 CU-hours | 75 | 90 |
| PostgreSQL project storage | 1 GB | 0.75 GB | 0.90 GB |
| Public database transfer | 5 GB | 3.75 GB | 4.50 GB |
| Function active capacity | 10 Capacity-Hours | 7.5 | 9 |
| Function waiting capacity | 400 Capacity-Hours | 300 | 360 |
| Function invocations | 1,000,000 | 750,000 | 900,000 |

Use the Neon project metrics for quota checks. Where Function billing telemetry is unavailable, record the invocation count, aggregate wall time and process CPU separately. Aggregate wall time is a conservative planning proxy, and process CPU does not represent billable active Capacity-Hours. Review this gap before committing to a full month. See the [Neon Free plan and billing metrics](https://neon.com/docs/introduction/plans).

## Separately approved production email activation

### Stage 1 rollout record

On 27 November 2026, production Function `dgcaproduction` advanced from deployment `7` to `8` between slots using revision `a97bcefdf590557108149c5c308c66ec76f9d28f`. The ZIP SHA-256 was `a4dafc61d508df3c8b197925cafbd897d168d593e315cc7a4abcff1bea250ef8`. Rebuilding the five package files from the approved source produced matching hashes. The verified deployment `7` package remains the rollback artifact. Keep the existing schedule and slot claims if rollback is required.

The unchanged trigger ran at 21:37 IST and logged one successful invocation in 14.53 seconds. Monitoring log `32` and the heartbeat were recorded at 21:37:16 IST. Both durable slot claims matched. Each DGCA section returned ten listings and there were zero new publications. No jobs were processed and the CAR refresh was not due. Historical logs and publications, notifications, saved settings and delivery claims matched the pre-deployment snapshot. Saved email and the worker email flag stayed false. The Function had no SMTP secret or email cutoff, and the run recorded zero email activity.

The Neon control plane reported PostgreSQL idle at 21:43:39 IST and confirmed the next scheduled slot at 22:07 IST. The project counters showed 11.32 CU-hours and 448.11 MB of transfer. Production logical storage was 35.29 MB. Deployment `8` remained active.

### Stage 2 production record

On 28 November 2026, Vercel deployment `dpl_B6HXqo8h9rGmK6pF8dGh3RzU2J3M` was built from the same revision as the worker. Authenticated reads of settings, notification history and monitoring status passed on the immutable URL with email disabled. The dedicated alias API confirmed that `dgcamonitorindigo.vercel.app` moved from `dpl_Am1FVXrCpUHt8xd2WgBZbg2HhauF` to the verified deployment. The API queues recipient retry requests for evaluation by the worker.

Neon production Function `dgcaproduction` deployment `9` uses the Stage 1 ZIP and production branch `br-gentle-bread-beix3pqb`. Trigger `trigger-1058de33-7176-4c3b-8c05-2039d1f55a48` continues at minutes 07 and 37 each hour. The deployment supplied the Gmail app password and worker email permission before the authenticated Settings API enabled the saved permission. The eligibility cutoff is **2026-11-28T17:15:20.558Z** (22:45:20.558 IST). A read-only database check confirmed the opt-in, 41 unchanged historical updates, three unchanged notification records, zero claims and zero active jobs.

All four categories qualify: Tenders, Regulation, Guidance and Announcements. The minimum priority is low, which includes low, medium and high. An automatic alert requires a newly detected monitor-origin publication at or after the cutoff whose publication, detection and delivery dates agree in IST. The worker addresses the two approved saved recipients through Gmail using port 465 and certificate-verified TLS. No historical catch-up or automatic recipient retry is authorized.

Before activation, the project reported 45,986 compute seconds and 539,053,934 bytes of transfer for the usage period beginning November 23. The production branch reported 35,332,096 bytes of logical storage. Review project-wide storage in the Console, including other branches and restore history. The control-plane measurements do not include billed Function active or waiting Capacity-Hours.

The first email-enabled slot ran at 23:07 IST on November 28. Neon recorded one invocation and one completion. Monitoring log `83` recorded success at 17:37:18 UTC. The worker checked ten listings in each of the four sections and discovered zero new publications. The heartbeat identified Neon and both durable claims matched the 17:30 UTC slot. No jobs were processed or left active. Function wall time was 16.740 seconds, process CPU time was 1.875 seconds and RSS was 164,777,984 bytes. Historical update and notification fingerprints matched the preflight. The notification count remained three, with zero delivery claims and zero recipient journals. The first real regulatory delivery remains pending an eligible publication.

After the slot, project transfer was 539,884,112 bytes. Reported compute seconds and branch logical storage were unchanged at the measurement time. These are cumulative readings with reporting lag. The production database had returned to idle between configuration verification and this slot. Both temporary local credential files were removed and their absence verified. The required Gmail secret remains on the production Function.

### Stage 2 rollout procedure

1. Verify a recent successful production heartbeat, the verified backup, the two approved saved recipients, and the production Function and trigger identities. Confirm the Stage 1 deployment or its reviewed successor remains active. Keep saved `emailEnabled=false`. Preserve the existing trigger ID, 30-minute cron, `NEON_WORKER_ENABLED=true` and `DGCA_MONITOR_ENABLED=false`. Stage and verify the updated Vercel API if operator retries will be used. The older API does not pass through the retry request field.
2. After separate approval, configure `NEON_GMAIL_APP_PASSWORD` as a secret on the production Function. Set `EMAIL_NOTIFICATIONS_ENABLED=true` and an explicitly approved, canonical UTC `NEON_EMAIL_ACTIVATED_AT` with milliseconds, for example `2026-11-27T16:30:00.000Z`. Choose a time at or after the intended activation so existing queued email jobs and detected publications are ineligible. Keep saved email disabled while checking the deployment. Leave the GitHub worker variables and trigger unchanged.
3. Enable saved `emailEnabled` in the application only after verifying the worker configuration, recipient list, and cutoff. Leave `sameDayOnly` on. The Neon sender also enforces the IST day of detection and current IST day independently of that setting. Only a monitored publication detected at or after the cutoff can qualify. The automatic path also respects the configured categories and priority filter.
4. Observe the first eligible new publication. Confirm the journal outcome for each recipient and aggregate `sent` only when every original recipient is accepted. SMTP acceptance means the server accepted the message. Confirm inbox receipt separately if required. Use deployment-test fixtures and the existing accepted synthetic email evidence for verification.

### Emergency email-only stop

Set saved `emailEnabled=false` in Settings and verify the value. The worker rechecks that saved permission before SMTP submission. An attempt already submitted to SMTP may still finish. Between invocations, deploy the same package with `EMAIL_NOTIFICATIONS_ENABLED=false` and clear `NEON_GMAIL_APP_PASSWORD` and `NEON_EMAIL_ACTIVATED_AT` with empty values. Verify the next monitoring run and heartbeat. Keep `NEON_WORKER_ENABLED=true` and the schedule enabled. A later email restart needs a fresh cutoff and separate approval.

### Recipient reconciliation and retries

During daily review, compare the latest successful monitoring log with the scheduled slot and the worker heartbeat. For each new eligible publication, match its update ID to the recipient journal and notification history. If no publication qualifies, a successful scrape with unchanged notification history is expected. Investigate a partial result, missing heartbeat, unexpected recipient or attempted historical delivery before requesting any retry. Use the email-only stop for an unexplained send while leaving monitoring available.

The journal uses the existing `config` table with one `neon_email_delivery_v1:<update-id>` key per attempted publication. The history table contains a summary per attempt. The journal records accepted, rejected, pending and ambiguous states per recipient. Inspect it in an authorized read-only session.

```sql
SELECT key, updated_at, value::jsonb AS delivery
FROM config
WHERE key = 'neon_email_delivery_v1:' || $1;
```

An interrupted SMTP claim stays ambiguous. Review Gmail Sent, available SMTP evidence and inbox receipt before taking any manual reconciliation decision. Preserve the claim and record the evidence in the incident record. A missing inbox message alone is insufficient evidence for resending. Pending, ambiguous and accepted recipients are excluded from retries.

An operator may request one retry for definitively transient failures through the updated authenticated endpoint `POST /api/notifications/test/<update-id>` with JSON `{"retry":true}`. Wait at least five minutes, keep both email gates enabled, and retry within the same IST eligibility day. Only a still-configured recipient with a recorded transient rejection and exactly one prior attempt qualifies. Authentication failures and permanent rejections require investigation. Recovered interrupted email jobs fail closed and are never requeued automatically. Preserve historical notification rows and all original claims.

## Budget and notification checks

For 1,440 monthly slots, a five-minute idle tail at 0.25 CU adds 30 PostgreSQL CU-hours before worker runtime. Before the visibility optimization, the dashboard polled status every 30 seconds and updates every 60 seconds. Any sustained interval of database traffic below the suspend delay can keep the endpoint awake and drive the minimum to 180 CU-hours per month. Monitor account usage and endpoint state together.

Use the Function's measured process CPU and wall time for planning. Use Neon Billing for metered active and waiting Capacity-Hours where available. Treat public PDF downloads into the Function as ingress. Track API responses and database document streaming separately against the project transfer allowance. Future email validation requires separate authorization. Use an app password only with an approved SMTP configuration and retain the existing delivery-claim safeguards.

The deployment-test proof completed in 63.42 seconds and recorded 5.92 process CPU seconds and 231 MiB peak RSS. This includes diagnostic steps outside a normal slot. A planning case uses the measured 15.65-second live scrape plus PDF sample for all 1,440 slots and the 29.46-second recovered worker fixture for up to 720 hourly CAR opportunities. The fixture included archive work, so this covers additional queue load. Add four 30-second archive jobs and four 1.51-second large PDF jobs for a total of about 12.2 wall hours. Applying the complete 63.42-second proof to every slot yields 25.4 wall hours and 2.37 process CPU-hours. Actual Function billing remains a separate measurement.

With natural suspension at five minutes, an average of 20 to 60 extra database-active seconds per slot yields roughly 32 to 36 PostgreSQL CU-hours at 0.25 CU. An additional hour of dashboard activity per day can contribute up to 7.5 CU-hours at that size before accounting for overlap. A dashboard session can add another five-minute tail. In a later email-enabled scenario, 30 messages with 15 MiB attachments would use about 600 MiB of attachment transfer after Base64 encoding, plus message overhead. The email-disabled candidate sends zero messages.

The first November 27 idle observation coincided with successful, uncached dashboard requests. The follow-up found no idle transactions or leaked Function sessions after success, handled failure, a SQL timeout or a worker deadline. It also found two idle pooler sessions and an active physical replication slot. After the dashboard tabs and database clients closed, both endpoints reported idle by the 6-minute 15-second check and stayed idle through the 8-minute 42-second check. Vercel recorded zero dashboard API calls on the test deployment during that window. The project compute counter did not move in the sampled interval, so the CU estimates remain projections.

Between checks, use the control plane to confirm suspension without waking PostgreSQL. Treat the five-minute idle model as the baseline. At the measured observation bound of 6 minutes 15 seconds, 1,440 worker slots with 20 to 60 seconds of database activity would project about 40 to 44 compute-unit hours at the 0.25-CU minimum. Multiple visible sessions and active job polling can increase that total.
