import { AsyncLocalStorage } from "node:async_hooks";

export type ObservabilityContext = Readonly<{
  requestId: string;
  correlationId: string;
}>;

const storage = new AsyncLocalStorage<ObservabilityContext>();

export function runWithObservabilityContext<T>(
  context: ObservabilityContext,
  callback: () => T
): T {
  return storage.run(context, callback);
}

export function getObservabilityContext(): ObservabilityContext | undefined {
  return storage.getStore();
}

