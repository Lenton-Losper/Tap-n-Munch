import {ApiRequestError} from './api';
import * as PosCopy from '../constants/posSaleCopy';

/**
 * What the POS cart says when createPOSOrder is refused because the idempotency key already names
 * a DIFFERENT sale (C4, 409 IDEMPOTENCY_KEY_BODY_MISMATCH). Null for every other error.
 *
 * The cart is never sent again under that key: every further Charge would be refused the same way.
 * Starting a new sale (clearing the cart) is what issues a fresh key.
 */
export function posKeyMismatchNotice(
  err: unknown,
): {title: string; body: string; offerNewSale: true} | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'IDEMPOTENCY_KEY_BODY_MISMATCH') {
    return null;
  }
  return {
    title: PosCopy.POS_KEY_MISMATCH_TITLE,
    body: PosCopy.POS_KEY_MISMATCH_BODY,
    offerNewSale: true,
  };
}
