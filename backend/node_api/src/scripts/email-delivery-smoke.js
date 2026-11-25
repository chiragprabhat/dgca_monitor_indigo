import { runEmailDeliverySmokeTest } from '../services/email-delivery-smoke-service.js';

try {
  const result = await runEmailDeliverySmokeTest();
  console.log(JSON.stringify(result));
  if (result.outcome !== 'accepted-by-smtp') process.exitCode = 1;
} catch (error) {
  const code = /^(?:SMOKE_[A-Z_]{2,25}|[A-Z0-9]{5}|E[A-Z_]{2,25})$/.test(error?.code) ? error.code : undefined;
  console.log(JSON.stringify({ outcome: 'preflight-or-claim-error', code }));
  process.exitCode = 1;
}
