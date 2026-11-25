const directNeonHost = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/;
const isDirect = host => directNeonHost.test(host) && !host.includes('-pooler.');

export const smokeError = (code, message) => Object.assign(new Error(message), { code });

export function smokeDatabaseTarget(env) {
  const test = (env.DEPLOYMENT_TEST_NEON_HOST || '').trim().toLowerCase();
  const production = (env.PRODUCTION_NEON_HOST || '').trim().toLowerCase();
  if (!isDirect(test) || !isDirect(production) || test === production) {
    throw smokeError('SMOKE_HOSTS', 'Configure distinct direct Neon hostnames for the test and production branches');
  }
  let url;
  try { url = new URL(env.DEPLOYMENT_TEST_DATABASE_URL); } catch {
    throw smokeError('SMOKE_URL', 'The dedicated test database secret must contain a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== test ||
      url.hostname === production || !isDirect(url.hostname) || (url.port && url.port !== '5432') ||
      !url.username || !url.password || url.hash || !/^\/[^/]+$/.test(url.pathname)) {
    throw smokeError('SMOKE_ENDPOINT', 'The dedicated secret does not match the confirmed direct test endpoint');
  }
  const allowed = { sslmode: ['require', 'verify-ca', 'verify-full'], channel_binding: ['require', 'prefer'] };
  for (const [key, value] of url.searchParams) {
    if (!Object.hasOwn(allowed, key) || !allowed[key].includes(value) || url.searchParams.getAll(key).length !== 1) {
      throw smokeError('SMOKE_URL_OPTIONS', 'The dedicated secret contains unsupported connection options');
    }
  }
  let databaseName;
  try { databaseName = decodeURIComponent(url.pathname.slice(1)); } catch {
    throw smokeError('SMOKE_URL', 'The dedicated secret contains an invalid database name');
  }
  if (!databaseName || /[\x00-\x1f\x7f/]/.test(databaseName)) {
    throw smokeError('SMOKE_URL', 'Invalid test database name');
  }
  return { hostname: test, connectionString: url.href, databaseName };
}
