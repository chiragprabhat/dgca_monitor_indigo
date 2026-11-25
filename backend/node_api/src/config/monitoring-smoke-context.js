import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

export function runInMonitoringSmokeTest(target, callback) {
  return context.run({ target, pool: undefined }, callback);
}

export function runInEmailDeliverySmokeTest(target, callback) {
  return context.run({ target, pool: undefined, emailDelivery: true }, callback);
}

export function monitoringSmokeTest() {
  return context.getStore();
}
