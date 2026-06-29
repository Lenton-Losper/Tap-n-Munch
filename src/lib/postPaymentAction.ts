import {Order} from '../types';

export type PostPaymentAction =
  | {type: 'auto_return'; delayMs: number}
  | {type: 'show_close_table'; canClose: boolean};

export function getPostPaymentAction(
  order: Order,
  canClose: boolean,
): PostPaymentAction {
  if (order.channel === 'kiosk') {
    return {type: 'auto_return', delayMs: 3000};
  }
  return {type: 'show_close_table', canClose};
}
