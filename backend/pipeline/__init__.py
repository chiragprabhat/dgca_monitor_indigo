"""
DGCA Regulatory Intelligence -- backend pipeline package.

Each sub-package has one responsibility and hides its internals behind the
names exported from its __init__:

    paths.py         ProjectPaths: where config, documents, previews and logs live
    config.py        PipelineConfig + narrow *Settings protocols (one per consumer)
    utils/           retry_with_backoff, configure_logging
    scraper/         DGCA "What's New" scraper (CategorySource strategies)
    storage/         PostgreSQL change detection, notifications, analysis persistence, queries
    documents/       PDF download, validation, text extraction, OCR gating
    comparison/      old-vs-new diff engine, previous-version matching
    analysis/        AI executive analysis (AnalysisProvider strategies: local, openai, fallback)
    email_pipeline/  DGCAUpdate, HTML rendering/validation, EmailSender implementations
    orchestrator/    per-publication stage sequence over injected PipelineServices
    scheduler/       run_once() / run_scheduler() / retry_failed_notifications()

Dependencies point one way: orchestrator and scheduler sit on top of
everything else. analysis depends on comparison (for its result type); the
other packages do not depend on each other.
"""
