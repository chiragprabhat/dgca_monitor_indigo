import { createHash, timingSafeEqual } from 'node:crypto';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_FRONTENDS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const digest = value => createHash('sha256').update(value).digest();

export function createAccessPolicy(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const production = env.NODE_ENV === 'production' || !!env.VERCEL || !LOCAL_HOSTS.has(host);
  const username = env.API_OPERATOR_USERNAME;
  const password = env.API_OPERATOR_PASSWORD;
  const enabled = production || !!(username || password);
  const onVercel = env.VERCEL === '1';
  const schedule = onVercel ? 'worker' : env.MONITOR_SCHEDULER || 'local';
  const triggerToken = env.MONITOR_TRIGGER_TOKEN;
  const origins = (env.FRONTEND_URL || '').split(',').map(value => value.trim()).filter(Boolean);

  if (!onVercel && !['local', 'github'].includes(schedule)) throw new Error('MONITOR_SCHEDULER must be local or github');
  if (enabled && (!username || username.includes(':') || !password || password.length < 20)) {
    throw new Error('API access requires API_OPERATOR_USERNAME and an API_OPERATOR_PASSWORD of at least 20 characters');
  }
  if (schedule === 'github' && (!triggerToken || triggerToken.length < 32 || triggerToken === password)) {
    throw new Error('GitHub monitoring requires a separate MONITOR_TRIGGER_TOKEN of at least 32 characters');
  }
  if (production && (!origins.length || origins.some(origin => {
    try {
      const url = new URL(origin);
      return url.protocol !== 'https:' || url.origin !== origin;
    } catch {
      return true;
    }
  }))) throw new Error('Set FRONTEND_URL to one or more exact HTTPS origins for production');

  const allowedOrigins = new Set(production ? origins : [...origins, ...LOCAL_FRONTENDS]);
  const operatorDigest = enabled ? digest(`${username}:${password}`) : null;
  const triggerDigest = triggerToken ? digest(triggerToken) : null;

  function requireHttps(req, res, next) {
    const https = onVercel ? req.get('x-forwarded-proto') === 'https' : req.secure;
    if (production && !https) return res.status(400).json({ error: 'HTTPS required' });
    if (!production && (!LOCAL_HOSTS.has(req.hostname) || req.get('forwarded') || req.get('x-forwarded-proto'))) {
      return res.status(503).json({ error: 'Enable production mode before proxying the API' });
    }
    next();
  }

  function requireOperator(req, res, next) {
    if (enabled) {
      const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.get('authorization') || '');
      if (!basic || !timingSafeEqual(digest(Buffer.from(basic[1], 'base64')), operatorDigest)) {
        res.set('WWW-Authenticate', 'Basic realm="DGCA Monitor", charset="UTF-8"');
        return res.status(401).json({ error: 'Authentication required' });
      }
    }
    const origin = req.get('origin');
    if ((origin && !allowedOrigins.has(origin)) ||
        (!SAFE_METHODS.has(req.method) && !origin && req.get('sec-fetch-site'))) {
      return res.status(403).json({ error: 'Request origin not allowed' });
    }
    next();
  }

  function requireScheduledTrigger(req, res, next) {
    if (schedule !== 'github') return res.status(404).json({ error: 'Not Found', path: req.path });
    const bearer = /^Bearer (\S+)$/i.exec(req.get('authorization') || '');
    if (req.get('origin') || !bearer || !timingSafeEqual(digest(bearer[1]), triggerDigest)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  }

  return { host, production, allowedOrigins, requireHttps, requireOperator, requireScheduledTrigger };
}
