/**
 * Words restaurant staff read about their devices. No enum, route, constraint or error code ever
 * reaches the screen through here.
 */

const EVENT_TEXT: Record<string, string> = {
  'terminal.activation_code_issued': 'Activation code issued',
  'terminal.activation_code_cancelled': 'Activation code cancelled',
  'terminal.activated': 'Activated on this device',
  'terminal.renamed': 'Renamed',
  'terminal.deactivated': 'Deactivated',
  'terminal.reactivated': 'Reactivated',
  'terminal.revoked': 'Disconnected',
  'terminal.removed': 'Removed',
  'terminal.transfer_requested': 'A device registered elsewhere asked to join',
  'terminal.transfer_approved': 'Transfer approved',
  'terminal.device_transferred_in': 'Device transferred here from another restaurant',
  'terminal.device_transferred_out': 'Device moved to another restaurant',
}

export function describeDeviceEvent(action: string): string {
  return EVENT_TEXT[action] ?? 'Device updated'
}

/** Confirmation copy for each action: what WILL happen, before it happens. */
export const ACTION_COPY = {
  deactivate: {
    title: 'Deactivate this device?',
    body:
      'It stops working for your restaurant straight away: it cannot take orders or payments. ' +
      'It stays registered here, keeps its identity, and you can reactivate it at any time.',
    confirm: 'Deactivate',
  },
  reactivate: {
    title: 'Reactivate this device?',
    body: 'It can sign in and take orders and payments again the next time it connects.',
    confirm: 'Reactivate',
  },
  revoke: {
    title: 'Disconnect this screen?',
    body:
      'It is signed out immediately and cannot reconnect until you pair it again with a new code. ' +
      'The screen stays in your list so you can re-pair it by name.',
    confirm: 'Disconnect',
  },
  remove: {
    title: 'Remove this device?',
    body:
      'This permanently removes its registration from your restaurant and signs it out. The physical ' +
      'device is released, so it can be activated here or at another restaurant with a new code. ' +
      'Past orders and payments are not affected.',
    confirm: 'Remove device',
  },
  cancel_code: {
    title: 'Cancel this activation code?',
    body: 'The code stops working immediately. Nothing has been activated with it.',
    confirm: 'Cancel code',
  },
  approve_transfer: {
    title: 'Transfer this device here?',
    body:
      'A device that is registered to another restaurant tried to use this code. Transferring it ' +
      'disconnects it from its current restaurant and activates it here when it tries again. The ' +
      'other restaurant keeps its order and payment history. Only approve this if the device in ' +
      'front of you is the one you mean to use.',
    confirm: 'Transfer device',
  },
} as const

/**
 * What the P5 shows when its identity is held by another restaurant. The device already renders the
 * server's `error` text, so this reaches staff with no app update. It says what to DO and names no
 * other restaurant.
 */
export const ACTIVATION_TRANSFER_REQUIRED =
  'This device is already registered to another restaurant. A manager can approve moving it here in ' +
  'FlashTap Settings → Devices. Then tap Activate again with the same code.'

export const ACTIVATION_TRANSFER_REQUESTED_AGAIN =
  'Still waiting for a manager to approve moving this device here in FlashTap Settings → Devices. ' +
  'Tap Activate again once it has been approved.'
