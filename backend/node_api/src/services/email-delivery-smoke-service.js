import { closeDatabase, getDatabase, verifyMonitoringSmokeConnection } from '../config/database.js';
import { runInEmailDeliverySmokeTest } from '../config/monitoring-smoke-context.js';
import { smokeDatabaseTarget, smokeError } from '../config/smoke-database-target.js';
import { sendEmailDeliverySmokeTest } from './notification-service.js';

const PREVIOUS_CLAIM_KEY = 'email_delivery_smoke_v1_claimed';
const CLAIM_KEY = 'email_delivery_smoke_v2_two_recipients_claimed';

function fixturePdf() {
  const stream = 'BT /F1 14 Tf 30 75 Td (TEST ONLY - Synthetic DGCA email attachment) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let document = '%PDF-1.4\n';
  const xref = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    xref.push(`${String(document.length).padStart(10, '0')} 00000 n \n`);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = document.length;
  document += `xref\n0 ${xref.length}\n${xref.join('')}trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return { filename: 'dgca-email-smoke-test.pdf', buffer: Buffer.from(document, 'ascii') };
}

export async function runEmailDeliverySmokeTest(env = process.env) {
  if (env.DGCA_MONITOR_ENABLED !== 'false') {
    throw smokeError('SMOKE_RECURRING_ENABLED', 'Recurring monitoring must remain disabled');
  }
  if (env.EMAIL_NOTIFICATIONS_ENABLED !== 'false') {
    throw smokeError('SMOKE_EMAIL_ENABLED', 'Automatic email must remain disabled');
  }
  if (env.GITHUB_RUN_ATTEMPT !== '1') {
    throw smokeError('SMOKE_RUN_ATTEMPT', 'Reruns are disabled');
  }
  if (env.EMAIL_DELIVERY_SMOKE_CONFIRMATION !== 'SEND ONE TWO-RECIPIENT TEST EMAIL') {
    throw smokeError('SMOKE_CONFIRMATION', 'Explicit confirmation is required');
  }
  const appPassword = env.EMAIL_APP_PASSWORD?.trim();
  if (!appPassword) throw smokeError('SMOKE_SMTP_SECRET', 'The existing Gmail app password secret is required');
  const target = smokeDatabaseTarget(env);
  const role = 'neondb_owner';
  if (target.databaseName !== 'neondb' || decodeURIComponent(new URL(target.connectionString).username) !== role) {
    throw smokeError('SMOKE_DATABASE', 'Expected the approved deployment-test database and role');
  }
  target.neonIdentity = { project: 'tiny-sea-21255890', branch: 'br-plain-pine-belvpen0', role };
  return runInEmailDeliverySmokeTest(target, async () => {
    try {
      await verifyMonitoringSmokeConnection();
      const db = getDatabase();
      const previousClaim = await db.prepare('SELECT value FROM config WHERE key = $1').get(PREVIOUS_CLAIM_KEY);
      if (previousClaim?.value !== 'true') {
        throw smokeError('SMOKE_PREVIOUS_CLAIM', 'The previous single-recipient claim could not be verified');
      }
      if (await db.prepare('SELECT 1 FROM config WHERE key = $1').get(CLAIM_KEY)) {
        return { outcome: 'already-claimed', databaseVerified: true, previousClaimPreserved: true };
      }
      const result = await sendEmailDeliverySmokeTest({
        appPassword,
        pdf: fixturePdf(),
        claimDelivery: async () => (await db.query(`
          INSERT INTO config (key, value) VALUES ($1, 'true')
          ON CONFLICT (key) DO NOTHING
        `, [CLAIM_KEY])).rowCount === 1
      });
      return { ...result, databaseVerified: true, previousClaimPreserved: true };
    } finally {
      await closeDatabase();
    }
  });
}
