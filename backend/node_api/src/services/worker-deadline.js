import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout } from 'node:timers/promises';

const scope = new AsyncLocalStorage();

export const workerSignal = () => scope.getStore()?.signal;
export const remainingWorkerMs = () => Math.max(0, (scope.getStore()?.expiresAt ?? Infinity) - Date.now());
export function checkWorkerDeadline() {
  workerSignal()?.throwIfAborted();
  if (remainingWorkerMs() === 0) throw new DOMException('Worker deadline exceeded', 'TimeoutError');
}
export const workerDelay = ms => setTimeout(ms, undefined, { signal: workerSignal() });

export function withinWorkerDeadline(ms, callback) {
  const parent = scope.getStore();
  const timer = AbortSignal.timeout(ms);
  const signal = parent ? AbortSignal.any([parent.signal, timer]) : timer;
  const expiresAt = Math.min(Date.now() + ms, parent?.expiresAt ?? Infinity);
  return scope.run({ signal, expiresAt }, callback);
}
