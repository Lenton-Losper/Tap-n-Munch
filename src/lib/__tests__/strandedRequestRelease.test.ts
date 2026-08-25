/**
 * #120 residual — the release action's safety gate and its success handling.
 *
 * THE ASSERTION THAT MATTERS is that a `waiting_review` row is never offered the release action.
 * That row is a REAL round a customer placed; releasing it would let staff dismiss a customer's
 * order, which is #120's own bug from the other side. Everything else here exists so that
 * assertion cannot be satisfied trivially — a predicate that always returned false would pass it
 * and make the button useless.
 *
 * The second group covers the outcome the issue is easiest to get wrong: ALREADY_RESOLVED is a
 * SUCCESS, not an error. It means the accept route completed its own release while this one was in
 * flight — a routine race on a shared floor — and the row is un-stranded either way.
 */
jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => 'test-token'),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

import {withApi} from './helpers/apiHarness';

describe('isReleasableStrandedRequest — only a stranded claim may be released', () => {
  it('NEVER offers the action for a waiting_review row', async () => {
    // The row a customer actually ordered. This is the assertion the whole feature turns on.
    const yes = await withApi({status: 200, body: {}}, async api =>
      api.isReleasableStrandedRequest({id: 'r1', status: 'waiting_review'}),
    );
    expect(yes).toBe(false);
  });

  it('offers it for an accepting row', async () => {
    const yes = await withApi({status: 200, body: {}}, async api =>
      api.isReleasableStrandedRequest({id: 'r1', status: 'accepting'}),
    );
    expect(yes).toBe(true);
  });

  it('offers nothing when the server sent NO status at all', async () => {
    // Servers older than the field omit it. Written as `=== 'accepting'` rather than
    // `!== 'waiting_review'` precisely for this case: undefined is not 'waiting_review', so the
    // inverted form would offer the action for every blocked row on every old server.
    const yes = await withApi({status: 200, body: {}}, async api =>
      api.isReleasableStrandedRequest({id: 'r1'}),
    );
    expect(yes).toBe(false);
  });

  it('offers nothing for a status this client does not recognise', async () => {
    const yes = await withApi({status: 200, body: {}}, async api =>
      api.isReleasableStrandedRequest({id: 'r1', status: 'some_future_state'}),
    );
    expect(yes).toBe(false);
  });
});

describe('the close 409 is parsed into rows the screen can act on', () => {
  it('carries id, value, placedAt and STATUS per row', async () => {
    const err = await withApi(
      {
        status: 409,
        body: {
          error: 'This table has orders still waiting for review.',
          code: 'PENDING_ORDER_REQUESTS',
          pending_requests: [
            {id: 'a1', placed_at: '2026-08-25T10:00:00Z', value: 42.5, status: 'accepting'},
            {id: 'b2', placed_at: '2026-08-25T10:05:00Z', value: 10, status: 'waiting_review'},
          ],
        },
      },
      async api => {
        try {
          await api.closeTable('table-1', 'tok');
          return null;
        } catch (e) {
          return e as InstanceType<typeof api.ApiRequestError>;
        }
      },
    );

    expect(err?.code).toBe('PENDING_ORDER_REQUESTS');
    expect(err?.pendingRequests).toHaveLength(2);
    expect(err?.pendingRequests[0]).toEqual({
      id: 'a1',
      placedAt: '2026-08-25T10:00:00Z',
      value: 42.5,
      status: 'accepting',
    });
    // Dropping `status` on the way through is the one parsing mistake that would make the button
    // unsafe, by leaving the screen unable to tell the two blocking states apart.
    expect(err?.pendingRequests[1].status).toBe('waiting_review');
  });

  it('leaves pendingRequests empty for an unrelated error', async () => {
    const err = await withApi(
      {status: 500, body: {error: 'boom'}},
      async api => {
        try {
          await api.closeTable('table-1', 'tok');
          return null;
        } catch (e) {
          return e as InstanceType<typeof api.ApiRequestError>;
        }
      },
    );
    expect(err?.pendingRequests).toEqual([]);
  });
});

describe('releaseStrandedRequest', () => {
  it('POSTs to the release route for that request id', async () => {
    const calls = await withApi(
      {status: 200, body: {success: true, id: 'a1', status: 'waiting_review'}},
      async (api, seen) => {
        await api.releaseStrandedRequest('a1', 'tok');
        return seen;
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/terminal/order-requests/a1/release');
    expect(calls[0].init.method).toBe('POST');
  });

  it('treats ALREADY_RESOLVED as SUCCESS, not as an error', async () => {
    // The accept route finished its own release while this was in flight. The row is no longer
    // stranded, which is the outcome staff wanted, so this must not throw.
    const result = await withApi(
      {
        status: 409,
        body: {
          error: 'This request was resolved by something else while you were releasing it.',
          code: 'ALREADY_RESOLVED',
        },
      },
      async api => api.releaseStrandedRequest('a1', 'tok'),
    );
    expect(result).toEqual({released: false, alreadyResolved: true});
  });

  it('still THROWS on NOT_A_STRANDED_CLAIM', async () => {
    // A real disagreement: this client offered an action for a row the server says is not
    // stranded. Swallowing it would hide the fact that the button was shown when it should not
    // have been.
    const err = await withApi(
      {
        status: 409,
        body: {code: 'NOT_A_STRANDED_CLAIM', error: 'Not a stranded claim', status: 'waiting_review'},
      },
      async api => {
        try {
          await api.releaseStrandedRequest('a1', 'tok');
          return null;
        } catch (e) {
          return e as {code?: string};
        }
      },
    );
    expect(err).not.toBeNull();
    expect(err?.code).toBe('NOT_A_STRANDED_CLAIM');
  });
});
