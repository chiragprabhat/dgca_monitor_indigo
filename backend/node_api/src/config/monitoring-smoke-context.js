import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

export function runInMonitoringSmokeTest(target, callback) {
  return context.run({ target, pool: undefined }, callback);
}

export function runInEmailDeliverySmokeTest(target, callback) {
  return context.run({ target, pool: undefined, emailDelivery: true }, callback);
}

export async function runWithBackgroundSmokeClient(client, callback) {
  const smoke = monitoringSmokeTest();
  if (!smoke) throw new Error('Smoke-test context required');
  let active = true;
  const backgroundClient = {
    query(...args) {
      if (!active) throw new Error('Background smoke-test database scope has closed');
      return client.query(...args);
    }
  };
  try {
    return await context.run({ ...smoke, backgroundClient, savepoint: 0 }, callback);
  } finally {
    active = false;
  }
}

export function monitoringSmokeTest() {
  return context.getStore();
}
