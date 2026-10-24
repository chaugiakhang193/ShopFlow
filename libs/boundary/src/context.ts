import { AsyncLocalStorage } from 'node:async_hooks';

export interface BoundaryContext {
  reqId: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<BoundaryContext>();

export function runWithContext<T>(ctx: BoundaryContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): BoundaryContext | undefined {
  return storage.getStore();
}
