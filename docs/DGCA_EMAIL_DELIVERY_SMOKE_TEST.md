# DGCA email delivery smoke test

This manual workflow prepares one message from `dgcamonitor@gmail.com` to `chirag131004@gmail.com`, with the subject **[TEST ONLY] DGCA email delivery smoke test**. It uses the existing notification template and PDF attachment handling with a synthetic one-page PDF. It leaves the saved recipient list, real publications, notification history, job queue, and monitoring logs untouched.

## Before the approved run

1. Keep the GitHub Actions repository variable `DGCA_MONITOR_ENABLED=false`. The recurring workflow stays disabled. The email smoke test ignores the regular email-enabled setting and uses the fixed recipient in its code.
2. Check that the existing `EMAIL_APP_PASSWORD` repository secret belongs to `dgcamonitor@gmail.com`. The job uses Gmail SMTP over certificate-verified TLS on port 465. It checks SMTP authentication before reserving the delivery attempt. [Google app passwords](https://support.google.com/accounts/answer/185833) · [Nodemailer SMTP verification](https://nodemailer.com/smtp)
3. Reuse the monitoring smoke test's `DEPLOYMENT_TEST_DATABASE_URL` secret and `DEPLOYMENT_TEST_NEON_HOST` and `PRODUCTION_NEON_HOST` variables. The test verifies the direct test endpoint and its certificate before it accesses the database. The test database stores only a one-time claim in `config`. [Monitoring smoke-test setup](DGCA_MONITOR_SMOKE_TEST.md)

## Run and verify after approval

After the workflow is published to `main` and delivery is approved, open **Actions → DGCA email delivery smoke test → Run workflow**. Select `main`, type `SEND ONE TEST EMAIL` in the confirmation field, and dispatch once. [GitHub manual workflow instructions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

- `accepted-by-smtp` means Gmail accepted the message for the fixed recipient. Verify inbox delivery by checking the test subject and opening `dgca-email-smoke-test.pdf`.
- `smtp-verification-failed` means the SMTP check did not pass. This outcome creates no delivery claim and attempts no message.
- `already-claimed` means a previous run reserved the one permitted attempt on `deployment-test`. Re-dispatches and reruns cannot send a second message.
- `smtp-delivery-unconfirmed` means the one send attempt finished without confirmed SMTP acceptance. The claim remains because Gmail could have accepted the message before the connection failed. Check the assigned inbox and the sender's Sent folder before making any decision about another test.
- `preflight-or-claim-error` means the script did not establish that sending was safe. It reports only a sanitized error code when one is available.
