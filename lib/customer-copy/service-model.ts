/**
 * THE ONE PLACE A SERVICE-MODEL COPY PAIR IS RESOLVED.
 *
 * A counter-service venue may have no table staff at all. Telling its customers that "a waiter has
 * been notified" or that "a staff member will come to your table" promises a person who is never
 * coming -- which is the defect #334 fixed for the cart's payment chooser and this module extends
 * to every other surface.
 *
 * WHY A MODULE AND NOT A TERNARY AT EACH SITE. The cart derived `isKiosk || is_counter_service`
 * inline. Copied to four more files, that derivation is five chances for the flag to drift -- and a
 * flag that is read in five places and honoured in four is worse than one that is never read,
 * because it looks correct. Both halves live here: how the model is decided, and what each pair
 * resolves to.
 *
 * THE PAIRS ARE PINNED BOTH WAYS by __tests__/service-model-copy-pairs.test.ts: every pair must
 * resolve to a DIFFERENT string in each direction, and no counter string may promise a person.
 * A pair whose halves are equal would make `isCounterService` decorative -- the test would go green
 * on a flag that changes nothing, so equality is a failure, not a shortcut.
 */
import { MENU_COPY } from './menu-copy'

/**
 * Kiosk is a CHANNEL, counter service is a VENUE PROPERTY, and either implies the customer comes
 * to the counter. A kiosk at a table-service venue is still a counter interaction; a
 * counter-service venue is one whether or not this particular order came through a kiosk.
 *
 * `=== true` deliberately: the column is `boolean | null`, and a null must read as table service
 * rather than as counter. Getting that backwards would tell a table-service customer to walk to a
 * counter that may not take payment.
 */
export function deriveIsCounterService(params: {
  isKiosk?: boolean
  restaurant?: { is_counter_service?: boolean | null } | null
}): boolean {
  return params.isKiosk === true || params.restaurant?.is_counter_service === true
}

/**
 * Every service-model pair, resolved for one venue. Read a field off this object; never read a
 * `payTable*` or `payCounter*` key from MENU_COPY directly at a render site.
 */
export function serviceCopy(isCounterService: boolean) {
  const pick = (counter: string, table: string) => (isCounterService ? counter : table)
  return {
    /** cart -- the payment-method chooser (round one, #334) */
    cashLabel: pick(MENU_COPY.payCounterCashLabel, MENU_COPY.payTableCashLabel),
    cashBody: pick(MENU_COPY.payCounterCashBody, MENU_COPY.payTableCashBody),
    cardLabel: pick(MENU_COPY.payCounterCardLabel, MENU_COPY.payTableCardLabel),
    cardBody: pick(MENU_COPY.payCounterCardBody, MENU_COPY.payTableCardBody),
    /** cart -- how payment will happen */
    assistWithPayment: pick(MENU_COPY.payCounterAssistWithPayment, MENU_COPY.payTableAssistWithPayment),
    /** tab page -- request-the-bill outcome */
    couldNotNotifyStaff: pick(MENU_COPY.payCounterCouldNotNotifyStaff, MENU_COPY.payTableCouldNotNotifyStaff),
    staffNotified: pick(MENU_COPY.payCounterStaffNotified, MENU_COPY.payTableStaffNotified),
    /** v2 landing */
    pleaseAskForAssistance: pick(
      MENU_COPY.payCounterPleaseAskForAssistance,
      MENU_COPY.payTablePleaseAskForAssistance,
    ),
    tabReadyToPay: pick(MENU_COPY.payCounterTabReadyToPay, MENU_COPY.payTableTabReadyToPay),
    /** order confirmation */
    orderReady: pick(MENU_COPY.payCounterOrderReady, MENU_COPY.payTableOrderReady),
    /** order confirmation AND the cash button's own success state -- two surfaces, one pair */
    staffHasBeenNotified: pick(
      MENU_COPY.payCounterStaffHasBeenNotified,
      MENU_COPY.payTableStaffHasBeenNotified,
    ),
    /** tab close (round one) */
    tabClosedBody: pick(MENU_COPY.tabClosedCounterBody, MENU_COPY.tabClosedTableBody),
  }
}

export type ServiceCopy = ReturnType<typeof serviceCopy>

/** The pair keys, for the test that pins every one of them in both directions. */
export const SERVICE_COPY_PAIRS: ReadonlyArray<keyof ServiceCopy> = [
  'cashLabel',
  'cashBody',
  'cardLabel',
  'cardBody',
  'assistWithPayment',
  'couldNotNotifyStaff',
  'staffNotified',
  'pleaseAskForAssistance',
  'tabReadyToPay',
  'orderReady',
  'staffHasBeenNotified',
  'tabClosedBody',
]

/**
 * Pairs whose two halves are legitimately identical, with the reason. `cashLabel` and `cardLabel`
 * are the button words ("pay with cash" / "pay by card") -- the service model changes the
 * explanation underneath, not the name of the payment method. Everything NOT listed here must
 * differ, so adding a key to this list is a deliberate act with a reason attached.
 */
export const PAIRS_ALLOWED_IDENTICAL: ReadonlyArray<keyof ServiceCopy> = ['cashLabel', 'cardLabel']
