"""
End-to-end orchestration of the pipeline.

    results.py        -- PublicationPipelineResult, PipelineRunSummary
    email_content.py  -- build_dgca_update(), build_email_subject()
    ports.py          -- protocols for everything the orchestrator depends on
    adapters.py       -- default implementations of those protocols
    processor.py      -- PublicationProcessor: the per-publication stage sequence
    runner.py         -- run_dgca_pipeline(), process_single_publication()
    reporting.py      -- print_pipeline_result()
"""
from .adapters import LiveDgcaSource, build_default_services
from .email_content import build_dgca_update, build_email_subject
from .ports import (
    Analyzer,
    DocumentComparer,
    DocumentService,
    PipelineServices,
    PublicationSource,
    VersionFinder,
)
from .processor import PublicationProcessor
from .reporting import print_pipeline_result
from .results import PipelineRunSummary, PublicationPipelineResult
from .runner import process_single_publication, run_dgca_pipeline

__all__ = [
    "Analyzer", "DocumentComparer", "DocumentService", "LiveDgcaSource", "PipelineRunSummary",
    "PipelineServices", "PublicationPipelineResult", "PublicationProcessor", "PublicationSource",
    "VersionFinder", "build_default_services", "build_dgca_update", "build_email_subject",
    "print_pipeline_result", "process_single_publication", "run_dgca_pipeline",
]
