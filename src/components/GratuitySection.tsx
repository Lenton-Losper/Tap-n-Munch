/**
 * GRATUITY: the amount, and who is taking it.
 *
 * ============================================================================================
 * NO TIP IS THE COMMON CASE AND MUST STAY ONE TAP
 * ============================================================================================
 *
 * This renders ONE collapsed row by default. A waiter taking no gratuity — which is most of them —
 * touches nothing and the payment buttons behave exactly as they did before this existed. Only
 * tapping "Add gratuity" opens the amount field, and only a non-zero amount opens the picker.
 *
 * That ordering is deliberate: the amount and who is taking it are one thought, and a mis-tap is
 * correctable because none of this has charged anything yet.
 *
 * ============================================================================================
 * THE PICKER IS ATTRIBUTION, NOT AUTHORISATION
 * ============================================================================================
 *
 * There is no PIN here and nothing is proved: ANYONE HOLDING THE TERMINAL CAN PICK ANYONE. That is
 * acceptable for a gratuity, where a mis-tap is a payroll correction. It is NOT acceptable for a
 * refund, a cash settlement or a walkout close — those write away money or debt and keep their
 * PIN (see WalkoutOverride, which is this component plus the PIN, reason and authorize call).
 *
 * DO NOT REUSE THIS TO SKIP A PIN ON A PRIVILEGED ACTION.
 *
 * ============================================================================================
 * PRE-SELECTED, NOT ASSUMED
 * ============================================================================================
 *
 * When the table has a live assignment the owner is pre-selected, so the common case is CONFIRM
 * rather than choose. Where there is no assignment the picker opens UNSELECTED and the waiter
 * chooses — it does not fall back to "whoever opened the tab", because that is a different person
 * and filling it with a default is how a gratuity gets attributed to someone who was not there.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {AuthorizedUser, getVenueStaff} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {
  GRATUITY_ASSIGNED_HINT,
  GRATUITY_ADD,
  GRATUITY_AMOUNT_LABEL,
  GRATUITY_CHANGE,
  GRATUITY_CHOOSE,
  GRATUITY_NEEDS_STAFF,
  GRATUITY_NO_STAFF,
  GRATUITY_PICKER_HEADING,
  GRATUITY_REMOVE,
} from '../constants/gratuityCopy';

export type GratuityState = {
  /** Integer cents. 0 means no gratuity, and no row is written. */
  tipCents: number;
  /** The picker's unverified claim. Null until chosen. */
  tipStaffUserId: string | null;
  /**
   * False when a gratuity is keyed and nobody is chosen. The caller DISABLES the charge buttons
   * on this — the server refuses it too (TIP_NEEDS_STAFF), but a waiter should not have to be
   * told by a failed settlement what a disabled button could have said first.
   */
  valid: boolean;
};

export const NO_GRATUITY: GratuityState = {
  tipCents: 0,
  tipStaffUserId: null,
  valid: true,
};

/**
 * The tip fields for a settle call, or NOTHING AT ALL.
 *
 * Spread into the settle extras. When there is no gratuity this contributes no keys, so an absent
 * `tip_cents` on the wire means "no tip" — never "a tip that got lost between the screen and the
 * request". The server reads it the same way.
 *
 * It also refuses to send an amount with nobody attached: the server rejects that
 * (TIP_NEEDS_STAFF) and the charge button is disabled on `valid`, so this is the third guard on
 * the same rule rather than the only one.
 */
export function gratuityExtras(state: GratuityState): {
  tipCents?: number;
  tipStaffUserId?: string;
} {
  if (state.tipCents <= 0 || !state.tipStaffUserId) return {};
  return {tipCents: state.tipCents, tipStaffUserId: state.tipStaffUserId};
}

type Props = {
  /** users.id of the table's live assignment, or null when nobody owns it. */
  assignedWaiterUserId?: string | null;
  /** Display name for that waiter, when known. */
  assignedWaiterName?: string | null;
  currency: string;
  onChange: (state: GratuityState) => void;
  disabled?: boolean;
};

/**
 * A keyed major-unit amount to integer cents.
 *
 * Staff key "12.50", never 1250 — they are looking at a bill. The conversion happens here, once,
 * and rounds rather than truncates so 12.505 cannot silently become 12.50. Anything unparseable
 * is 0, i.e. no gratuity, because a half-understood number must not become a charge.
 */
export function amountToCents(raw: string): number {
  const trimmed = raw.trim();

  // A typed minus is a mis-key, not a negative gratuity — reversing one is a refund. Caught
  // BEFORE the strip below, which would otherwise turn "-5" into a five-dollar tip.
  if (trimmed.startsWith('-')) return 0;

  const kept = trimmed.replace(/[^0-9.,]/g, '');
  if (!kept) return 0;

  /**
   * THE LAST SEPARATOR IS THE DECIMAL POINT. Earlier ones are thousands grouping.
   *
   * A COMMA DECIMAL IS THE LOCAL CONVENTION and stripping it is a 100x OVERCHARGE: "12,50" became
   * 125000 cents — N$1250 instead of N$12.50 — because the comma was removed and "1250" read as
   * whole units. Caught by test, not by review.
   *
   * This rule handles both conventions without guessing: "12,50" -> 12.50, "1,250.00" -> 1250.00.
   */
  const lastSep = Math.max(kept.lastIndexOf('.'), kept.lastIndexOf(','));
  const normalised =
    lastSep === -1
      ? kept
      : `${kept.slice(0, lastSep).replace(/[.,]/g, '')}.${kept.slice(lastSep + 1).replace(/[.,]/g, '')}`;

  const n = Number(normalised);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export default function GratuitySection({
  assignedWaiterUserId,
  assignedWaiterName,
  currency,
  onChange,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [staff, setStaff] = useState<AuthorizedUser[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  const tipCents = amountToCents(amountText);

  // The list is only fetched once a gratuity is actually being entered. A venue that never tips
  // should not pay for a round trip on every table screen.
  useEffect(() => {
    if (!open || staff !== null) return;
    let cancelled = false;
    // The token is fetched here rather than threaded through props: this component is the only
    // thing that needs it, and a null token means an empty list, which the copy already covers.
    getTerminalToken()
      .then(token => (token ? getVenueStaff(token) : []))
      .then(users => {
        if (!cancelled) setStaff(users);
      })
      .catch(() => {
        if (!cancelled) setStaff([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, staff]);

  // Pre-select the table's owner when there is one. Only as an initial value: once the waiter has
  // chosen, a re-render must not drag it back.
  useEffect(() => {
    if (!open || selectedId !== null) return;
    if (assignedWaiterUserId) setSelectedId(assignedWaiterUserId);
  }, [open, assignedWaiterUserId, selectedId]);

  useEffect(() => {
    const valid = tipCents === 0 || Boolean(selectedId);
    onChange({tipCents, tipStaffUserId: tipCents > 0 ? selectedId : null, valid});
  }, [tipCents, selectedId, onChange]);

  const reset = useCallback(() => {
    setOpen(false);
    setAmountText('');
    setSelectedId(null);
    setChoosing(false);
  }, []);

  if (!open) {
    return (
      <TouchableOpacity
        style={styles.addRow}
        onPress={() => setOpen(true)}
        disabled={disabled}
        testID="gratuity-add">
        <Text style={styles.addText}>{GRATUITY_ADD}</Text>
      </TouchableOpacity>
    );
  }

  const selectedName =
    staff?.find(s => s.user_id === selectedId)?.name ??
    (selectedId && selectedId === assignedWaiterUserId ? assignedWaiterName ?? '' : '');
  const preSelected = Boolean(selectedId) && selectedId === assignedWaiterUserId;

  return (
    <View style={styles.block} testID="gratuity-section">
      <View style={styles.amountRow}>
        <Text style={styles.label}>{GRATUITY_AMOUNT_LABEL}</Text>
        <View style={styles.inputWrap}>
          <Text style={styles.currency}>{currency}</Text>
          <TextInput
            style={styles.input}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="0.00"
            editable={!disabled}
            testID="gratuity-amount"
          />
        </View>
        <TouchableOpacity onPress={reset} disabled={disabled} testID="gratuity-remove">
          <Text style={styles.remove}>{GRATUITY_REMOVE}</Text>
        </TouchableOpacity>
      </View>

      {tipCents > 0 && (
        <View style={styles.pickerBlock} testID="gratuity-picker">
          <Text style={styles.heading}>{GRATUITY_PICKER_HEADING}</Text>

          {staff === null && <ActivityIndicator testID="gratuity-loading" />}

          {staff !== null && staff.length === 0 && (
            <Text style={styles.noStaff} testID="gratuity-no-staff">
              {GRATUITY_NO_STAFF}
            </Text>
          )}

          {staff !== null && staff.length > 0 && !choosing && selectedId && (
            <View style={styles.selectedRow} testID="gratuity-selected">
              <View style={styles.selectedNames}>
                <Text style={styles.selectedName}>{selectedName}</Text>
                {preSelected && <Text style={styles.hint}>{GRATUITY_ASSIGNED_HINT}</Text>}
              </View>
              <TouchableOpacity onPress={() => setChoosing(true)} testID="gratuity-change">
                <Text style={styles.change}>{GRATUITY_CHANGE}</Text>
              </TouchableOpacity>
            </View>
          )}

          {staff !== null && staff.length > 0 && (choosing || !selectedId) && (
            <View testID="gratuity-list">
              {!selectedId && <Text style={styles.choose}>{GRATUITY_CHOOSE}</Text>}
              {staff.map(member => (
                <TouchableOpacity
                  key={member.user_id}
                  style={styles.staffRow}
                  onPress={() => {
                    setSelectedId(member.user_id);
                    setChoosing(false);
                  }}
                  testID={`gratuity-staff-${member.user_id}`}>
                  <Text style={styles.staffName}>{member.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {!selectedId && staff !== null && staff.length > 0 && (
            <Text style={styles.needs} testID="gratuity-needs-staff">
              {GRATUITY_NEEDS_STAFF}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  addRow: {paddingVertical: 10, paddingHorizontal: 4},
  addText: {fontSize: 15, color: '#2563eb', fontWeight: '600'},
  block: {borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 12, marginTop: 8},
  amountRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  label: {fontSize: 15, color: '#111827', fontWeight: '600'},
  inputWrap: {flexDirection: 'row', alignItems: 'center', flex: 1, gap: 4},
  currency: {fontSize: 15, color: '#6b7280'},
  input: {
    flex: 1,
    fontSize: 17,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    color: '#111827',
  },
  remove: {fontSize: 14, color: '#6b7280'},
  pickerBlock: {marginTop: 12},
  heading: {fontSize: 15, fontWeight: '600', color: '#111827', marginBottom: 8},
  noStaff: {fontSize: 14, color: '#b45309', lineHeight: 20},
  selectedRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  selectedNames: {flex: 1},
  selectedName: {fontSize: 16, color: '#111827', fontWeight: '600'},
  hint: {fontSize: 13, color: '#6b7280', marginTop: 2},
  change: {fontSize: 15, color: '#2563eb', fontWeight: '600'},
  choose: {fontSize: 14, color: '#6b7280', marginBottom: 6},
  staffRow: {paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6'},
  staffName: {fontSize: 16, color: '#111827'},
  needs: {fontSize: 14, color: '#b45309', marginTop: 8},
});
