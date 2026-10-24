import { getContext } from './context.js';
import { redact, type RedactOptions } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * BoundaryLogger takes the merge object first and the message second, the
 * call shape of pino. isLevelEnabled lets the boundary skip building debug
 * payloads that would be discarded.
 */
export interface BoundaryLogger {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  isLevelEnabled?(level: LogLevel): boolean;
}

export interface BoundaryOptions {
  logger: BoundaryLogger;
  /** Extra keys to mask on top of DEFAULT_REDACT_KEYS. */
  redact?: Pick<RedactOptions, 'keys'>;
  /** Calls slower than this are logged at warn instead of info. */
  slowMs?: number;
}

export interface CallOptions<T> {
  /**
   * Fields written to the info line at the end of the call. They are
   * redacted like params and cannot replace reqId, op, phase or ms.
   */
  summarize?: (result: T) => Record<string, unknown>;
}

export interface Boundary {
  call<T>(
    op: string,
    params: Record<string, unknown>,
    fn: () => T | Promise<T>,
    opts?: CallOptions<T>,
  ): Promise<T>;
}

export const DEFAULT_SLOW_MS = 500;

// loggedIn keeps, for each request context, the failures already logged in
// it. A failure that travels through nested calls of one request is logged by
// the innermost call only. The same object thrown in another request, such as
// a shared error constant, is logged once there too, even when the two
// requests interleave.
const loggedIn = new WeakMap<object, WeakSet<object>>();

// NO_CONTEXT stands in for the request context of calls made outside one.
const NO_CONTEXT = {};

/**
 * createBoundary returns a Boundary whose call method wraps one call to the
 * outside world (database, HTTP, broker). It logs the start with the
 * redacted params, the end with the duration and a summary, the full result
 * at debug, and a failure once per request with its stack before
 * rethrowing it.
 */
export function createBoundary(options: BoundaryOptions): Boundary {
  const { logger } = options;
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const redactOptions: RedactOptions = { keys: options.redact?.keys };

  async function call<T>(
    op: string,
    params: Record<string, unknown>,
    fn: () => T | Promise<T>,
    opts: CallOptions<T> = {},
  ): Promise<T> {
    const context = getContext();
    const reqId = context?.reqId;
    const safeParams = redact(params, redactOptions);
    logger.info(
      { reqId, op, phase: 'start', params: safeParams },
      `${op} start`,
    );

    const startedAt = performance.now();
    let result: T;
    try {
      result = await fn();
    } catch (thrown) {
      const failure = toFailure(thrown);
      if (firstTimeIn(context ?? NO_CONTEXT, failure)) {
        logger.error(
          {
            reqId,
            op,
            phase: 'error',
            ms: elapsedMs(startedAt),
            params: safeParams,
            err: serializeFailure(failure, redactOptions),
          },
          `${op} failed`,
        );
      }
      throw failure;
    }

    const ms = elapsedMs(startedAt);
    const summary = redact(
      (opts.summarize ?? defaultSummary)(result),
      redactOptions,
    ) as Record<string, unknown>;
    // The summary goes first so that it cannot replace reqId, op, phase or ms.
    const end = { ...summary, reqId, op, phase: 'end', ms };
    if (ms > slowMs) {
      logger.warn(end, `${op} slow`);
    } else {
      logger.info(end, `${op} done`);
    }
    if (logger.isLevelEnabled?.('debug') ?? true) {
      logger.debug(
        { reqId, op, phase: 'payload', result: redact(result, redactOptions) },
        `${op} payload`,
      );
    }
    return result;
  }

  return { call };
}

function defaultSummary(result: unknown): Record<string, unknown> {
  return Array.isArray(result) ? { count: result.length } : {};
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function firstTimeIn(scope: object, failure: object): boolean {
  let seen = loggedIn.get(scope);
  if (seen === undefined) {
    seen = new WeakSet();
    loggedIn.set(scope, seen);
  }
  if (seen.has(failure)) {
    return false;
  }
  seen.add(failure);
  return true;
}

// toFailure returns a thrown object or function unchanged. Callers catch
// exactly what fn threw. A WeakSet only holds objects. A thrown primitive such
// as a string is therefore wrapped in an Error, and callers further up receive
// the wrapper. String() of a primitive never throws.
function toFailure(thrown: unknown): object {
  if (
    (typeof thrown === 'object' && thrown !== null) ||
    typeof thrown === 'function'
  ) {
    return thrown;
  }
  return new Error(String(thrown), { cause: thrown });
}

// serializeFailure copies name, message and stack of an Error one by one.
// Error keeps message and stack as non-enumerable properties, and
// JSON.stringify(err) prints {}. A thrown object that is not an Error is
// logged as a redacted copy under thrown. A thrown function is logged by its
// name only, without calling any conversion on it.
function serializeFailure(
  failure: object,
  redactOptions: RedactOptions,
): Record<string, unknown> {
  if (failure instanceof Error) {
    return {
      name: failure.name,
      message: failure.message,
      stack: failure.stack,
    };
  }
  if (typeof failure === 'function') {
    return { thrown: `[Function ${failure.name || 'anonymous'}]` };
  }
  return { thrown: redact(failure, redactOptions) };
}
