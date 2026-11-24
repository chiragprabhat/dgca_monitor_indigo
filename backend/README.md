# Backend

Set `DATABASE_URL` for the Node API and Python pipeline. See the [Neon setup and SQLite cutover guide](../docs/DATABASE_MIGRATION.md).

Python pipeline that monitors the DGCA "What's New" section, detects new and updated
publications, reads their PDFs, compares versions, writes an AI analysis and notifies by
email (HTML previews by default). The Node.js API in `node_api/` is a separate, older
backend that the React dashboard in `../frontend` talks to.

## Run

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
# Create config\.env locally and set DATABASE_URL. Email defaults to preview.

python scheduler\run_monitor.py                 # monitor; Ctrl+C to stop
python -m unittest discover -s tests -t .       # tests
```

## Design

`pipeline/` is split by responsibility; each sub-package exposes its public API from its
`__init__.py`, so callers write `from pipeline import storage; storage.ingest_publication(...)`.

| Principle | Where |
|---|---|
| **Single responsibility** | One reason to change per module: `storage/` is split into schema, ingestion, notifications, analysis persistence and queries; `documents/` into download, validation, extraction, OCR; `email_pipeline/` into model, template, rendering, validation, senders; `orchestrator/` into results, email content, processor, runner. |
| **Open/closed** | New behaviour is added, not edited in: a scraper category is a `CategorySource` (`scraper/sources.py`), an analysis backend is an `AnalysisProvider` (`analysis/providers/`, `register_provider()`), an email backend is an `EmailSender` (`email_pipeline/senders/`, `register_sender()`). The dispatchers (`scrape_whats_new`, `generate_ai_analysis`, `get_email_sender`) don't change. |
| **Liskov substitution** | Every `EmailSender`, `AnalysisProvider` and `CategorySource` is interchangeable behind its base class; providers never raise, they return a result (or `None`, which falls back to the deterministic analysis). |
| **Interface segregation** | `config.py` keeps one flat `PipelineConfig`, but each component declares the narrow protocol it reads (`SMTPSettings`, `GraphSettings`, `OllamaSettings`, `OpenAISettings`). The orchestrator's collaborators are separate small protocols (`orchestrator/ports.py`). |
| **Dependency inversion** | `orchestrator/processor.py` sequences the stages but depends only on `PipelineServices` (protocols for the store, documents, version lookup, comparer, analyzer, sender factory). `orchestrator/adapters.py` wires the real implementations; tests pass fakes. File locations come from `paths.ProjectPaths`, never from `__file__` tricks scattered through the code. |

Safety behaviour is unchanged: `TEST_MODE=true` routes every real email provider to a local
preview; an unchanged publication never triggers a second email; a failed email is retried
only by an explicit `scheduler.retry_failed_notifications()` call; a failure in one
publication (or one scraper category) never aborts the rest.

## Notebooks

`notebooks/` holds the phase-by-phase development record. They resolve the project root as
this `backend/` folder and import `pipeline` from it, so run them from `notebooks/`
(`jupyter notebook notebooks/<name>.ipynb` from here works too).
