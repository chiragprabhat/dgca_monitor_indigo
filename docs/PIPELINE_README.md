# DGCA Regulatory Intelligence

An Agentic AI-powered regulatory intelligence and monitoring system for the
Directorate General of Civil Aviation (DGCA), India. The system is designed to
detect new DGCA "What's New" publications, process the associated documents,
compare revised publications with previous versions, generate AI-powered
summaries and impact analysis, store the results, and notify stakeholders by
email — with a dashboard for browsing history and comparisons.

The project is built incrementally, phase by phase. See
[`CLAUDE.md`](CLAUDE.md) for full architecture notes.

## Status

**Phases 1–11 built and tested.** **The system is still not
production-ready** — Phase 10's scheduler must be started manually in a
terminal (no Windows Service/Task Scheduler wrapper), and Phase 11's real
SMTP email delivery is fully built and tested end-to-end but **not yet
activated** — by explicit choice when asked, `config/.env` still has
`EMAIL_PROVIDER=preview`/`TEST_MODE=true` (safe default) pending real SMTP
credentials whenever ready — see
[`notebooks/07_End_to_End_Workflow.ipynb`](notebooks/07_End_to_End_Workflow.ipynb)
Section 19,
[`notebooks/08_Local_LLM_Analysis.ipynb`](notebooks/08_Local_LLM_Analysis.ipynb)
Section 16,
[`notebooks/10_Automatic_Monitoring.ipynb`](notebooks/10_Automatic_Monitoring.ipynb)'s
final summary, and
[`notebooks/11_Real_Email_Notification.ipynb`](notebooks/11_Real_Email_Notification.ipynb)'s
final summary for the full honest breakdown of what's tested vs.
mocked/fallback vs. requires real credentials vs. still needed before
deployment.

- Phase 1 — Email generation & delivery pipeline (`preview`/`smtp` providers
  tested for real; Microsoft Graph implemented, not yet configured)
- Phase 2 — DGCA "What's New" scraper (tested against the live site)
- Phase 3 — PostgreSQL change-detection storage (new/updated/duplicate/failed
  scenarios all tested)
- Phase 4 — PDF download, validation, text extraction & OCR gating (tested
  against real DGCA PDFs, including genuinely scanned ones, plus synthetic
  empty/corrupted/password-protected fixtures)
- Phase 5 — Old-vs-new document comparison (whitespace-normalized diff
  engine + previous-version matching, tested against real DGCA text with
  constructed added/removed/modified/formatting-only variants; AI comparison
  implemented with a tested deterministic fallback)
- Phase 6 — AI executive summary & impact analysis (combines Phases 2-5 into
  a `DGCAUpdate`-ready result answering what/what-changed/why/when/who/
  action; tested against real Phase 3/4 data plus a synthetic revision pair
  exercising the full pipeline end to end)
- Phase 7 — End-to-end workflow: Phases 1-6 connected into one
  `run_dgca_pipeline()` orchestrator (via a new `pipeline/` package —
  Phases 1-6's already-tested logic extracted verbatim, not duplicated or
  redesigned). Tested against a controlled synthetic revision pair
  exercising every stage, duplicate-email prevention at both the
  single-publication and batch level, one malformed record failing without
  crashing the batch, and a real live scrape of the DGCA site run through
  the same orchestrator.
- Phase 8A — Real local LLM analysis via **Ollama** (`llama3.1:8b`), added
  as a free, zero-API-cost `AIAnalysisResult` provider alongside the
  existing OpenAI (implemented, not called by default) and deterministic
  fallback providers, selected by `LLM_PROVIDER=local|openai|fallback`
  (default `local`). Validated against real DGCA publication text with
  source-traceable key changes, and against a previous-version comparison.
  **No OpenAI API calls, paid or otherwise, are made anywhere in this
  project by default.**
- Phase 9 — Read-only **Streamlit dashboard** (`dashboard/app.py`) over the
  same PostgreSQL database, via read-only-enforced connections and existing
  `pipeline/storage.py` query helpers (no duplicated business logic). AI
  analysis for all real publications was persisted ahead of time (a local
  LLM call is too slow to run per page view) — 7 real publications got
  genuine local-LLM analysis, 1 fell back automatically after a transient
  LLM hiccup, 4 scanned documents were correctly marked degraded (no
  extracted text). The synthetic Phase 7 test fixture is shown only in a
  clearly labeled demo comparison view, never mixed with real data.
- Phase 10 — **Automatic monitoring scheduler**, running the existing
  `run_dgca_pipeline()` orchestrator on a configurable interval
  (`CHECK_INTERVAL_MINUTES`, default 60) via two new modules,
  `pipeline/orchestrator.py` (the orchestrator extracted from notebook 07
  so it's importable outside a notebook kernel) and `pipeline/scheduler.py`
  (`run_once()` / `run_scheduler()`). No pipeline stage was reimplemented.
  All 8 required scenarios were tested live against the real DGCA site:
  manual single-cycle run, a second consecutive run with zero
  re-processing, a synthetic new-publication fixture, an in-place
  content-change (update) fixture, duplicate prevention on a third
  identical run, error isolation (one malformed record fails alone), a
  deliberately-unreachable Ollama endpoint falling back to the
  deterministic analysis without crashing, and a scheduler start → run →
  wait → run → clean stop sequence. Email stayed in
  `EMAIL_PROVIDER=preview`/`TEST_MODE=true` throughout — no real send.
- Phase 11 — **Real email delivery**, wired via the existing SMTP provider
  (Microsoft Graph left implemented-but-inert — it needs an Azure AD app
  registration this project doesn't have). NEW vs UPDATED publications now
  render distinctly (dynamic `[DGCA][NEW]`/`[DGCA][UPDATED]` subject +
  version-comparison block for updates). Two real bugs were found and
  fixed while testing: a missing `pdf_url`/`dgca_url` used to render a
  broken `href="None"` link (now conditionally omitted); and an in-place
  content update could never actually produce a comparison (the prior text
  is now captured before it's overwritten). An explicit,
  non-automatic retry mechanism (`retry_failed_notifications()`) was added
  for genuinely failed sends — never invoked by the automatic scheduler, so
  a broken SMTP config can't generate an indefinite automatic retry storm.
  All 15 local test scenarios (preview generation, new/updated email +
  duplicate prevention for each, provider-failure isolation, malformed-record
  isolation, HTML/PDF-link validation, explicit retry, and a full
  real-local-LLM end-to-end run) passed against the real project database.
  **Real delivery itself was not activated** — by explicit choice when
  asked — `config/.env` still has `EMAIL_PROVIDER=preview`/`TEST_MODE=true`.

## Setup

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

Create a local `config/.env` and set `DATABASE_URL`. Add provider credentials before
attempting a live (non-`TEST_MODE`) send — see
[`notebooks/01_DGCA_Email_Pipeline.ipynb`](notebooks/01_DGCA_Email_Pipeline.ipynb)
for details. No configuration is required for the default (`preview`)
provider, or for Phases 2–9 (Phases 5, 6, and 7's AI steps also have tested
deterministic fallbacks when `OPENAI_API_KEY` isn't set).

**AI analysis (Phases 6-9)** defaults to a free local LLM via
[Ollama](https://ollama.com) — install it, then `ollama pull llama3.1:8b`
(~4.7GB), and it's used automatically (`LLM_PROVIDER=local`, the default).
No OpenAI key is required for this path, and none of this project's code
calls OpenAI unless `LLM_PROVIDER=openai` is explicitly set **and** a real
`OPENAI_API_KEY` is configured. If Ollama isn't installed/running, AI
analysis automatically and safely falls back to the deterministic template
analysis — nothing breaks. If Ollama's model runner ever falls back to
CPU-only inference (visible as very slow responses; check with
`nvidia-smi`), restarting the Ollama service usually fixes it.

OCR (Phase 4) needs the separate **Tesseract** binary, not just the Python
`pytesseract` package — install it yourself if you want OCR active (e.g. the
official [UB-Mannheim Windows build](https://github.com/UB-Mannheim/tesseract/wiki)
or `winget install UB-Mannheim.TesseractOCR`); without it, scanned documents
are still handled gracefully (`needs_ocr` status) rather than failing.

## Running the dashboard

```bash
.venv\Scripts\python -m streamlit run dashboard/app.py
```

Opens at `http://localhost:8501`. Read-only: it cannot write to
the PostgreSQL database (enforced by a read-only transaction). To refresh what it shows, re-run
`notebooks/09_DGCA_Dashboard_Design.ipynb` (or Phase 7's
`07_End_to_End_Workflow.ipynb`) to populate more/newer data, then reload the
page. As of Phase 10, the scheduler below also keeps this data current
automatically while it's running.

Six pages: **Overview** (summary stats), **Publications & Search**
(filter/search + CSV export), **Trends** (publications-per-day chart),
**Scheduler Health** (reads the scheduler's log file to infer whether it's
currently running, with cycle/error counts), **Email Previews** (browse the
locally-saved `.html` previews inline, without opening files manually), and
**Comparison (Demo)**.

If you edit any `pipeline/*.py` file while the dashboard is running,
restart it (stop and re-run the command above) rather than just reloading
the page — Streamlit hot-reloads `dashboard/app.py` itself, but Python's
module cache keeps the old `pipeline.*` code until the process restarts.

## Running the automatic monitor (Phase 10)

Runs the full pipeline unattended, on a timer (`CHECK_INTERVAL_MINUTES` in
`config/.env`, default 60):

```bash
.venv\Scripts\python.exe scheduler\run_monitor.py
```

Stop with **Ctrl+C** — it's caught cleanly, no partial writes are left
behind. To run exactly one cycle by hand instead of starting the loop:

```bash
.venv\Scripts\python.exe -c "from pipeline.scheduler import run_once; print(run_once())"
```

Email stays in `EMAIL_PROVIDER=preview`/`TEST_MODE=true` — every cycle
still only writes local `.html` previews under
`data/processed/email_previews/`, never a real send. See
`notebooks/10_Automatic_Monitoring.ipynb` for the full architecture
explanation and all 8 tested scenarios (new/updated/duplicate/error
isolation/Ollama-fallback/start-stop).

## Activating real email delivery (Phase 11)

Real SMTP delivery is fully built and tested but off by default. To turn
it on, edit `config/.env` (never commit real values — see
the settings below for a Gmail app
password, or Office 365 SMTP AUTH):

```
EMAIL_PROVIDER=smtp
TEST_MODE=false
SMTP_HOST=<your SMTP host>
SMTP_PORT=587
SMTP_USERNAME=<your SMTP account>
SMTP_PASSWORD=<an app password, not your normal password>
SMTP_USE_TLS=true
OUTLOOK_SENDER_EMAIL=<the sending account>
OUTLOOK_RECIPIENT_EMAIL=<the Outlook mailbox that should receive updates>
```

Then send exactly one test email to confirm delivery before trusting it
with genuine DGCA notifications:

```bash
.venv\Scripts\python.exe -c "from pipeline.config import load_config; from pipeline.email_pipeline import send_test_email; from pathlib import Path; c=load_config(Path('config/.env')); print(send_test_email(c, Path('data/processed/email_previews')))"
```

Real emails are sent only for genuinely new/updated publications — an
unchanged publication never re-triggers one, and a genuinely failed send is
never retried automatically (call `pipeline.scheduler.retry_failed_notifications()`
explicitly when you want to retry). See
`notebooks/11_Real_Email_Notification.ipynb` for the full architecture
explanation and all 15 tested scenarios.

## Running the notebooks

```bash
.venv\Scripts\python -m jupyter notebook notebooks/01_DGCA_Email_Pipeline.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/02_DGCA_Website_Monitor.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/03_Change_Detection.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/04_Document_Processing.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/05_Old_New_Comparison.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/06_AI_Analysis.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/07_End_to_End_Workflow.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/08_Local_LLM_Analysis.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/09_DGCA_Dashboard_Design.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/10_Automatic_Monitoring.ipynb
.venv\Scripts\python -m jupyter notebook notebooks/11_Real_Email_Notification.ipynb
```

Notebooks 1-6 are each independently runnable (no cross-notebook
dependencies) and demonstrate one phase in isolation. Notebooks 7-9 import a
`pipeline/` package (Phases 1-6's tested logic, extracted so it's reusable
rather than duplicated): notebook 7 runs the full pipeline — detect →
download/extract → compare → analyze → email → persist — through a single
`run_dgca_pipeline()` orchestrator; notebook 8 validates the local LLM
analysis provider specifically; notebook 9 persists AI analysis/comparison
results for the dashboard to read (a local LLM call is too slow to run live
per page view, so this population step is what makes a fast, read-only
dashboard possible).

With no `config/.env` present, everything runs safely with
`EMAIL_PROVIDER=preview`/`TEST_MODE=true`: emails render and save under
`data/processed/email_previews/` without contacting any real mail service.
Scraped snapshots go to `data/raw/`, downloaded PDFs and extracted text to
`data/documents/`, comparison results to `data/processed/comparisons/`, AI
analysis results to `data/processed/analysis/`, and all publication
tracking/state (including persisted AI analysis, as of Phase 9) to
the PostgreSQL database configured by `DATABASE_URL`. See the [cutover guide](DATABASE_MIGRATION.md).
