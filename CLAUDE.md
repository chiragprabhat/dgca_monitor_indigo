# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

DGCA Agentic AI Regulatory Intelligence & Monitoring System — an incrementally-built
pipeline that will eventually monitor the DGCA "What's New" section
(https://www.dgca.gov.in/digigov-portal/), detect new publications, compare
revisions, generate AI summaries/impact analysis, store results, and notify
stakeholders by Outlook email with a Streamlit dashboard for browsing.

**Build discipline: phases are implemented one at a time and each must be
tested working before the next begins.** Do not jump ahead to a later phase
(document processing, comparison, dashboard, etc.) unless explicitly asked.
Current status: **Phases 1–11 are built and tested** (email pipeline, DGCA
scraper, change-detection storage, document processing, old-vs-new
comparison, AI analysis, end-to-end orchestration, a local LLM provider via
Ollama, a read-only Streamlit dashboard over persisted results, an
automatic scheduler, and — as of Phase 11 — real email delivery wired via
SMTP). **The system is explicitly not production-ready** — Phase 10's
scheduler must still be started manually in a terminal (no Windows
Service/Task Scheduler wrapper, no process supervisor), and Phase 11's real
SMTP delivery is fully built and tested but **not yet activated** — by the
user's own choice, `config/.env` still has `EMAIL_PROVIDER=preview`/
`TEST_MODE=true` (safe default), pending real SMTP credentials being
configured whenever the user is ready — see Phase 7's notebook Section 19,
Phase 8A's notebook Section 16, Phase 10's notebook's final summary
section, and Phase 11's notebook's final summary section for the full
honest status.

**Notebook numbering note:** the project brief's suggested file list named
slot 3 `03_Document_Processing.ipynb`, but the brief's own numbered phase
list defines Phase 3 as *Change Detection* and Phase 4 as *Document
Processing* — two different concerns needing independent testing. Numbering
here follows the phase list: `03_Change_Detection.ipynb` is Phase 3;
`04_Document_Processing.ipynb` (PDF download/OCR, not started) will be Phase
4, shifting the later notebooks down one from the brief's original suggested
names.

## Repository layout (restructured)

The repository was restructured into two top-level folders. **Everything below
that says `pipeline/`, `notebooks/`, `config/`, `data/`, `database/`, `logs/`,
`scheduler/` or `tests/` now lives under `backend/`**, and the Streamlit
dashboard (`dashboard/app.py` in the phase notes) is now
`frontend/streamlit_dashboard/`.

```
backend/       Python backend + Node API + notebooks (see Directory layout at the end)
frontend/      React/Vite web dashboard + frontend/streamlit_dashboard/
docs/          architecture / design / flow / requirements notes
```

**`backend/pipeline/` was refactored along SOLID lines.** The phase notes below
describe behaviour, which is unchanged (verified with an old-vs-new behaviour
snapshot plus `backend/tests/`), but the old single-file modules are now
packages. The import surface is the same -- `from pipeline import storage;
storage.ingest_publication(...)` still works because each package re-exports its
public API -- so notebooks 7-11 needed no edits:

| Old module | Now | Split into |
|---|---|---|
| `config.py` | `config.py`, `paths.py` | `PipelineConfig` + narrow `*Settings` protocols; `ProjectPaths` (one place for config/db/documents/preview/log locations) |
| `utils.py` | `utils/` | `retry.py`, `logging_setup.py` |
| `storage.py` | `storage/` | `connection`, `schema`, `ingestion`, `notifications`, `analysis_store`, `queries`, `repository` (`PublicationStore` protocol + `SqlitePublicationStore`) |
| `scraper.py` | `scraper/` | `constants`, `models`, `parsing`, `session`, `sources` (`CategorySource` strategies), `service` |
| `documents.py` | `documents/` | `models`, `download`, `validation`, `extraction`, `ocr`, `processor` |
| `comparison.py` | `comparison/` | `text_diff`, `versioning`, `models`, `fallback`, `openai_comparison`, `service` |
| `analysis.py` | `analysis/` | `models`, `text_hints`, `prompt`, `providers/` (`AnalysisProvider`: ollama, openai, fallback; registry), `service` |
| `email_pipeline.py` | `email_pipeline/` | `models`, `template`, `rendering`, `validation`, `senders/` (preview, smtp, graph), `factory` (registry + `route_for_test_mode`), `delivery_check` (`send_test_email`) |
| `orchestrator.py` | `orchestrator/` | `results`, `email_content`, `ports` (protocols), `adapters`, `processor` (`PublicationProcessor`), `runner`, `reporting` |
| `scheduler.py` | `scheduler/` | `cycle` (`run_once`), `loop` (`run_scheduler`), `retry`, `diagnostics` |

Extension points (open/closed): add an `AnalysisProvider` and call
`analysis.register_provider()`; add an `EmailSender` and call
`email_pipeline.register_sender()`; add a `CategorySource` to the scraper's
`DEFAULT_SOURCES`; add a dashboard `Page` to `dashboard_ui/views/__init__.py`.
`run_dgca_pipeline()` / `process_single_publication()` take an optional
`services=PipelineServices(...)` so every collaborator can be replaced (tests do).
The scheduler functions take `paths: ProjectPaths` (default `DEFAULT_PATHS`).

Behavioural notes from the restructure: `email_pipeline.test_email` was renamed
`delivery_check` (a `test_*.py` name is collected by test runners);
`check_email_configuration()` now returns `Dict[str, Any]` (it always returned
strings too). The Streamlit dashboard now shows a "No database yet" message
instead of a traceback when `backend/database/dgca_monitor.db` doesn't exist.

**Setup/launcher scripts were removed on purpose** (`setup.ps1`, `start_backend.ps1`,
`start_dashboard.ps1`, `SETUP_GUIDE.md`, the downloaded `tools/node`). The only
Python setup artifact is `backend/requirements.txt`; Node dependencies are
installed by hand with `npm install`. Do not recreate installer scripts.

The old Node.js API now lives in `backend/node_api/`, untouched. It is a
separate backend (Express, port 5000) that the React app in `frontend/` calls;
it is not part of the SOLID refactor.

## Environment & commands

- Python 3.12, project-local venv at `backend/.venv/` (not committed). Never
  install packages globally -- always use the venv's interpreter. Setup:
  `cd backend && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt`.
- `backend/requirements.txt` lists **direct dependencies only**. Don't overwrite
  it with `pip freeze`; add new direct dependencies to it by hand.
- Jupyter is **classic Notebook 6.5.7**, not JupyterLab -- JupyterLab's install
  fails on Windows when the repo path plus its deeply-nested hashed static-asset
  filenames exceed `MAX_PATH` (260 chars). The same limit breaks `streamlit` and
  `jedi` installs in venvs with very long paths: use a short path. Don't attempt
  to `pip install jupyterlab` unless Windows long-path support has been enabled
  first (registry change -- ask the user to do it, don't do it yourself).
- All commands run from `backend/` unless noted:
  - Tests: `.venv/Scripts/python.exe -m unittest discover -s tests -t .`
  - Monitor: `.venv/Scripts/python.exe scheduler/run_monitor.py`
  - Primary notebook: `.venv/Scripts/python.exe -m jupyter notebook notebooks/01_DGCA_Email_Pipeline.ipynb`
  - Execute a notebook headlessly: `.venv/Scripts/python.exe -m jupyter nbconvert --to notebook --execute --output <name>.ipynb notebooks/<name>.ipynb`
  - Streamlit dashboard (from the repo root): `backend/.venv/Scripts/python.exe -m streamlit run frontend/streamlit_dashboard/app.py`
  - Node API: `cd backend/node_api && npm install && npm start`; React app: `cd frontend && npm install && npm run dev`
- When generating/editing a notebook programmatically (rather than by hand),
  build it with `nbformat` (`nbf.v4.new_notebook/new_code_cell/new_markdown_cell`)
  in a throwaway script rather than hand-crafting the `.ipynb` JSON, and
  **compile-check every code cell's source with `compile()` before executing**
  -- nested triple-quoted strings across generator-script layers are an easy
  source of silent corruption.

## Architecture

**Primary implementation lives in Jupyter notebooks under `notebooks/`, not
`.py` files** (explicit project requirement) — one notebook per phase:
`01_DGCA_Email_Pipeline` (done), `02_DGCA_Website_Monitor` (done),
`03_Change_Detection` (done), `04_Document_Processing` (done),
`05_Old_New_Comparison` (done), `06_AI_Analysis` (done),
`07_End_to_End_Workflow` (done — connects Phases 1-6 via the `pipeline/`
package below), `08_Local_LLM_Analysis` (done — Phase 8A, validates a real
local LLM provider), `09_DGCA_Dashboard_Design` (done — Phase 9, populates
persisted AI analysis for the dashboard to read), `10_Automatic_Monitoring`
(done — Phase 10, documents and tests the scheduler), `11_Real_Email_Notification`
(done — Phase 11, documents and tests real SMTP email delivery).
`dashboard/app.py` and `scheduler/run_monitor.py` are the other two `.py`
files, out of technical necessity: Streamlit requires a script entrypoint,
and a long-running unattended process doesn't belong in a notebook kernel.

Target end-to-end flow (see the "FINAL SYSTEM ARCHITECTURE" section of the
original project brief for the full diagram):

```
DGCA website → monitor agent → new-publication detection → metadata
extraction → PDF download → text extraction → previous-version lookup →
old-vs-new AI comparison → impact analysis → AI summary → DB/memory →
Outlook email + dashboard
```

### Phase 1 — Email generation & delivery pipeline (built)

`notebooks/01_DGCA_Email_Pipeline.ipynb`. **Email generation is decoupled
from email delivery** so the pipeline never depends on Azure AD approval:
`DGCAUpdate` (pydantic) → `generate_ai_summary()` (OpenAI if
`OPENAI_API_KEY` configured, else a deterministic fallback template) →
`render_email_html()` (Jinja2, inline-CSS table layout, identical output
regardless of delivery provider) → `validate_email_html()` (confirms title,
category, date, summary, impact level, every key change/department/action,
and both links actually landed in the HTML) → dispatched through the
`EmailSender` interface.

`EmailSender` (ABC, `is_configured()` + `send()`) has three implementations,
selected by `EMAIL_PROVIDER`:
- **`preview`** (default) — writes the HTML to
  `data/processed/email_previews/`, no network call, always available.
- **`smtp`** — generic `smtplib`-based sender (stdlib only, no new
  dependency) for a local dev catcher (MailHog/Mailpit) or a real SMTP
  endpoint. Configured via `SMTP_HOST`/`PORT`/`USERNAME`/`PASSWORD`/`USE_TLS`.
- **`microsoft_graph`** — the planned production provider: `msal`
  confidential-client (OAuth2 client-credentials / app-only, `Mail.Send`
  application permission) → `POST /v1.0/users/{sender}/sendMail`. Fully
  implemented but inert without Azure config — **not a blocker for the rest
  of the project.**
- **`api`** — reserved, raises `NotImplementedError` if selected; a future
  subclass slots into `get_email_sender()` without touching anything else.

`TEST_MODE=true` (default) is the master safety switch: even if
`EMAIL_PROVIDER` is `microsoft_graph`/`smtp`/`api`, `send_dgca_notification()`
swaps in `PreviewEmailSender` before dispatch, so a real send only happens
with `TEST_MODE=false` **and** that provider's own config present. Config
loads from `config/.env` (gitignored) via
`load_config()` → `PipelineConfig`, with safe defaults for every field so the
notebook runs with no `.env` file at all. Secrets are never printed — only
`SET`/`MISSING` booleans are logged. To add a new provider: subclass
`EmailSender`, wire it into `get_email_sender()` — `render_email_html()` and
`validate_email_html()` never need to change.

### Phase 2 — DGCA "What's New" scraper (built)

`notebooks/02_DGCA_Website_Monitor.ipynb`. **No Playwright/browser automation
is used or needed** — confirmed by inspecting the live site first: three of
the four "What's New" categories (Regulation, Guidance, Announcement) are
backed by a genuine JSON API (`POST .../scan?...&actionVal=viewAllServiceForAJAX
&classification={category}`), and the fourth (Tenders) is server-rendered
HTML at `<div id="tenders">` on the homepage requiring a `localeChange` POST
first to get English text. A plain `requests.Session` reproduces both. PDF
links for every category resolve via
`Upload?flag=iframeAttachView&attachId={id}&baseLocale=en_US` (extracted from
the site's own `pdfDownload()` JS function). See the notebook's "Website
Inspection Findings" section for full detail — **do not assume this structure
is still current without re-inspecting the site**, per the project's own
resilience requirement.

Output is `DGCAPublication` (pydantic model: `source_id`, `title`, `category`,
`published_date` normalized to ISO-8601, `publication_url`, `pdf_url`, plus
raw/size metadata) saved as a timestamped JSON snapshot under `data/raw/`.
`source_id` is a stable dedup key (category + decoded attachment id) intended
for Phase 3's SQLite layer. Each category is scraped independently with its
own try/except so one failing/changed category doesn't abort the run — verify
this still holds if the scraper is modified.

### Phase 3 — Change detection / SQLite storage (built)

`notebooks/03_Change_Detection.ipynb`. Reads the latest snapshot from
`data/raw/` (Phase 2's output) rather than re-scraping live, keeping this
notebook independently testable. Schema exactly matches the brief:
`publications` table with `publication_id` (= Phase 2's `source_id`),
`content_hash` (SHA-256 of title+category+published_date+pdf_url — detects
DGCA revisions), `document_hash` (reserved for Phase 4, `NULL` until PDFs are
downloaded/hashed), `status` (`new`/`updated`/`processed`/`failed`),
`email_sent`/`email_sent_at`.

`ingest_publication()` classifies each record against the DB and never
raises — any failure is caught, logged, and returned as `IngestOutcome.FAILED`
without touching (or corrupting) an existing good row; `ingest_batch()` runs
this over a whole scrape so one bad record never aborts the rest.
`get_pending_notifications()` returns only `new`/`updated` rows with
`email_sent = 0` — this is the dedup mechanism that guarantees an unchanged
publication never re-triggers an email; `mark_for_resend()` is the explicit,
operator-triggered escape hatch for a deliberate re-send. All four required
test scenarios (fresh ingest, duplicate-prevention on re-ingest, update
detection via a mutated `pdf_url`, and a deliberately malformed record) are
demonstrated in the notebook against real Phase 2 data — verify these still
pass if the schema or ingestion logic changes.

**Not yet wired together:** this notebook loads a snapshot *file* — nothing
yet calls Phase 2's scraper and Phase 3's `ingest_batch()` back-to-back in
one run, or calls Phase 1's `send_dgca_notification()` for each pending row.
That glue is either a lightweight script or Phase 7's agentic orchestration —
don't assume it exists without checking.

### Phase 4 — Document processing (built)

`notebooks/04_Document_Processing.ipynb`. Per publication `pdf_url`:
download (with `retry_with_backoff`) → validate (magic bytes, then an actual
PyMuPDF open — catches truncated/corrupted files that pass the cheap check)
→ save to `data/documents/{publication_id}.pdf` → classify → extract.
Classification gives every brief-required failure mode its own
`DocumentStatus` value rather than one generic "failed": `success`,
`ocr_success`, `needs_ocr`, `empty`, `password_protected`, `corrupted`,
`download_failed`, `failed`.

**"Empty" is a blank page (no text, no images), not zero pages** — PyMuPDF
refuses to even save a genuinely zero-page document (`cannot save with zero
pages`), so the zero-page branch in `process_document()` is defensive/
unreachable in practice, not the real test case. "Scanned" is detected by an
avg-chars-per-page heuristic (`SCANNED_CHARS_PER_PAGE_THRESHOLD`), checked
*after* ruling out the blank-page case so a truly empty page never gets
misclassified as scanned.

**OCR is availability-gated, not assumed.** `pytesseract` is installed, but
the separate Tesseract *binary* is not (confirmed via `where tesseract`
before writing any code, and never silently installed — that's an external
executable, out of scope for this agent to install per its own operating
rules). `check_ocr_availability()` probes for it at notebook start and sets
`OCR_AVAILABLE`; scanned documents are OCR'd when it's `True` and marked
`needs_ocr` (not silently dropped, not faked as success) when it's `False`.
Install Tesseract yourself and re-run — no code changes needed.

Real DGCA data already includes genuinely scanned PDFs (several `Tender`
category documents extract to 0 characters via PyMuPDF despite having real
pages) — used directly as live test cases rather than synthetic fixtures.
Empty/corrupted/password-protected fixtures are generated with PyMuPDF in
the notebook itself (see its "Synthetic Test Fixtures" section for why real
examples of those three are impractical to source on demand).

Writes `document_hash` (SHA-256 of the raw PDF bytes) back into Phase 3's
`publications` table — closing the TODO Phase 3 left open — but **only**
that column; Phase 3's notification-lifecycle fields (`status`, `email_sent`,
...) are never touched from this notebook.

### Phase 5 — Old-vs-new comparison (built)

`notebooks/05_Old_New_Comparison.ipynb`. Two independent pieces:

1. **Previous-version identification** — `find_previous_version()` matches
   within the same `category` after stripping revision-style suffixes
   (`normalize_title_for_matching()` removes "Revision N"/"Amendment
   N"/"Issue N") and comparing similarity with `difflib.SequenceMatcher`
   (threshold 0.85). Read-only against Phase 3's DB — never writes to
   `publications`. DGCA's "What's New" listing shows only current state, so
   real scraped data has no genuine revision pair to test against — verified
   this correctly returns `None` on real data, and correctly matches a
   seeded synthetic pair in an in-memory DB.

2. **Diff engine + AI comparison** — `diff_documents()` splits text into
   sentence-level units *after* collapsing all whitespace
   (`normalize_for_diff()`), which is what keeps PDF line-wrap artifacts from
   ever becoming reported diff hunks (verified: a formatting-only variant of
   real DGCA text produces zero changes, `overall_change_level="NONE"`) —
   don't reintroduce paragraph-based or line-based splitting without
   preserving this normalize-before-split ordering. `generate_ai_comparison()`
   follows the exact same optional-LLM pattern as Phase 1's summary: OpenAI
   if `OPENAI_API_KEY` configured (not the case here), else
   `_fallback_comparison()` builds the identical `ComparisonResult` schema
   deterministically from the diff, logged clearly as a fallback.

`ComparisonResult` matches the brief's JSON schema exactly:
`overall_change_level`, `total_changes`, `added`/`removed`/`modified`,
`key_changes`, `effective_date`, `operational_impact`,
`impacted_departments`, `recommended_actions` — with `"Not specified in the
publication."` used whenever information genuinely isn't available, per the
brief's explicit instruction never to invent regulatory requirements.

### Phase 6 — AI analysis (built)

`notebooks/06_AI_Analysis.ipynb`. Closes the loop: pulls a publication's
Phase 3 DB row + Phase 4 extracted text + (if any) a Phase 5-style
comparison against its previous version, and produces `AIAnalysisResult`
(`summary`, `key_changes`, `effective_date`, `impact_level`,
`impacted_departments`, `recommended_actions`) — which maps directly onto
Phase 1's `DGCAUpdate` via `build_dgca_update()`.

**Self-contained, mirrors Phase 5's diff/comparison logic locally** (same
convention as every notebook in this project) rather than importing across
notebooks — keep `05_Old_New_Comparison.ipynb` and this notebook's Section 5
in sync if the diff engine changes. Same for `DGCAUpdate`: reproduced here
verbatim from Phase 1's schema specifically so this notebook can prove its
own output actually validates against what Phase 1 expects, without
duplicating Phase 1's email-rendering code.

`generate_ai_analysis()` follows the same honest OpenAI-or-fallback pattern
as every other AI step in this project (Phase 1's summary, Phase 5's
comparison). The deterministic fallback distinguishes four situations
explicitly: previous version with detected changes, previous version with
no substantive changes, no previous version (first-time publication), and a
fully degraded path when Phase 4 produced no extracted text at all (e.g.
`needs_ocr`) — verify all four still behave correctly if this logic changes.
`extract_effective_date_hint()` is a best-effort regex heuristic for the
no-API-key fallback only (real text example: captures "FORTHWITH F" from
"EFFECTIVE: FORTHWITH F.No..." — imperfect but conveys the key info; the
real LLM path does this properly).

**Not wired live**: this notebook reads already-persisted Phase 3/4 data and
writes a `DGCAUpdate` JSON to `data/processed/analysis/` — it does not call
Phase 1's `send_dgca_notification()`. Chaining Phase 2 → 3 → 4 → 5 → 6 → 1
into one live run is explicitly Phase 7's job.

### Phase 7 — End-to-end workflow (built)

`notebooks/07_End_to_End_Workflow.ipynb` + a new **`pipeline/` Python
package** at the project root. This is the one deliberate exception to
"notebooks stay independent, no cross-notebook imports": connecting Phases
1-6 into one orchestrator without duplicating their business logic required
making that logic importable, so each phase's already-tested functions were
extracted **verbatim** (not redesigned) into `pipeline/{config,storage,
scraper,documents,comparison,analysis,email_pipeline,utils}.py` — see
`pipeline/__init__.py` for the module map. **Notebooks 1-6 themselves are
untouched** and still run standalone exactly as before (verified after this
extraction); they remain the tested record of each phase. If you change
business logic, decide deliberately whether to change it in the phase
notebook, the `pipeline/` module, or (usually) both — they're no longer
guaranteed to be identical unless kept in sync by hand.

One behavior change worth knowing: `pipeline.analysis.generate_ai_analysis()`
takes the *full* `pipeline.comparison.ComparisonResult` directly, instead of
the trimmed `ComparisonSummary` Phase 6's notebook had to invent solely
because it couldn't import Phase 5. Same fields used (`overall_change_level`,
`total_changes`, `key_changes`), so behavior is identical — just one less
duplicated type now that a real import is possible.

`run_dgca_pipeline()` is the single orchestrator entry point. Per
publication it runs: detect (Phase 3 `ingest_publication` — this is also
where duplicate-email prevention happens, since an `UNCHANGED` publication
returns immediately, before any email is generated) → download+extract
(Phase 4 `process_document`) → previous-version lookup + diff (Phase 5) →
AI analysis (Phase 6) → build `DGCAUpdate` (new glue code, defined in the
notebook, not the package — the only genuinely new logic here) → render +
validate email (Phase 1) → dispatch via `EmailSender` (Phase 1) → persist
status (Phase 3 `mark_email_sent`/`mark_failed`). Every stage is wrapped so
one publication's failure is caught, logged with the exact stage it failed
at, and returned as a structured result — it never aborts the batch loop.

No LangGraph: this is a linear per-publication pipeline with no cycles or
multi-agent branching, so a graph orchestration framework would add
dependency/complexity without real benefit — evaluated and documented as
such in the notebook's Section 2, not silently skipped.

**Shared state note:** `run_dgca_pipeline()` writes real rows into
`database/dgca_monitor.db` (including a controlled test's `e2e-test-*` rows)
and, when run against the live site, real status updates to real
publications. Phase 3's notebook, if re-run, still wipes and recreates this
same database file for its own test reproducibility (pre-existing behavior
from when Phase 3 was built, unrelated to Phase 7) — expected, not a bug,
but worth knowing before re-running Phase 3 casually.

**Still not production-ready** — no scheduler, no real credentials
configured for any provider, AI steps ran in fallback mode (no
`OPENAI_API_KEY`), and only a single synthetic revision pair was used for
the controlled test rather than a large real sample. Full list in the
notebook's Section 19.

### Phase 8A — Local LLM analysis provider (built)

`notebooks/08_Local_LLM_Analysis.ipynb`, plus edits to `pipeline/config.py`
and `pipeline/analysis.py`. Adds a third `generate_ai_analysis()` provider —
a free local LLM via **Ollama** — selected by `config.llm_provider`
(`"local"` | `"openai"` | `"fallback"`, default `"local"`). This was a
deliberate cost-avoidance choice for development: **no OpenAI API calls,
paid or otherwise, happen anywhere in this project by default.**

`generate_ai_analysis(row, extracted_text, comparison, config)` keeps its
exact Phase 7 signature and still returns the same `AIAnalysisResult` —
Phase 7's orchestrator needed zero changes. Internally it now dispatches:
`"local"` → `_try_local_analysis()` (Ollama `/api/chat`, `format: "json"`)
→ on any failure, automatically falls back to `_fallback_analysis()`,
logged; `"openai"` → `_try_openai_analysis()` (the original Phase 6/7 code,
completely unmodified, just no longer the default — still returns fallback
immediately if `OPENAI_API_KEY` isn't a real key, **before** constructing an
OpenAI client, so selecting this provider without a real key never reaches
the network layer); `"fallback"` → skips LLM calls entirely. All three share
one `_build_analysis_prompt()` so their instructions (and therefore output
schema and "never invent, use 'Not specified in the publication.'" rules)
never drift apart.

**A real, reproducible instability was found and handled, not papered
over**: Ollama's model runner (llama.cpp) occasionally crashes mid-request
under JSON-grammar-constrained decoding (`"Unexpected empty grammar stack
after accepting piece"`), returning HTTP 200 with an empty/stub body before
eventually surfacing HTTP 500. Ollama respawns the runner automatically but
reloading the model takes several seconds. `_call_ollama_once()` now treats
an empty response body as a failure, and `_generate_via_ollama()` wraps it
in `retry_with_backoff` with a 10s base delay specifically sized to survive
that respawn window (confirmed empirically: 2s/4s delays were too short and
still failed; 10s recovers reliably) — this is a real fix to observed
flakiness, not a synthetic test.

**Model recommendation:** `llama3.1:8b` (Q4_K_M, ~4.7GB) was chosen for the
target hardware (RTX 4050 laptop, 16GB RAM) as a balance of accuracy/speed;
`qwen2.5:7b` was noted as a strong alternative if JSON fidelity ever proves
inconsistent. **Ollama itself was never installed by this agent** — an
external executable, same category as Tesseract in Phase 4 — the user
installed it and pulled the model themselves after being given exact
instructions and a disk-size estimate up front.

**Security discipline for this phase:** the real `OPENAI_API_KEY` the user
placed in `config/.env` was never read into any tool call, print, or log
throughout this phase — new config vars were added via `grep -c` (existence
checks only) and a `cat >> config/.env << EOF` append, never a full file
read. Verified in the notebook itself (Section 14): `.gitignore` coverage,
no API-key-shaped string in any notebook/log/README file.

### Phase 9 — Streamlit dashboard (built)

`notebooks/09_DGCA_Dashboard_Design.ipynb` + `pipeline/storage.py` additions
+ `dashboard/app.py`. The dashboard is **read-only**: it opens
`storage.get_readonly_connection()` (SQLite `mode=ro` URI — writes are
rejected at the driver level, not just by convention) and calls only
`storage.get_summary_stats()` / `get_publications()` / `get_publication_by_id()`
— no query or business logic lives in `dashboard/app.py` itself.

**Why a population step exists at all**: a local LLM call takes 60-90s, far
too slow to run per page view, so `publications` gained nullable columns
(`ai_summary`, `key_changes_json`, `impact_level`, `comparison_summary_json`,
etc. — see `ANALYSIS_COLUMNS`) that Phase 9's notebook fills in ahead of
time by calling `pipeline.analysis`/`pipeline.comparison` exactly as Phase
8A left them (no changes to that architecture). `ensure_schema_migrations()`
adds these columns to an already-existing database via `ALTER TABLE`,
additively — every pre-Phase-9 column, row, and function is untouched.
Real DGCA publications and the Phase 7 synthetic test fixture
(`e2e-test-*`) are populated the same way but kept visually separate:
`get_publications()` excludes the `e2e-test-*`/`test-*` prefix by default,
and the dashboard's Comparison page only ever shows that fixture, behind an
explicit "Development / Demo" warning banner.

**Real-world flakiness surfaced here too, and was handled, not hidden**:
during the population run, Ollama's model runner fell back to CPU-only
inference (0% GPU utilization) after an earlier crash — traced with
`nvidia-smi` and `/api/ps`, fixed by restarting the Ollama service (not code
changes), which the notebook and this file document rather than silently
omit. One real publication's local-LLM call still failed and fell back to
`analysis_mode="fallback"` even after the fix, exactly the safety net
Phase 8A built.

Dashboard sections map directly to `pipeline/storage.py` functions (see the
notebook's Section 1 table): Overview → `get_summary_stats()`; Latest
Publications + Search/Filters → `get_publications()` (every filter is a SQL
`WHERE` clause, not re-implemented in Streamlit); Publication Detail +
Document Actions → `get_publication_by_id()`, with `publication_url`/
`pdf_url` rendered exactly as stored, never constructed; AI Analysis →
`analysis_mode` always shown as a visible badge next to the content
(`ai-local` / `ai-openai` / `fallback` / `degraded`), never hidden.

**Post-Phase-11 dashboard enhancement** (user-requested, not part of the
original phase plan — email activation is on hold while this happens): four
new pages added to `dashboard/app.py`, still fully read-only, still no
duplicated business logic. `pipeline/storage.py` gained one new query
helper (`get_publication_counts_by_day()`, same "all filtering/grouping in
SQL" convention as `get_summary_stats()`/`get_publications()`).
- **Trends** — a day-by-category bar chart of publications discovered,
  from the existing `first_seen_at` timestamp (no new column).
- **Scheduler Health** — reads the scheduler's own log file
  (`logs/scheduler_*.log` in production, falling back to the dev/test log
  from `10_Automatic_Monitoring.ipynb` if the scheduler has never been run
  unattended yet) and infers cycle count / error count / last-activity time
  / a "likely running vs likely stopped" status from log timestamps —
  explicitly labeled as inferred from logs, not a live process check.
- **Email Previews** — browses the local `.html` files
  `PreviewEmailSender` already writes, rendered inline
  (`st.components.v1.html`), with a checkbox to include/exclude Phase
  7/10/11's synthetic test fixtures. **Bug found and fixed**: the
  fixture-exclusion filter initially checked for `e2e-test`/`test-` in the
  filename, but the preview filename slugs the email *subject* (the
  publication title), not the `publication_id` — none of them actually
  contain that substring, so the filter silently filtered nothing. Fixed to
  match on `synthetic` (the word every Phase 7/10/11 test-fixture title
  actually contains).
- **CSV export** on Publications & Search — `st.download_button` over the
  currently filtered result set; purely client-triggered, no server-side
  write.

Also: a stray Streamlit process left running from an earlier session had
Python's module cache holding a stale `pipeline.storage` (missing the new
`get_publication_counts_by_day()`) even though Streamlit hot-reloads
`app.py` itself on save — restarting the process (not just reloading the
page) was required, worth knowing for future `pipeline/*.py` edits while
the dashboard is running.

### Phase 10 — Automatic monitoring & scheduler (built)

`notebooks/10_Automatic_Monitoring.ipynb` + two new `pipeline/` modules +
`scheduler/run_monitor.py`. Adds a timer around the pipeline; **no scraper,
storage, comparison, AI analysis, or email logic changed** in this phase.

- **`pipeline/orchestrator.py`** — `run_dgca_pipeline()`,
  `process_single_publication()`, and their result dataclasses, extracted
  **verbatim** from `notebooks/07_End_to_End_Workflow.ipynb` (the same
  "extract into an importable module" move Phase 7 made for Phases 1-6,
  applied here to Phase 7's own orchestrator — a scheduler running as a
  plain process needs an importable function, not a notebook's kernel
  namespace). Notebook 07 itself is untouched. Two small, deliberate,
  additive differences from the notebook 07 version (documented in the
  module's own docstring): (1) `documents_dir`/`preview_dir`/`ocr_available`
  are explicit parameters instead of notebook globals; (2)
  `process_single_publication()` now also calls
  `storage.save_analysis_result()` (Phase 9's own function) right after AI
  analysis is generated, persisting it inline. Notebook 07 never did this —
  Phase 9's dashboard only had real data because its own notebook separately
  recomputed and persisted analysis as a **manual, one-off population
  step** run *after* Phase 7. That doesn't generalize to unattended
  scheduling: Phase 10's whole point is new/updated publications appearing
  on the dashboard with nobody re-running a population notebook by hand, so
  persistence now happens as part of the pipeline run itself, using the
  exact function Phase 9 already built. `PublicationPipelineResult` also
  gained `outcome` (`new`/`updated`/`unchanged`/`failed`, from
  `storage.IngestOutcome`) and `analysis_mode`, so callers can report
  new-vs-updated counts and real-vs-fallback analysis separately — the
  notebook 07 version only tracked the coarser `status`.
- **`pipeline/scheduler.py`** — genuinely new logic, but small:
  `run_once()` runs exactly one monitoring cycle (calls
  `run_dgca_pipeline()`, logs structured progress, returns a result dict
  with `new_publications`/`updated_publications`/`processed`/`skipped`/
  `failed`/`analysis_modes`/`errors`) and `run_scheduler()` (loops
  `run_once()` on `config.check_interval_minutes` apart, stoppable via
  `KeyboardInterrupt` or a `threading.Event` passed as `stop_event`). Never
  raises out of `run_once()` — any unexpected failure becomes a
  `{"status": "error", ...}` result instead of crashing the loop.
  **Importing this module starts nothing** — no thread, loop, or DB
  connection — only calling `run_once()`/`run_scheduler()` explicitly does;
  verified in the notebook's Section 2.
- **`CHECK_INTERVAL_MINUTES`** (default `60`) — new field on
  `PipelineConfig` (`pipeline/config.py`), sourced from `config/.env`/
  environment via `load_config()`, documented in `pipeline/config.py`.
  Never hardcoded in the scheduler; tests override it via an explicit
  `run_scheduler(check_interval_minutes=...)` parameter instead of
  mutating the configured default.
- **`scheduler/run_monitor.py`** — the one new plain-script entry point
  (same justification as `dashboard/app.py`: a notebook kernel is a poor
  home for a long-running unattended process). Contains no pipeline logic
  of its own — it only calls `configure_logging()` then
  `pipeline.scheduler.run_scheduler()`. Run with
  `.venv\Scripts\python.exe scheduler\run_monitor.py`; stop with Ctrl+C.

All 8 required scenarios were tested live against the real DGCA site in
`notebooks/10_Automatic_Monitoring.ipynb`: manual `run_once()`; a second
consecutive run against unchanged live data (0 new/updated); a synthetic
new-publication fixture (A,B,C → A,B,C,D, D detected new); an
in-place content mutation on an existing fixture (detected as `updated`,
not a new row); duplicate prevention (same batch re-run a third time, 0
new/updated); error isolation (a record missing the required `title` field
fails alone, two valid records in the same batch still succeed); Ollama
made deliberately unreachable (`ollama_base_url` pointed at a closed local
port — the real Ollama service was never touched) → correctly falls back
to `analysis_mode="fallback"`, never reported as real analysis, no crash;
and scheduler start → multiple short-interval cycles → clean stop via
`stop_event`, verified via `threading.Thread.is_alive()`. Every test's real
JSON result and log output is preserved in the executed notebook. A live
scrape confirmed all four scraper categories (`Regulation`, `Guidance`,
`Announcement`, `Tender`) are checked every cycle.

**Not done in this phase, by explicit instruction:** no real Outlook/SMTP
delivery (still `EMAIL_PROVIDER=preview`, `TEST_MODE=true`); no OpenAI
calls; no Azure; no OCR changes; no process supervisor, Windows Service, or
Task Scheduler wrapper around `scheduler/run_monitor.py` (it must be
started manually and left running in a terminal for continuous operation);
no heavyweight orchestration framework (Airflow/Celery/Docker/Kubernetes/
LangGraph) — a plain Python loop with `time.sleep()` was judged sufficient,
per the phase's own instruction.

### Phase 11 — Real email notification (built, not yet activated)

`notebooks/11_Real_Email_Notification.ipynb` + targeted additions to
`pipeline/email_pipeline.py`, `pipeline/orchestrator.py`, and
`pipeline/scheduler.py`. Wires the existing, already-tested `EmailSender`
abstraction (Phase 1) to real delivery — **no email logic was duplicated or
redesigned**; every change extends the single existing implementation.

**Provider: SMTP**, not Microsoft Graph — chosen because it needs no Azure
AD app registration/admin consent (Graph does), is already fully
implemented, and can deliver to any real Outlook/Microsoft 365 mailbox as
recipient regardless of which account sends. `docs/PIPELINE_README.md`
documents two concrete real-provider examples (Gmail app password,
Office 365 SMTP AUTH).

**Email content additions** (`pipeline/email_pipeline.py`): `DGCAUpdate`
gained `is_update`/`previous_title`/`overall_change_level`/`added_changes`/
`removed_changes`/`modified_changes`/`comparison_explanation` (all optional,
default empty/None) — `render_email_html()` shows a new "UPDATED
PUBLICATION — VERSION COMPARISON" block only when `is_update` is True, so a
NEW-publication email is completely unaffected. `validate_email_html()`
checks these fields only when `is_update` is True, same pattern as every
other conditional field it already checked. The dead `href="#"` "Open
Dashboard (Phase 8)" placeholder link was removed, and "View DGCA
Publication" renamed to "View on DGCA Website" per the phase's content
spec. **Bug found and fixed during testing**: the DOCUMENT LINKS buttons
originally rendered unconditionally — Jinja2 renders `None` as the literal
string `"None"`, so a publication missing a `pdf_url`/`dgca_url` would have
produced a broken `href="None"` link in a real email; both buttons are now
conditionally rendered, matching the "never invent a URL" requirement.
`send_test_email()` (new) sends exactly one clearly-labeled
`[DGCA TEST] Regulatory Intelligence Email Test` — respects `TEST_MODE`
exactly like every other send in this pipeline, so calling it is never
itself a way to bypass the safety switch.

**Dynamic subject line** (`pipeline/orchestrator.py`): `build_email_subject()`
produces `[DGCA][NEW][<CATEGORY>] New <Category> Published — <title>` or
`[DGCA][UPDATED][<CATEGORY>] <Category> Updated — <title>`, driven by the
same `DGCAUpdate.is_update` flag the body's comparison block uses, so the
subject and body can never disagree about whether an email is a NEW or
UPDATED notification.

**Real bug found and fixed**: the existing `comparison.find_previous_version()`
(Phase 5) explicitly excludes the current `publication_id` from its
candidates — it exists for a *different* publication_id that looks, by
title, like a new revision of an older, separately-tracked publication_id.
For the common case Phase 3/7/10 actually classify as `UPDATED` — the
*same* `publication_id`, `content_hash` changed in place — it can never
match itself, so no comparison was ever produced and the UPDATED email
content this phase requires would never have rendered. Fixed in
`process_single_publication()`: for an in-place update, the prior extracted
text (`documents_dir/{pub_id}.txt`) is read into memory **before** the
document stage overwrites it with the new version, then diffed directly —
no cross-row title matching needed for this case. `build_dgca_update()`
now takes `previous_title`/`comparison_result` directly (covering both the
in-place-update and the cross-ID title-matched-revision cases) instead of
a `previous_row` object. Verified live: a synthetic in-place update
correctly produced a real diff (2 changes, level LOW) and a rendered
comparison block containing the actual added text.

**Explicit (non-automatic) retry** (`pipeline/scheduler.py`): a real
pre-existing wiring gap was found — `storage.mark_for_resend()` (Phase 3)
was designed as "the explicit, operator-triggered escape hatch for a
deliberate re-send," but `process_single_publication()` always skipped
unconditionally on `UNCHANGED` content, so clearing `email_sent` had no
effect; a failed send could never actually be retried by anything. Fixed
with `retry_failed_notifications()` — selects `publications` rows with
`status='failed' AND email_sent=0` (existing columns, no new tracking
table), reconstructs each into the scrape-shaped dict `run_dgca_pipeline()`
already accepts via its `publications` parameter, and reruns them with a
new `retry_failed=True` flag that (only when explicitly passed) lets
`process_single_publication()` bypass the UNCHANGED skip for that one
publication. **Never called by `run_once()`/`run_scheduler()`** — retries
are deliberately not automatic/indefinite (a permanently misconfigured
SMTP server must not generate a failed send attempt every single cycle
forever); an operator calls this function explicitly. Verified live: a
synthetic SMTP failure (`status='failed'`, `email_sent=0`) was confirmed to
NOT be retried by the normal automatic path, then was successfully resent
exactly once via `retry_failed_notifications()`, then correctly found
nothing left to retry on a second call.

**Duplicate prevention, provider-failure isolation, malformed-record
isolation, HTML/PDF-link validation, and a full end-to-end demonstration**
(real local-LLM analysis via Ollama, NEW publication → validated preview
email → database status → re-run → skipped, no duplicate) were all tested
live against the real project database in
`notebooks/11_Real_Email_Notification.ipynb`, using clearly-prefixed
(`e2e-test-p11-*`) synthetic fixtures cleaned up before each run, exactly
like Phase 10's own convention.

**Real delivery status**: fully built and tested end-to-end (TEST 2's
config-presence check, and every content/duplicate-prevention/
failure-isolation/retry test) — but the actual send (spec's TEST 3/TEST 10)
was **not activated**, by explicit user choice, when asked. `config/.env`
still has `EMAIL_PROVIDER=preview`/`TEST_MODE=true` (the safe default,
unchanged). To activate real delivery later: fill in real
`SMTP_HOST`/`PORT`/`USERNAME`/`PASSWORD`/`OUTLOOK_SENDER_EMAIL`/
`OUTLOOK_RECIPIENT_EMAIL` in `config/.env` (never in this repo — see
`docs/PIPELINE_README.md` for SMTP settings), set
`EMAIL_PROVIDER=smtp`/`TEST_MODE=false`, then run
`pipeline.email_pipeline.send_test_email()` once to confirm delivery before
trusting it with genuine DGCA notifications (exact command in the
notebook's Section 14 and in this phase's final report).

**Not done in this phase, by explicit instruction:** no Microsoft
Graph/Azure activation (left as the already-implemented-but-inert future
option it was designed to be); no OpenAI calls; no OCR changes; no
dashboard changes; no scraper/AI-architecture changes; no second database
or new tracking table.

### Directory layout

```
backend/
  requirements.txt   the only Python dependency file
  README.md          backend overview + the SOLID mapping
  .gitignore         (notebooks read this one: PROJECT_ROOT is backend/)
  pipeline/          SOLID-split Python package (see Repository layout above)
    paths.py config.py utils/ scraper/ storage/ documents/ comparison/
    analysis/ email_pipeline/ orchestrator/ scheduler/
  scheduler/         run_monitor.py -- CLI entry point; calls pipeline.scheduler.run_scheduler()
  notebooks/         primary implementation record, one .ipynb per phase (PROJECT_ROOT = backend/)
  tests/             stdlib unittest suite (fakes via PipelineServices)
  config/            .env (local secrets, gitignored)
  data/              raw/ processed/ documents/ -- gitignored contents
  database/          dgca_monitor.db -- gitignored
  logs/              runtime logs -- gitignored
  node_api/          the Node.js API (own package.json), moved here unchanged
frontend/
  src/ public/ index.html package.json vite.config.js   React + Vite web dashboard
  streamlit_dashboard/   app.py + dashboard_ui/ (context, styles, widgets, views/)
docs/                architecture / design / flow / requirements notes
```

Folders under `backend/data`, `database` and `logs` are runtime output; their
contents are never committed.
