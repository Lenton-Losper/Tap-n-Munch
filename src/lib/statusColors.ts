import {Colors} from '../constants/theme';
import {OrderStatus} from '../types';

export function getStatusColor(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return Colors.orange;
    case 'confirmed':
    case 'preparing':
      return Colors.blue;
    case 'ready':
    case 'completed':
      return Colors.green;
    case 'cancelled':
      return Colors.red;
    default:
      return Colors.textPrimary;
  }
}
