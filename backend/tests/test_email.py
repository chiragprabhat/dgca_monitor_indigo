import unittest

from pipeline.email_pipeline import (
    DGCAUpdate,
    EmailSender,
    EmailSendResult,
    PreviewEmailSender,
    SMTPEmailSender,
    get_email_sender,
    register_sender,
    render_email_html,
    route_for_test_mode,
    send_test_email,
    validate_email_html,
)

from .helpers import make_config, temp_paths


def _update(**kw):
    base = dict(title="CAR Test", category="Regulation", published_date="2026-01-05", summary="Summary text",
                key_changes=["Change one"], impact_level="HIGH", dgca_url="https://d.example/", pdf_url="https://d.example/a.pdf")
    base.update(kw)
    return DGCAUpdate(**base)


class _Custom(EmailSender):
    provider_name = "custom"

    def is_configured(self):
        return True

    def send(self, subject, html_body, recipient):
        return EmailSendResult(True, "custom", "ok")


class RenderAndValidateTests(unittest.TestCase):
    def test_rendered_email_passes_validation(self):
        update = _update()
        html = render_email_html(update, update.summary, test_mode=False)
        self.assertTrue(validate_email_html(html, update, update.summary).is_valid)

    def test_missing_content_is_reported(self):
        update = _update()
        html = render_email_html(update, update.summary, test_mode=False).replace("CAR Test", "zzz")
        self.assertIn("Publication title", validate_email_html(html, update, update.summary).missing)

    def test_update_block_only_for_updates(self):
        new_html = render_email_html(_update(), "Summary text", test_mode=False)
        upd = _update(is_update=True, previous_title="CAR Test", overall_change_level="LOW", added_changes=["Added line"])
        upd_html = render_email_html(upd, "Summary text", test_mode=False)
        self.assertNotIn("VERSION COMPARISON", new_html)
        self.assertIn("VERSION COMPARISON", upd_html)
        self.assertTrue(validate_email_html(upd_html, upd, upd.summary).is_valid)

    def test_missing_links_are_not_rendered_as_none(self):
        html = render_email_html(_update(dgca_url=None, pdf_url=None), "Summary text", test_mode=False)
        self.assertNotIn('href="None"', html)


class SenderTests(unittest.TestCase):
    def test_factory_builds_known_providers(self):
        d = temp_paths().preview_dir
        self.assertIsInstance(get_email_sender(make_config(email_provider="preview"), d), PreviewEmailSender)
        self.assertIsInstance(get_email_sender(make_config(email_provider="smtp"), d), SMTPEmailSender)

    def test_factory_rejects_unknown_and_reserved_providers(self):
        d = temp_paths().preview_dir
        with self.assertRaises(ValueError):
            get_email_sender(make_config(email_provider="nonsense"), d)
        with self.assertRaises(NotImplementedError):
            get_email_sender(make_config(email_provider="api"), d)

    def test_registering_a_sender_needs_no_factory_change(self):
        register_sender("custom", lambda cfg, d: _Custom())
        sender = get_email_sender(make_config(email_provider="custom"), temp_paths().preview_dir)
        self.assertEqual(sender.provider_name, "custom")

    def test_test_mode_reroutes_real_providers_to_preview(self):
        d = temp_paths().preview_dir
        smtp = SMTPEmailSender(make_config())
        sender, rerouted = route_for_test_mode(smtp, make_config(test_mode=True), d)
        self.assertEqual((sender.provider_name, rerouted), ("preview", "smtp"))
        sender, rerouted = route_for_test_mode(smtp, make_config(test_mode=False), d)
        self.assertEqual((sender.provider_name, rerouted), ("smtp", None))

    def test_test_email_respects_test_mode(self):
        d = temp_paths().preview_dir
        result = send_test_email(make_config(email_provider="smtp", test_mode=True), d)
        self.assertTrue(result.success)
        self.assertEqual(result.provider, "preview")
        self.assertEqual(len(list(d.glob("*.html"))), 1)

    def test_smtp_without_config_reports_failure(self):
        result = SMTPEmailSender(make_config()).send("s", "<p>x</p>", "a@b.example")
        self.assertFalse(result.success)


if __name__ == "__main__":
    unittest.main()
