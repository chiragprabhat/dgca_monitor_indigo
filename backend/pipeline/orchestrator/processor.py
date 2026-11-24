"""
Runs one publication through the pipeline:

    detect -> download + extract -> previous version + comparison -> AI analysis
    -> persist analysis -> build update -> render + validate email -> send
    -> persist status

Every collaborator comes in through `PipelineServices`, so this class only
sequences stages and records how far each publication got. Each stage is
wrapped: a failure is caught, logged with the exact stage it happened at and
returned as a structured result -- it never aborts the batch.
"""
import logging
from pathlib import Path
from typing import Dict, Optional, Tuple

from ..comparison import ComparisonResult
from ..config import PipelineConfig
from ..email_pipeline import render_email_html, route_for_test_mode, validate_email_html
from ..storage import IngestOutcome
from .email_content import build_dgca_update, build_email_subject
from .ports import PipelineServices
from .results import PublicationPipelineResult

logger = logging.getLogger(__name__)


class PublicationProcessor:
    def __init__(self, services: PipelineServices):
        self._services = services

    def process(
        self,
        pub: Dict,
        config: PipelineConfig,
        documents_dir: Path,
        preview_dir: Path,
        ocr_available: bool,
        raw_pdf_bytes_override: Optional[bytes] = None,
        retry_failed: bool = False,
    ) -> PublicationPipelineResult:
        """`retry_failed` (default False): automatic runs never pass it -- an
        UNCHANGED publication is always skipped, which is what prevents
        duplicate emails. It exists only for the explicit, operator-triggered
        retry of publications whose email delivery genuinely failed
        (status='failed', email_sent=0), so retries are never automatic or
        indefinite."""
        svc = self._services
        pub_id = pub.get("source_id", "<unknown>")
        result = PublicationPipelineResult(
            publication_id=pub_id,
            title=pub.get("title", ""),
            category=pub.get("category", ""),
            published_date=pub.get("published_date") or "",
        )
        stage = "detect"
        try:
            # Stage: detect new/updated publication + persist metadata
            outcome = svc.store.ingest(pub)
            result.outcome = outcome.value
            result.stages_completed.append("detect")

            if outcome == IngestOutcome.FAILED:
                result.status = "failed"
                result.stage = stage
                result.error = "Failed to ingest publication metadata (see log for details)."
                return result

            if outcome == IngestOutcome.UNCHANGED:
                if not self._is_retryable_failure(pub_id, retry_failed):
                    result.status = "skipped_unchanged"
                    result.stage = stage
                    result.comparison_status = "unchanged since last check -- no notification needed"
                    logger.info(f"[{pub_id}] Unchanged; skipping further processing (duplicate-email prevention).")
                    return result
                logger.info(f"[{pub_id}] Content unchanged, but a previous email delivery failed -- explicit retry in progress.")
                result.comparison_status = "content unchanged; retrying previously failed email delivery"

            row = svc.store.get_row(pub_id)
            result.title = row["title"]
            result.category = row["category"]
            result.published_date = row["published_date"] or ""

            # For an in-place UPDATE (same publication_id, content changed) the
            # "previous version" is this publication's own prior extracted
            # text. It must be read BEFORE the document stage overwrites it.
            # find_previous() cannot find this case: it exists for a different
            # one -- a new publication_id that looks, by title, like a revision
            # of a previously tracked one.
            old_text_for_inplace_update = (
                self._read_prior_text(pub_id, documents_dir) if outcome == IngestOutcome.UPDATED else None
            )

            # Stage: download document + extract text
            stage = "document"
            doc_result = svc.documents.process(
                pub_id, row["pdf_url"], documents_dir, ocr_available, raw_bytes_override=raw_pdf_bytes_override
            )
            result.stages_completed.append("document")
            if doc_result.document_hash:
                svc.store.update_document_hash(pub_id, doc_result.document_hash)

            extracted_text: Optional[str] = None
            if doc_result.text_path:
                text_path = Path(doc_result.text_path)
                if text_path.exists():
                    extracted_text = text_path.read_text(encoding="utf-8")

            # Stage: identify previous version + compare old vs new
            stage = "previous_version"
            if old_text_for_inplace_update is not None:
                previous_id: Optional[str] = None
                previous_title: Optional[str] = result.title
                result.stages_completed.append("previous_version")
                stage = "comparison"
                comparison_result = self._compare_in_place(
                    result, old_text_for_inplace_update, extracted_text, config
                )
                result.stages_completed.append("comparison")
            else:
                previous_row = svc.versions.find_previous(pub_id)
                result.stages_completed.append("previous_version")
                stage = "comparison"
                previous_id, previous_title, comparison_result = self._compare_with_previous_version(
                    result, previous_row, documents_dir, extracted_text, config
                )
                result.stages_completed.append("comparison")

            # Stage: AI executive analysis
            stage = "ai_analysis"
            analysis_result = svc.analyzer.analyze(row, extracted_text, comparison_result, config)
            result.stages_completed.append("ai_analysis")
            result.impact_level = analysis_result.impact_level
            result.analysis_mode = analysis_result.analysis_mode
            result.summary = analysis_result.summary

            # Stage: persist analysis for the dashboard. Never fails the whole
            # publication -- a dashboard-persistence hiccup shouldn't undo an
            # otherwise-valid analysis/email that follows.
            stage = "persist_analysis"
            try:
                svc.store.save_analysis(
                    pub_id, analysis_result,
                    previous_publication_id=previous_id, comparison=comparison_result,
                )
                result.stages_completed.append("persist_analysis")
            except Exception as exc:
                logger.warning(f"[{pub_id}] Could not persist AI analysis for the dashboard: {exc.__class__.__name__}: {exc}")

            # Stage: build the update the email template consumes
            stage = "build_update"
            update = build_dgca_update(row, analysis_result, previous_title=previous_title, comparison_result=comparison_result)
            result.stages_completed.append("build_update")

            # Stage: render + validate the email
            stage = "generate_email"
            is_preview_render = config.test_mode or config.email_provider.strip().lower() == "preview"
            html_body = render_email_html(update, update.summary, test_mode=is_preview_render)
            validation = validate_email_html(html_body, update, update.summary)
            result.stages_completed.append("generate_email")
            if not validation.is_valid:
                result.status = "failed"
                result.stage = stage
                result.error = f"Email failed validation: missing {validation.missing}"
                return result

            # Stage: deliver via the configured EmailSender
            stage = "notify"
            subject = build_email_subject(update)
            sender, rerouted_from = route_for_test_mode(
                svc.sender_factory(config, preview_dir), config, preview_dir
            )
            if rerouted_from:
                logger.info(f"[{pub_id}] TEST_MODE active -- routing to preview instead of '{rerouted_from}'.")
            recipient = config.outlook_recipient_email or "unset-recipient@example.com"
            send_result = sender.send(subject, html_body, recipient)
            result.email_provider = send_result.provider
            result.email_success = send_result.success
            result.stages_completed.append("notify")

            # Stage: persist processing status
            stage = "persist_status"
            if send_result.success:
                svc.store.mark_email_sent(pub_id)
            else:
                svc.store.mark_failed(pub_id)
            result.stages_completed.append("persist_status")

            result.status = "success" if send_result.success else "failed"
            result.stage = "complete"
            if not send_result.success:
                result.error = send_result.message
            return result

        except Exception as exc:
            logger.error(f"[{pub_id}] Pipeline failed at stage '{stage}': {exc.__class__.__name__}: {exc}")
            result.status = "failed"
            result.stage = stage
            result.error = f"{exc.__class__.__name__}: {exc}"
            return result

    # -- stage helpers --------------------------------------------------------

    def _is_retryable_failure(self, pub_id: str, retry_failed: bool) -> bool:
        if not retry_failed:
            return False
        state = self._services.store.get_delivery_state(pub_id)
        return state is not None and state["status"] == "failed" and not state["email_sent"]

    @staticmethod
    def _read_prior_text(pub_id: str, documents_dir: Path) -> Optional[str]:
        existing_text_path = documents_dir / f"{pub_id}.txt"
        if not existing_text_path.exists():
            return None
        try:
            return existing_text_path.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning(f"[{pub_id}] Could not read prior extracted text for comparison: {exc.__class__.__name__}: {exc}")
            return None

    def _compare_in_place(
        self,
        result: PublicationPipelineResult,
        old_text: str,
        new_text: Optional[str],
        config: PipelineConfig,
    ) -> Optional[ComparisonResult]:
        if not new_text:
            result.comparison_status = "previous version of this publication found (in-place update) but new text unavailable for comparison"
            return None
        _diff, comparison_result = self._services.comparer.compare(old_text, new_text, config)
        result.comparison_status = (
            f"previous version of this publication found (in-place update) -- "
            f"{comparison_result.total_changes} change(s), level {comparison_result.overall_change_level}"
        )
        return comparison_result

    def _compare_with_previous_version(
        self,
        result: PublicationPipelineResult,
        previous_row,
        documents_dir: Path,
        new_text: Optional[str],
        config: PipelineConfig,
    ) -> Tuple[Optional[str], Optional[str], Optional[ComparisonResult]]:
        if previous_row is None:
            result.comparison_status = "no previous version on record (first-time publication)"
            return None, None, None

        previous_id = previous_row["publication_id"]
        previous_title = previous_row["title"]
        old_text_path = documents_dir / f"{previous_id}.txt"
        if old_text_path.exists() and new_text:
            old_text = old_text_path.read_text(encoding="utf-8")
            _diff, comparison_result = self._services.comparer.compare(old_text, new_text, config)
            result.comparison_status = (
                f"previous version found ({previous_id}) -- "
                f"{comparison_result.total_changes} change(s), level {comparison_result.overall_change_level}"
            )
            return previous_id, previous_title, comparison_result

        result.comparison_status = f"previous version found ({previous_id}) but text unavailable for comparison"
        return previous_id, previous_title, None
