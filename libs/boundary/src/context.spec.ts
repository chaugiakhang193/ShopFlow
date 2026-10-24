import { getContext, runWithContext } from './context.js';

describe('request context', () => {
  it('is undefined outside runWithContext', () => {
    expect(getContext()).toBeUndefined();
  });

  it('survives awaits and stays apart between concurrent runs', async () => {
    const readAfterDelay = async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return getContext()?.reqId;
    };

    const ids = await Promise.all([
      runWithContext({ reqId: 'slow' }, () => readAfterDelay(20)),
      runWithContext({ reqId: 'fast' }, () => readAfterDelay(1)),
    ]);

    expect(ids).toEqual(['slow', 'fast']);
  });
});
