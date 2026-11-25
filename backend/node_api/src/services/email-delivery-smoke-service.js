import { closeDatabase, getDatabase, verifyMonitoringSmokeConnection } from '../config/database.js';
import { runInEmailDeliverySmokeTest } from '../config/monitoring-smoke-context.js';
import { smokeDatabaseTarget, smokeError } from '../config/smoke-database-target.js';
import { sendEmailDeliverySmokeTest } from './notification-service.js';

const CLAIM_KEY = 'email_delivery_smoke_v1_claimed';

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
  if (env.EMAIL_DELIVERY_SMOKE_CONFIRMATION !== 'SEND ONE TEST EMAIL') {
    throw smokeError('SMOKE_CONFIRMATION', 'Explicit confirmation is required');
  }
  const appPassword = env.EMAIL_APP_PASSWORD?.trim();
  if (!appPassword) throw smokeError('SMOKE_SMTP_SECRET', 'The existing Gmail app password secret is required');
  const target = smokeDatabaseTarget(env);
  return runInEmailDeliverySmokeTest(target, async () => {
    try {
      await verifyMonitoringSmokeConnection();
      const db = getDatabase();
      if (await db.prepare('SELECT 1 FROM config WHERE key = $1').get(CLAIM_KEY)) {
        return { outcome: 'already-claimed' };
      }
      return await sendEmailDeliverySmokeTest({
        appPassword,
        pdf: fixturePdf(),
        claimDelivery: async () => (await db.query(`
          INSERT INTO config (key, value) VALUES ($1, 'true')
          ON CONFLICT (key) DO NOTHING
        `, [CLAIM_KEY])).rowCount === 1
      });
    } finally {
      await closeDatabase();
    }
  });
}
