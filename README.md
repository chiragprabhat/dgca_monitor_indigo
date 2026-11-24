# DGCA Regulatory Intelligence

Monitors the **What's New** section of the DGCA portal
(https://www.dgca.gov.in/digigov-portal/), stores each new publication, compares
revisions, writes AI summaries and impact analysis, and shows the results in
dashboards. Email alerts are optional and off by default.

The repository has two top-level folders:

| Folder | Contains |
|---|---|
| [`backend/`](backend/README.md) | Python pipeline (`pipeline/`), the monitor (`scheduler/`), notebooks, config, data, tests, `requirements.txt`, and the Node.js API (`node_api/`) |
| [`frontend/`](frontend/) | React + Vite web dashboard, and the Streamlit dashboard (`streamlit_dashboard/`) |

| Part | Folder | Port | What it does |
|---|---|---|---|
| Python backend | `backend/pipeline`, `backend/scheduler` | - | Scrapes DGCA, detects new/updated publications, reads PDFs, compares versions, analyses, writes email previews (real SMTP when enabled) |
| Node API | `backend/node_api` | 5000 | Checks DGCA every 15 minutes, summarises and prioritises each new publication, emails same-day alerts, serves `/api/*` |
| React dashboard | `frontend/` | 5173 | Web dashboard over the Node API |
| Streamlit dashboard | `frontend/streamlit_dashboard` | 8501 | Read-only view of the Python backend's results |

---

## Getting started

The API and Python pipeline use Neon PostgreSQL. Set `DATABASE_URL` before
starting either backend. See the [database setup and cutover guide](docs/DATABASE_MIGRATION.md).
For a hosted frontend and automated monitoring, see the [production deployment guide](docs/PRODUCTION_DEPLOYMENT.md).

Nothing in this repository installs software for you. Install what you need yourself:

### Python backend, Streamlit dashboard and notebooks

Needs Python 3.12. From `backend/`:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
# Create config\.env locally and set DATABASE_URL. Email defaults to preview.

python scheduler\run_monitor.py             # run the monitor (Ctrl+C to stop)
python -m unittest discover -s tests -t .   # set TEST_DATABASE_URL for database tests
jupyter notebook notebooks\01_DGCA_Email_Pipeline.ipynb
```

The Streamlit dashboard runs from the repository root:

```powershell
streamlit run frontend\streamlit_dashboard\app.py
```

`requirements.txt` is the only dependency file for everything Python. Scanned PDFs
also need the Tesseract OCR program on your PATH (optional; without it they are
marked `needs_ocr`).

### Node API and React dashboard

Needs Node.js 24 or newer. In two terminals:

```powershell
cd backend\node_api
# Create .env locally and set DATABASE_URL.
npm install
npm start                                    # http://localhost:5000
```

```powershell
cd frontend
npm install
npm run dev                                  # http://localhost:5173
```

The local Vite dashboard proxies API requests to Express on port 5000.
Keep the API terminal open: monitoring runs only while it is running.

---

## Configuration

### Dashboard Settings page

Most day-to-day options are changed in the dashboard under **Settings**. They're
saved in the database, take effect on the next check or alert, and override the
matching `.env` values:

- email alerts on/off, the **recipients** list, which **categories** to email,
  the **minimum priority** to email, same-day-only, and whether to attach the PDF
- the check interval (15 min, 30 min, 1 hour or 4 hours)
- the summary engine (automatic, Claude, local model or built-in)
- date format and desktop notifications (per browser)

Settings also has **Check DGCA now** and **Send test email** buttons, live
status for the sender, summary engine and PDF reading, and a CSV export.
Every change is recorded in the Activity Log.

The **sender account and all passwords/API keys stay in `backend\node_backend\node_api\.env`**. They are
never shown in or changed through the web page.

### API (`backend\node_backend\node_api\.env`)

| Setting | Default | Meaning |
|---|---|---|
| `EMAIL_NOTIFICATIONS_ENABLED` | `false` | **Master switch.** No email is sent unless this is `true`. |
| `EMAIL_SAME_DAY_ONLY` | `true` | Email only publications whose DGCA date is the day they were **detected** (India time) |
| `EMAIL_RECIPIENTS` | placeholders | Who receives alerts, comma-separated. Outlook / Office 365 addresses work. |
| `EMAIL_FROM` / `EMAIL_APP_PASSWORD` | placeholders | Gmail sender and a 16-character [Gmail App Password](https://myaccount.google.com/apppasswords) |
| `EMAIL_FROM_NAME` | `DGCA Regulatory Alerts` | Sender name shown in the inbox (the address is still the sending account) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | commented out | Send through another mail server instead of Gmail (e.g. Office 365) |
| `EMAIL_MAX_ATTACHMENT_MB` | `15` | Larger PDFs are linked instead of attached |
| `SUMMARY_PROVIDER` / `ANTHROPIC_API_KEY` | `auto` / empty | How summaries are written (see below) |
| `MONITOR_INTERVAL_MINUTES` | `15` | Minutes between checks |
| `MONITOR_START_HOUR` / `MONITOR_END_HOUR` | `0` / `23` | Daily monitoring window (India time) |
| `PORT` | `5000` | API port (the web dashboard expects 5000) |
| `HOST` | `127.0.0.1` | The API only accepts connections from this PC. Set `0.0.0.0` only if you deliberately want other PCs to reach it; they could then change Settings. |

Values in the first rows above are the starting defaults. Once you save the
Settings page, its values are used instead.

### Email alerts

Every 15 minutes the API checks the four What's New tabs. For each publication
it hasn't seen before, it:

1. downloads the PDF and reads its text,
2. writes a **summary**, key points, required action and any **deadline**,
3. assigns a **priority**:

   | Priority | Typical publications |
   |---|---|
   | **HIGH** | Draft and amended CARs, flight safety, operations, airworthiness, crew duty time, dangerous goods, aerodromes/NOTAMs, suspensions or bans, anything due within 7 days |
   | **MEDIUM** | Circulars, guidance, training, examiners, licensing and approval procedures |
   | **LOW** | Tenders, procurement, recruitment, internships, administrative notices |

4. emails it **only if its DGCA date is the day it was detected** (India time),
   with the PDF attached.

The subject starts with the priority (`[HIGH] DGCA Regulation: ...`), and HIGH
alerts are flagged as high importance in Outlook. A publication that appears on
the page with an older date is stored and shown on the dashboard, but not
emailed. The dashboard shows why, e.g. "not sent - published 13 Oct 2026, not
the day it was detected". Each publication is emailed at most once.

If the API stops partway through a check (PC asleep, window closed), the
publications it hadn't emailed yet are sent on the next check. That includes
the next day, because the date rule uses the day each one was detected. A
publication that was being sent at the moment the API stopped may arrive twice.

**To turn alerts on:** fill in `EMAIL_RECIPIENTS` and a sender (Gmail or
SMTP), set `EMAIL_NOTIFICATIONS_ENABLED=true`, and restart the API. To check
the result in Outlook, open DGCA Updates in the dashboard, expand a
publication, click **Preview email**, or send yourself a real one:

```powershell
# id from the dashboard's Preview email link, or from /api/updates
Invoke-RestMethod http://localhost:5000/api/notifications/test/<id> -Method Post
```

**Sending from an Outlook / Office 365 mailbox** (instead of Gmail): uncomment
the `SMTP_*` lines in `backend\node_backend\node_api\.env`. Your IT admin must enable *SMTP AUTH* for
that mailbox; many company tenants turn it off. Personal Outlook.com accounts
no longer accept password sign-in over SMTP, so use Gmail or a company mailbox
as the sender. Recipients can be any address either way.

**Summaries:** with `SUMMARY_PROVIDER=auto`, the API uses Claude (model
`claude-opus-5-5`) if `ANTHROPIC_API_KEY` is set. Claude reads the PDF itself,
so scanned and Hindi documents are summarised properly. That costs a few cents
per publication on your Anthropic account. Without a key, it uses a local
[Ollama](https://ollama.com) model if one is running. Otherwise it takes the
document's subject line and opening sentences. That built-in summary is rough,
and scanned PDFs get no summary, only the attachment. Priorities come from the
same rules in every mode unless the AI assigns them.

### Python backend (`backend\config\.env`)

Defaults to **preview mode** (`EMAIL_PROVIDER=preview`, `TEST_MODE=true`).
Emails are written to `backend\data\processed\email_previews\` instead of being sent.
AI analysis uses a local Ollama model by default (`LLM_PROVIDER=local`). See
`docs\PIPELINE_README.md` for SMTP/Outlook and LLM options.

---

## Using the system

- **Web dashboard** (http://localhost:5173):
  - **Overview:** top priorities, category counts (click one to filter), live system health
  - **DGCA Updates:** search, filter by category, priority or review status, summaries,
    email status, email preview, "what changed" and review tracking (open a row's Summary)
  - **Search Documents:** searches the full text of every stored PDF, not just titles
    (e.g. `EFB`, `fatigue OR FDTL`, `"flight duty period"`), with the matching passage
    highlighted. Scanned PDFs have no text and are matched by title only.
  - **Document Comparison:** compare two stored publications, or one with any dgca.gov.in PDF
    link, sentence by sentence. The **CAR Section 8 in force** tab compares any What's New
    publication with the Section 8 (Aircraft Operations) CAR currently in force (see below)
  - **Impact & Actions:** what each publication requires, by priority. Shows open items
    (new or under review) by default.
  - **Activity Log:** DGCA checks, emails sent, errors, settings changes and reviews, with filters
  - **Settings:** see above
  - The **bell** shows publications detected since you last opened it.
- **Check DGCA now** (instead of waiting for the schedule):
  ```powershell
  Invoke-RestMethod http://localhost:5000/api/monitor/trigger -Method Post
  ```
- **API endpoints:** `/api/health`, `/api/updates?limit=50` (add `&priority=high`
  or `&sort=priority`), `/api/updates/<id>/email-preview`, `/api/sections`,
  `/api/sections/<tenders|regulation|guidance|announcements>`,
  `/api/monitor/status`, `/api/monitor/logs`, `/api/notifications/config`,
  `/api/notifications/history`, `/api/search?q=EFB`, `/api/updates/<id>/revision`
- **Streamlit dashboard** (http://localhost:8501): empty until the Python backend
  has run once. Fill it by starting the monitor from `backend\`:
  ```powershell
  python scheduler\run_monitor.py
  ```
  (It runs continuously; stop it with `Ctrl+C`.) Then, from the repository root:
  ```powershell
  streamlit run frontend\streamlit_dashboard\app.py
  ```
  AI summaries need [Ollama](https://ollama.com) running with the model set in
  `backend\config\.env`.

---

## What the scraper captures

On every check it reads the full **More** list of each What's New tab
(**Tenders, Regulation, Guidance, Announcements**), about 10 current items per
tab with title, date and PDF link. If a "More" page can't be read, it falls back
to the 3 items on the home page. Publications are matched by DGCA's PDF id, so
the same document isn't stored twice when DGCA shows its title in Hindi on one
page and in English on another.

### DGCA archive (older publications)

Each tab's More page also has an **Archived** list going back to 2016, about
720 publications in total. In the dashboard go to **Settings → DGCA Archive →
Import DGCA archive** to bring them in for search, **Document Comparison**
(e.g. every revision of CAR 66) and **Impact & Actions**.

- Archived publications are **never emailed**. They are stored as "not sent -
  imported from the DGCA archive".
- Their PDFs are read slowly in the background (about 25 a minute, roughly 30
  minutes in all) so DGCA's server isn't overloaded. Progress shows in Settings,
  and the work resumes after a restart.
- They always get the built-in summary, so a bulk import never runs up AI costs.
- Run the import again at any time to pick up newly archived items. Only new
  ones are added.
- In DGCA Updates and Impact & Actions, use the "Current and archive" filter to
  show or hide them. Archived items carry an ARCHIVE badge, and the bell never
  counts them.

### What changed since the previous version

The CAR or circular number is read from each title (e.g. "CAR Section 3 Series C
Part I", "CAR 66", "OC 2 of 2020") and matched with the latest earlier version
stored, including the archive. The two PDFs are compared sentence by sentence.

- **Alert emails** include a "What changed since the previous version" section:
  sentences added and removed, the percentage unchanged, and the first key changes.
- In the dashboard, publications with an earlier version carry a **REVISION**
  badge. "What changed since the previous version?" shows the same summary, and
  **Open full comparison** opens both documents in Document Comparison.
- Running headers, page numbers and DGCA's address block are ignored. If the two
  versions differ almost entirely (e.g. a short amendment proposal compared with
  the full CAR), the email says so instead of listing noise.
- Matching is by number, so a publication with no CAR or circular number in its
  title (e.g. a brand-new CAR) has no previous version.

### Review tracking

Each publication has a review status: **New → Under review → Actioned → Not
applicable**, with the reviewer's name and a note (e.g. "OM Part A revision
raised"). Set it from DGCA Updates or Impact & Actions with **Update**.

- Every change is kept with its date and name (**History**, and the Activity Log
  under "Reviews"), so you can show an auditor what was done and when.
- Overview's "High Priority To Review" counts current high-priority items still
  new or under review.
- Unreviewed archive items show no status and are left out of the open list.
- The name is typed by the reviewer; there is no login, so anyone who can open
  the dashboard can set a review.

### CARs in force: Section 8 (Aircraft Operations)

The system reads DGCA's **Regulations and Guidance → Civil Aviation Requirements →
Section 8 - Aircraft Operations** table (Series A, B, C, D, F, H, O, S) and downloads the
PDF of every Part in force, in full. Revoked Parts are listed but have no document.

- **Document Comparison → CAR Section 8 in force:** pick a CAR to see the What's New
  publications about it (Tenders, Regulation, Guidance, Announcements, including the
  archive), then **Compare**. Document A is the CAR in force, Document B the publication,
  so green shows what a draft would add to the current rule. Any other publication can be
  chosen from the list under it.
- Publications are linked to a CAR by its number in the title (e.g. "Section 8 Series O
  Part II"), or, for titles without a number, by the CAR's acronym or subject (e.g. EFB).
- In DGCA Updates and Impact & Actions, linked publications have a **Compare with CAR ...
  in force** button.
- The dashboard follows DGCA's Section 8 page by itself: the list is checked shortly after
  the API starts and then every hour (only changed PDFs are downloaded again), and an open
  dashboard reloads it every 5 minutes. **Refresh from DGCA** checks at once.
  - New Parts and series are added.
  - Amended Parts (a new PDF) are re-read; the old text is kept and the change is measured
    ("274 sentences added, 166 removed").
  - Revoked Parts are greyed out; Parts DGCA no longer lists are marked **NO LONGER
    LISTED** (unless DGCA's page suddenly lists less than half of them, which is treated
    as a DGCA page fault).
  - Changed subjects or revision details are updated.
  Every change appears under **Recent changes on DGCA** in that tab and in the Activity Log
  (filter "CAR Section 8 changes").
- Long PDFs are read in full for comparisons (summaries use the first 30 pages).

## Security notes

- **Network:** the Node API and dashboards listen on 127.0.0.1 only; other PCs can't reach
  them. Outgoing connections go only to www.dgca.gov.in (HTTPS) and the configured mail
  server, plus, only if `ANTHROPIC_API_KEY` is filled in (empty by default), Anthropic's
  API for AI summaries, which receives the publication's title and text. The Python backend
  talks to a local Ollama by default and makes no OpenAI calls unless `LLM_PROVIDER=openai`.
  Certificate checks are never turned off.
- **Secrets:** passwords live only in `backend\node_api\.env` and `backend\config\.env`,
  which are gitignored and never shown in a dashboard.
- **Email safety switch:** the Python backend sends real email only with `TEST_MODE=false`
  *and* a configured provider; otherwise it writes HTML previews.
- **Documents:** PDFs are read as text only.
- **Read-only dashboards:** the Streamlit dashboard uses a read-only PostgreSQL
  transaction, so writes are rejected by the driver.

## Current limitations

- Built and tested on Windows only.
- The default Vite development setup reaches a local Express server on port 5000.
- No Windows Service or background task. The API, the Python monitor and the dashboards
  run only while their terminals are open.
- If DGCA changes its page layout, the scraper logs an error and stores nothing
  (it doesn't save page junk). Check the Activity Log.
- Each tab's current list holds about 10 items. If more than 10 appear in one
  tab between two checks, the extras go straight to DGCA's archive. They can be
  brought in with an archive import, but they won't be emailed.
- "Same day" compares the date DGCA prints on the item with the day it was
  detected. If DGCA dates an item yesterday but publishes it today, it is not emailed.
- Priorities are rule-based unless an AI summary is enabled. Treat them as
  triage, not a compliance decision.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pip install` fails with path errors | Windows' 260-character path limit. Use a short project path such as `C:\DGCA`, or enable Windows long-path support. |
| `npm install` fails with path errors | Same cause; move the folder to a short path. |
| Test email fails with `unable to verify the first certificate` | A company network is inspecting encrypted traffic with its own certificate. The Node API also trusts every certificate Windows trusts (read at startup; the API log shows "Trusting N extra certificate(s)"), so restart the API. If it still fails, ask IT to allow SMTP to smtp.gmail.com, or send through the company mail server with the `SMTP_*` settings. Set `USE_WINDOWS_CERTS=false` to turn this off. |
| Dashboard loads but shows 0 publications | Make sure the API window has no errors, then trigger a check (see above). |
| Streamlit dashboard says "No database yet" | Start the Python monitor once (`python scheduler\run_monitor.py` from `backend\`). |

---

## Project structure

```
backend/
  requirements.txt      all Python dependencies
  pipeline/             the Python package, one responsibility per sub-package
    paths.py            where config / database / documents / previews / logs live
    config.py           PipelineConfig + narrow *Settings protocols
    scraper/            DGCA "What's New" scraper (CategorySource strategies)
    storage/            PostgreSQL: schema, change detection, notifications, queries
    documents/          PDF download, validation, text extraction, OCR
    comparison/         old-vs-new diff, previous-version matching
    analysis/           AI analysis (providers: local Ollama, openai, fallback)
    email_pipeline/     email model, HTML rendering/validation, senders
    orchestrator/       per-publication stage sequence over injected services
    scheduler/          run_once(), run_scheduler(), retry_failed_notifications()
    utils/              retry_with_backoff, configure_logging
  scheduler/            run_monitor.py -- CLI entry point for the monitor
  notebooks/            phase-by-phase development notebooks
  tests/                unit tests (python -m unittest discover -s tests -t .)
  config/               local Python configuration (ignored by Git)
  data/ logs/          created and filled at runtime
  database/            PostgreSQL publications schema
  node_api/             Node.js API + scraper + scheduler (own package.json)
frontend/
  src/ public/ ...      React + Vite web dashboard
  streamlit_dashboard/  Streamlit dashboard (app.py + dashboard_ui/)
docs/                   architecture, design, flow and requirements notes
```

Never share your `.env` files. They hold passwords and API keys.
