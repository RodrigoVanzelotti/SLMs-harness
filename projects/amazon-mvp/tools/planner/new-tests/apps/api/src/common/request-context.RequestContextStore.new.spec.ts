import { RequestContextStore } from './request-context';

describe('RequestContextStore', () => {
  it('has no context outside a request', () => {
    expect(RequestContextStore.get()).toBeUndefined();
    expect(RequestContextStore.requestId()).toBe('no-request-context');
    RequestContextStore.setUserId('user-outside');
    expect(RequestContextStore.get()).toBeUndefined();
  });

  it('exposes the context inside run and returns the callback result', () => {
    const result = RequestContextStore.run({ requestId: 'req-1' }, () => {
      expect(RequestContextStore.get()).toEqual({ requestId: 'req-1' });
      return RequestContextStore.requestId();
    });
    expect(result).toBe('req-1');
    expect(RequestContextStore.get()).toBeUndefined();
  });

  it('keeps the context across awaits and records the user on the same object', async () => {
    const context: { requestId: string; userId?: string } = { requestId: 'req-2' };
    const seen = await RequestContextStore.run(context, async () => {
      await Promise.resolve();
      RequestContextStore.setUserId('user-1');
      await new Promise((resolve) => setTimeout(resolve, 1));
      return RequestContextStore.get();
    });
    expect(seen).toEqual({ requestId: 'req-2', userId: 'user-1' });
    expect(context.userId).toBe('user-1');
    expect(RequestContextStore.requestId()).toBe('no-request-context');
  });

  it('lets a nested run shadow the outer context', () => {
    const ids = RequestContextStore.run({ requestId: 'outer' }, () => {
      const inner = RequestContextStore.run({ requestId: 'inner' }, () =>
        RequestContextStore.requestId(),
      );
      return [inner, RequestContextStore.requestId()];
    });
    expect(ids).toEqual(['inner', 'outer']);
  });
});
