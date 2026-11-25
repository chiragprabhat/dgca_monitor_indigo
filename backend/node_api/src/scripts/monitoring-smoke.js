import axios from 'axios';
import { runMonitoringSmokeTest } from '../services/monitoring-smoke-service.js';
import { getHttpsAgent } from '../utils/system-ca.js';

axios.defaults.httpsAgent = getHttpsAgent();
try {
  const result = await runMonitoringSmokeTest({
    onBaseline: before => console.log(JSON.stringify({ stage: 'baseline', before }))
  });
  console.log(JSON.stringify(result, null, 2));
  // A skipped run is deliberately unsuccessful as a smoke test.
  if (result.outcome !== 'scraped') process.exitCode = 1;
} catch (error) {
  const code = /^(?:SMOKE_[A-Z_]{2,25}|[A-Z0-9]{5}|E[A-Z_]{2,25})$/.test(error.code) ? error.code : undefined;
  console.log(JSON.stringify({ outcome: 'preflight-or-monitor-error', code }));
  process.exitCode = 1;
}
