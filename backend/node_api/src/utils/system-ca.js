import tls from 'tls';
import https from 'https';
import { execFileSync } from 'child_process';
import { createLogger } from './logger.js';

const logger = createLogger('certificates');

// Company networks often inspect HTTPS/SMTP traffic and re-sign it with their own
// root certificate. Windows trusts that certificate (IT installs it), but Node.js
// only knows its built-in list, so connections fail with "unable to verify the
// first certificate". Node 18 can't read the Windows store itself, so we export
// it once through PowerShell and add it to Node's list. Verification stays on.
const EXPORT_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$stores = 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root','Cert:\\LocalMachine\\CA','Cert:\\CurrentUser\\CA'",
  "Get-ChildItem $stores | Where-Object { $_.NotAfter -gt (Get-Date) } | ForEach-Object {",
  "  '-----BEGIN CERTIFICATE-----'",
  "  [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')",
  "  '-----END CERTIFICATE-----'",
  '}'
].join('\n');

let cached = null;

export function getTrustedCAs() {
  if (cached) return cached;
  cached = [...tls.rootCertificates];
  if (process.platform !== 'win32' || process.env.USE_WINDOWS_CERTS === 'false') return cached;

  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', EXPORT_SCRIPT], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 32 * 1024 * 1024
    });
    const pems = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const known = new Set(cached.map(c => c.replace(/\s+/g, '')));
    let added = 0;
    for (const pem of pems) {
      const key = pem.replace(/\s+/g, '');
      if (!known.has(key)) {
        known.add(key);
        cached.push(pem.replace(/\r\n/g, '\n'));
        added++;
      }
    }
    logger.info(`Trusting ${added} extra certificate(s) from the Windows certificate store`);
  } catch (error) {
    logger.warn('Could not read the Windows certificate store; using Node.js certificates only', { error: error.message });
  }
  return cached;
}

let agent = null;

export function getHttpsAgent() {
  if (!agent) agent = new https.Agent({ ca: getTrustedCAs() });
  return agent;
}
