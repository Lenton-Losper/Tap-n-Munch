/**
 * Sprint 2026-09-28 brief. A POS sale re-sent under an earlier attempt's key with different items
 * is refused by the server (C4 409). The terminal must say so and offer a new sale -- never treat
 * it as a generic error the waiter will simply retry into the same refusal.
 */
import {ApiRequestError} from '../api';
import {posKeyMismatchNotice} from '../posSaleRefusal';
import * as PosCopy from '../../constants/posSaleCopy';

describe('POS sale: idempotency key names a different sale', () => {
  it('a 409 IDEMPOTENCY_KEY_BODY_MISMATCH produces the explicit notice and offers a new sale', () => {
    const err = new ApiRequestError('mismatch', 409, {code: 'IDEMPOTENCY_KEY_BODY_MISMATCH'});
    const notice = posKeyMismatchNotice(err);
    expect(notice).not.toBeNull();
    expect(notice?.title).toBe(PosCopy.POS_KEY_MISMATCH_TITLE);
    expect(notice?.body).toMatch(/NOT been charged/);
    expect(notice?.offerNewSale).toBe(true);
  });

  it('any other error is not this notice', () => {
    expect(posKeyMismatchNotice(new ApiRequestError('x', 409, {code: 'OTHER'}))).toBeNull();
    expect(posKeyMismatchNotice(new ApiRequestError('x', 500))).toBeNull();
    expect(posKeyMismatchNotice(new Error('network'))).toBeNull();
  });

  it('the cart screen routes the refusal through the notice and clears the cart on "Start a new sale"', () => {
    // Source contract: the screen must consult the notice before its generic error alert.
    const {readFileSync} = require('fs') as {readFileSync: (p: string, e: string) => string};
    const src = readFileSync('src/screens/POSCartScreen.tsx', 'utf8');
    const noticeAt = src.indexOf('posKeyMismatchNotice(err)');
    const genericAt = src.indexOf("'Failed to create order'");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(genericAt);
    expect(src).toMatch(/POS_START_NEW_SALE, onPress: \(\) => clearCart\(\)/);
  });
});
