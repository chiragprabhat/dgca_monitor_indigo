# DGCA Monitor production deployment

## Supported layout and limits

Deploy the React/Vite build to Vercel and connect it directly over HTTPS to a single long-running Express host. Express owns the existing Neon tables, CAR refresh, archive analysis, PDF processing, monitoring, and SMTP delivery. GitHub Actions supplies the scheduled triggers. No new hosted storage, AI provider, or paid service is configured.

- **Express on Vercel** cannot preserve the full API. Document Comparison accepts 40 MiB uploads. Vercel Functions cap requests at 4.5 MB by default, with a 20 MiB beta that still falls short. Archive and CAR jobs run after HTTP responses and depend on a continuously running process. Large comparisons and monitoring can exceed request timeouts. The backend refuses to start under Vercel rather than silently disabling these features. [Vercel Express](https://vercel.com/docs/frameworks/backend/express) · [Request limits](https://vercel.com/docs/errors/function_payload_too_large) · [Runtime limits](https://vercel.com/docs/functions/runtimes)
- **Storage** stays in existing systems. Express downloads and parses PDFs in memory and stores extracted text, metadata, history, and settings in Neon. Uploaded PDF bytes live only for the duration of processing. Give the Express log directory persistent disk space or collect stdout. The separate Python/Streamlit workflow reads and writes PDFs, extracted text, and email preview files under `backend/data/`. Keep it on a persistent volume or existing host if you use it. Streamlit requires a separate access gate before remote exposure.
- **Schedule capacity** must be confirmed before enabling. GitHub can delay or drop scheduled jobs, and schedules run from the default branch. Four triggers per hour means about 2,880 jobs in 30 days. Check the included Actions allowance for your repository type or use an existing approved self-hosted runner. Vercel Hobby is for personal, non-commercial use. Confirm your existing Vercel plan permits the intended use before deploying. [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) · [Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage) · [Vercel Hobby](https://vercel.com/docs/plans/hobby)

## 1. Configure the Express host

Use Node.js 24 and a host that can reach Neon, DGCA, and your configured SMTP and AI providers. Start one persistent Express process from `backend/node_api` with `npm ci` and `npm start`. Bind to loopback behind a TLS reverse proxy on the same host. The proxy must overwrite `X-Forwarded-Proto` with the connection scheme and keep the Node port inaccessible from the public network. Set proxy limits to allow 40 MiB PDF uploads, large comparison responses, and the full duration of a manual comparison or monitor request. Proxy or firewall rate limiting for repeated authentication failures is part of the production host setup.

| Variable | Use |
| --- | --- |
| `NODE_ENV` | Set to `production` to enforce HTTPS and operator authentication. |
| `HOST`, `PORT` | Use `127.0.0.1` and an internal proxy port, default `5000`. |
| `DATABASE_URL` | Existing **direct**, TLS-verified Neon URL. PostgreSQL session locks must stay on the same backend session. A Neon `-pooler` host is refused for monitoring. Use the same database branch the UI already uses. [Neon connection pooling](https://neon.com/docs/connect/connection-pooling) |
| `FRONTEND_URL` | Comma-separated allowed HTTPS origins, for example `https://monitor.example.org`. Supply exact origins without paths or trailing slashes. |
| `API_OPERATOR_USERNAME`, `API_OPERATOR_PASSWORD` | Operator credential for the dashboard API. Use a unique random password of at least 20 characters. |
| `MONITOR_SCHEDULER` | Set to `github` when Actions takes over. Default `local` retains the existing Express cron and startup check. |
| `MONITOR_TRIGGER_TOKEN` | Required in GitHub mode. Generate a separate random token of at least 32 characters and store the same value as a GitHub Actions secret. |
| `MONITOR_INTERVAL_MINUTES`, `MONITOR_INTERVAL_HOURS` | Existing defaults and fallback. Saved dashboard settings take precedence. The 15, 30, 60, and 240 minute dashboard options work in GitHub mode. Custom sub-hour settings must be multiples of 15 minutes in GitHub mode. |
| `MONITOR_START_HOUR`, `MONITOR_END_HOUR` | Existing inclusive IST monitoring window. Defaults are 0 through 23. |
| `SCRAPER_TIMEOUT_MS`, `SCRAPER_RETRY_ATTEMPTS` | Existing optional overrides for DGCA HTTP requests. |
| `LOG_DIR`, `LOG_LEVEL`, `USE_WINDOWS_CERTS` | Existing logging and Windows TLS configuration. Use a persistent writable log location if retaining file logs. |

Keep existing SMTP values on the Express host:

| Variables | Use |
| --- | --- |
| `EMAIL_NOTIFICATIONS_ENABLED`, `EMAIL_RECIPIENTS` (legacy `EMAIL_RECIPIENT`), `EMAIL_SAME_DAY_ONLY` | Alert defaults. Saved settings in Neon take precedence. Verify the saved recipient list before enabling live sends. |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_MAX_ATTACHMENT_MB` | Sender address, optional name, and existing attachment limit. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | Existing custom SMTP transport. Verify host reachability, TLS and permitted outbound ports from the chosen host. |
| `EMAIL_APP_PASSWORD` | Existing Gmail fallback credential when using the Gmail transport. Keep it on the host. |
| `SUMMARY_PROVIDER`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Existing summary configuration. If Ollama runs on the same host, the loopback default can stay. If it runs elsewhere, use an approved private address reachable from Express. GitHub and Vercel do not need access to Ollama. |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | Required only for existing Claude usage. Review the saved summary provider before enabling the monitor. Keep existing providers and billing choices. |

The API requires operator authentication for data, recipient settings, previews, uploads, and manual jobs. The workflow token permits only the scheduled trigger. Credentialed browser requests use exact CORS origins, and browser mutations enforce the origin. Authenticated responses are marked `no-store`. The operator credential provides access to the full dashboard. The app has no separate user roles, MFA, or identity-backed review attribution. Use existing organizational access controls if individual identities or permissions are required.

## 2. Configure the React project on Vercel

1. Import `dgca_monitor_indigo` with production branch `main`, root `frontend`, Vite framework, Node.js 24, build command `npm run build`, and output directory `dist`.
2. Set `VITE_API_BASE_URL` to the backend's public HTTPS URL ending in `/api`, for example `https://api.monitor.example.org/api`. This is public build configuration. Keep all credentials and `DATABASE_URL` out of Vercel frontend variables. Connect directly to Express so Vercel never proxies PDF uploads.
3. Prefer frontend and API domains on the same HTTPS site. Open the protected backend `/api/health` in the browser to establish the operator session, then open the frontend. Verify that the browsers your users use send the credential on API requests and can load email previews and CSV downloads. Restrict preview domains separately and avoid connecting untrusted previews to the production database.

Local Vite development and preview keep using the loopback API through the Vite proxy. A bare static deployment elsewhere must set the backend URL or supply an equivalent same-origin API proxy.

## 3. Enable GitHub Actions monitoring after verification

| GitHub setting | Value |
| --- | --- |
| Repository variable `DGCA_MONITOR_API_ORIGIN` | Backend HTTPS origin, without `/api`. |
| Actions secret `MONITOR_TRIGGER_TOKEN` | Same token as on the backend. |
| Repository variable `DGCA_MONITOR_ENABLED` | Leave unset until cutover. Set to `true` only after reviewing runner capacity and stopping competing scheduled monitors. |
| Repository variable `DGCA_MONITOR_RUNNER` | Optional label for an existing authorized runner. Defaults to `ubuntu-24.04`. |

Switch the Express host to `MONITOR_SCHEDULER=github` and restart it before enabling the repository variable. The workflow requests a check every 15 minutes. Express respects the saved interval and IST window. A durable PostgreSQL slot suppresses repeated triggers, and a session lock prevents concurrent scheduled checks, manual checks, and manual test sends. An acknowledgement means the job was accepted or skipped. The Activity Log records the actual outcome. A delayed trigger evaluates the current slot and does not replay missed slots.

Use only one production scheduler. The separate Python pipeline has its own `publications` state and can alert on the same DGCA notice. Keep it in preview mode if using it alongside the Express production monitor. For the Python/Streamlit workflow, the existing variables are `DATABASE_URL`, `CHECK_INTERVAL_MINUTES`, `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `EMAIL_PROVIDER`, `TEST_MODE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_USE_TLS`, `OUTLOOK_SENDER_EMAIL`, `OUTLOOK_RECIPIENT_EMAIL`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_CLIENT_SECRET`. Supply credentials only for the selected provider.

An automatic email attempt is recorded before contacting SMTP. If the process stops before recording the outcome, the next cycle will not resend automatically. An operator can inspect affected records with a read-only database query and reconcile them with SMTP history. Use the existing test-email action for a deliberate resend after confirming delivery status. SMTP does not provide an exactly-once guarantee.

```sql
SELECT id, title, email_delivery_started_at
FROM updates
WHERE email_delivery_started_at IS NOT NULL AND email_status IS NULL;
```

## 4. Verify before traffic and before enabling live alerts

Use a disposable database to test auth, PDF upload and comparison, settings, search, reviews, CAR refresh, archive resume, and scheduled retries. Use an approved test inbox for SMTP. On the production host, verify the existing Neon row counts and use PostgreSQL backups before changing the deployment. Starting the newer API adds a nullable delivery marker and a notification lookup index. It leaves existing records intact apart from the application's existing startup backfills. Coordinate cutover with older Express processes that do not honor the new lock and delivery marker.

From `backend`, run `python -m unittest discover -s tests -t .`. From `backend/node_api`, run `npm ci` and `npm test`. Set `TEST_DATABASE_URL` for database tests and use a disposable **loopback** PostgreSQL database for Express integration tests. From `frontend`, run `npm ci` and `npm run build`.
