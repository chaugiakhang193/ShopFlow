import {
  createBoundary,
  type BoundaryLogger,
  type LogLevel,
} from './boundary.js';
import { runWithContext } from './context.js';
import { REDACTED } from './redact.js';

interface Entry {
  level: LogLevel;
  obj: Record<string, unknown>;
  msg: string;
}

function memoryLogger(
  enabled: LogLevel[] = ['debug', 'info', 'warn', 'error'],
) {
  const entries: Entry[] = [];
  const write = (level: LogLevel) => (obj: object, msg: string) => {
    entries.push({ level, obj: obj as Record<string, unknown>, msg });
  };
  const logger: BoundaryLogger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    isLevelEnabled: (level) => enabled.includes(level),
  };
  return { logger, entries };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phases(entries: Entry[]): string[] {
  return entries.map((e) => `${e.level}:${String(e.obj.phase)}`);
}

describe('createBoundary().call', () => {
  it('logs start, end and payload around a successful call', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    let linesBeforeFn = -1;
    const rows = await runWithContext({ reqId: 'req-1' }, () =>
      b.call('repo.listOrders', { customerId: 'c-7' }, () => {
        linesBeforeFn = entries.length;
        return Promise.resolve([{ id: 1 }, { id: 2 }]);
      }),
    );

    expect(rows).toHaveLength(2);
    expect(linesBeforeFn).toBe(1);
    expect(phases(entries)).toEqual([
      'info:start',
      'info:end',
      'debug:payload',
    ]);
    expect(entries.map((e) => e.msg)).toEqual([
      'repo.listOrders start',
      'repo.listOrders done',
      'repo.listOrders payload',
    ]);
    expect(
      entries.every(
        (e) => e.obj.reqId === 'req-1' && e.obj.op === 'repo.listOrders',
      ),
    ).toBe(true);
    expect(entries[0].obj.params).toEqual({ customerId: 'c-7' });
    expect(entries[1].obj).toMatchObject({ count: 2 });
    expect(entries[1].obj.ms).toEqual(expect.any(Number));
    expect(entries[2].obj.result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('adds nothing to the end line for a result that is not an array', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    await b.call('repo.findOrder', {}, () => ({ id: 'o-9', total: 250000 }));

    expect(Object.keys(entries[1].obj).sort()).toEqual([
      'ms',
      'op',
      'phase',
      'reqId',
    ]);
  });

  it('redacts the summary and keeps reqId, op, phase and ms from the call', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    await runWithContext({ reqId: 'req-2' }, () =>
      b.call('repo.findUser', {}, () => ({ email: 'a@example.com' }), {
        summarize: (r) => ({
          email: r.email,
          reqId: 'other',
          op: 'other',
          phase: 'other',
          ms: -1,
        }),
      }),
    );

    expect(entries[1].obj).toMatchObject({
      email: REDACTED,
      reqId: 'req-2',
      op: 'repo.findUser',
      phase: 'end',
    });
    expect(entries[1].obj.ms).toBeGreaterThanOrEqual(0);
  });

  it('writes the payload line for a logger without isLevelEnabled', async () => {
    const { logger, entries } = memoryLogger();
    delete logger.isLevelEnabled;
    const b = createBoundary({ logger });

    await b.call('repo.ping', {}, () => 1);

    expect(phases(entries)).toEqual([
      'info:start',
      'info:end',
      'debug:payload',
    ]);
  });

  it('writes the summarize output on the end line', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    await b.call(
      'payment.charge',
      { orderId: 'o-1' },
      () => ({ status: 'paid' }),
      {
        summarize: (r) => ({ status: r.status }),
      },
    );

    expect(entries[1].obj).toMatchObject({ phase: 'end', status: 'paid' });
  });

  it('redacts params and payload, including extra keys', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger, redact: { keys: ['cardNumber'] } });

    await b.call(
      'payment.charge',
      { email: 'a@example.com', cardNumber: '4111' },
      () => ({ token: 'tok-1', ok: true }),
    );

    expect(entries[0].obj.params).toEqual({
      email: REDACTED,
      cardNumber: REDACTED,
    });
    expect(entries[2].obj.result).toEqual({ token: REDACTED, ok: true });
  });

  it('skips the payload line when debug is disabled', async () => {
    const { logger, entries } = memoryLogger(['info', 'warn', 'error']);
    const b = createBoundary({ logger });

    await b.call('repo.ping', {}, () => 1);

    expect(phases(entries)).toEqual(['info:start', 'info:end']);
  });

  it('logs the end line at warn when the call is slower than slowMs', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger, slowMs: 5 });

    await b.call(
      'payment.charge',
      {},
      () => new Promise((resolve) => setTimeout(resolve, 30)),
    );

    expect(entries[1].level).toBe('warn');
    expect(entries[1].obj.ms).toBeGreaterThan(5);
  });

  it('logs a failure once with its stack and rethrows the same error', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const failure = new Error('connection refused');

    const outcome = runWithContext({ reqId: 'req-3' }, () =>
      b.call('postgres.ping', { host: 'db' }, () => Promise.reject(failure)),
    );

    await expect(outcome).rejects.toBe(failure);
    expect(phases(entries)).toEqual(['info:start', 'error:error']);
    expect(entries[1].msg).toBe('postgres.ping failed');
    expect(entries[1].obj).toMatchObject({
      reqId: 'req-3',
      op: 'postgres.ping',
      ms: expect.any(Number),
      params: { host: 'db' },
      err: { name: 'Error', message: 'connection refused' },
    });
    expect(String((entries[1].obj.err as { stack: string }).stack)).toContain(
      'connection refused',
    );
  });

  it('logs an error once when it crosses three nested calls', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    const outcome = b.call('service.placeOrder', {}, () =>
      b.call('payment.charge', {}, () =>
        b.call('http.post', {}, () => Promise.reject(new Error('timeout'))),
      ),
    );

    await expect(outcome).rejects.toThrow('timeout');
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].obj.op).toBe('http.post');
  });

  it('wraps a thrown string in an Error before logging it', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    const outcome = b.call('legacy.call', {}, () => {
      throw 'plain string';
    });

    await expect(outcome).rejects.toBeInstanceOf(Error);
    await expect(outcome).rejects.toMatchObject({
      message: 'plain string',
      cause: 'plain string',
    });
    expect(entries.filter((e) => e.level === 'error')).toHaveLength(1);
  });

  it('rethrows a thrown plain object as is and logs a redacted copy', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const thrown = { message: 'down', code: 'X', token: 't-1' };

    const outcome = b.call('legacy.call', {}, () => {
      throw thrown;
    });

    await expect(outcome).rejects.toBe(thrown);
    expect(entries[1].obj.err).toEqual({
      thrown: { message: 'down', code: 'X', token: REDACTED },
    });
  });

  it('logs a reused error object once in each request that throws it', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const notFound = new Error('not found');
    const find = () =>
      b.call('repo.find', {}, () =>
        b.call('db.query', {}, () => Promise.reject(notFound)),
      );

    for (const reqId of ['req-4', 'req-5']) {
      await runWithContext({ reqId }, find).catch(() => {});
    }

    const errors = entries.filter((e) => e.level === 'error');
    expect(errors.map((e) => [e.obj.reqId, e.obj.op])).toEqual([
      ['req-4', 'db.query'],
      ['req-5', 'db.query'],
    ]);
  });

  it('logs a shared error once in each of two interleaved requests', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const notFound = new Error('not found');
    const query = (delayMs: number) =>
      b.call('db.query', {}, async () => {
        await sleep(delayMs);
        throw notFound;
      });

    // req-6 fails first and rethrows only after req-7 has logged the error.
    const first = runWithContext({ reqId: 'req-6' }, () =>
      b.call('repo.find', {}, async () => {
        try {
          await query(5);
        } catch (thrown) {
          await sleep(15);
          throw thrown;
        }
      }),
    );
    const second = runWithContext({ reqId: 'req-7' }, () =>
      b.call('repo.find', {}, () => query(10)),
    );
    await Promise.allSettled([first, second]);

    const errors = entries.filter((e) => e.level === 'error');
    expect(errors.map((e) => [e.obj.reqId, e.obj.op])).toEqual([
      ['req-6', 'db.query'],
      ['req-7', 'db.query'],
    ]);
  });

  it('logs a failure once when a nested request throws it back', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const failure = new Error('shared');

    const outcome = runWithContext({ reqId: 'req-8' }, () =>
      b.call('outer.op', {}, async () => {
        await b
          .call('inner.op', {}, () => Promise.reject(failure))
          .catch(() => undefined);
        await runWithContext({ reqId: 'req-9' }, () =>
          b.call('nested.op', {}, () => Promise.reject(failure)),
        );
      }),
    );

    await expect(outcome).rejects.toBe(failure);
    const errors = entries.filter((e) => e.level === 'error');
    expect(errors.map((e) => [e.obj.reqId, e.obj.op])).toEqual([
      ['req-8', 'inner.op'],
      ['req-9', 'nested.op'],
    ]);
  });

  it('rethrows a thrown function as is and logs only its name', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });
    const thrown = Object.assign(function onTimeout() {}, {
      [Symbol.toPrimitive]() {
        throw new TypeError('no conversion');
      },
    });

    const outcome = b.call('legacy.call', {}, () => {
      throw thrown;
    });

    await expect(outcome).rejects.toBe(thrown);
    expect(entries[1].obj.err).toEqual({ thrown: '[Function onTimeout]' });
  });

  it('logs reqId as undefined outside a request context', async () => {
    const { logger, entries } = memoryLogger();
    const b = createBoundary({ logger });

    await b.call('job.tick', {}, () => 'ok');

    expect(entries[0].obj).toHaveProperty('reqId', undefined);
  });
});
