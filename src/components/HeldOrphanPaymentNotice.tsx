import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  HELD_ORPHAN_ACKNOWLEDGE,
  HELD_ORPHAN_BODY,
  HELD_ORPHAN_BODY_UNKNOWN_ORDER,
  HELD_ORPHAN_NEEDS_A_PERSON,
  HELD_ORPHAN_NOT_SAVED,
  HELD_ORPHAN_SAVING,
  HELD_ORPHAN_TITLE,
} from '../constants/paymentCopy';
import {
  acknowledgeHeldOrphanPayment,
  getHeldOrphanPayments,
  getTerminalToken,
  heldOrphanIdentity,
  setHeldOrphanPayments,
  type HeldOrphanPayment,
} from '../lib/storage';
import {runOrphanReportPass} from '../lib/orphanReporting';
import {storeAndReleaseHeldOrphan} from '../lib/heldOrphanStore';
import {storeHeldOrphanPayment, verifyTerminalPayment} from '../lib/api';
import {recordWiretapEvent} from '../lib/wiretap';

/**
 * #344 — tells the operator that a card payment was recovered and NOT applied to this order.
 *
 * THE THIRD PART OF THE RULING. Cases 2 and 3 say do not apply and do not discard; this is the
 * "and tell the operator plainly" half. Without it the hold is a silent write to storage that
 * nobody ever reads, which is only marginally better than the discard it replaced.
 *
 * DELIBERATELY NOT A MODAL. It sits above the payment in progress rather than interrupting it: the
 * held payment belongs to a DIFFERENT order and says nothing about the sale the operator is taking
 * right now. Blocking that sale to report an unrelated one would make staff dismiss the message
 * reflexively, which is how a notice stops being read.
 *
 * ACKNOWLEDGING DELETES THE ONLY REMAINING RECORD ON THIS DEVICE, so the action is worded as "I
 * have checked this" rather than "dismiss", and nothing clears it automatically.
 *
 * AND AS OF RULING 3 IT NO LONGER DELETES ANYTHING UNTIL THE SERVER HAS THE RECORD. Pressing the
 * button stores the held payment durably and releases the local copy only on that write, or on a
 * 409 saying the write already happened. Anything else keeps the record and says so. The rule lives
 * in heldOrphanStore.ts, not here — this component decides when to ask, never what counts as an
 * acknowledgement.
 *
 * ONE BUTTON PER RECORD, AND THAT IS NOT A LAYOUT PREFERENCE. This card previously rendered N
 * records above a SINGLE button that wiped the whole store. An operator who had checked one
 * payment therefore destroyed every held record — including a case-3 one, which is exactly the
 * record that can never come back on its own, since it names no order to report against. A card
 * transaction deleted by a button captioned "I have checked this payment". Each record now carries
 * its own action, and removal is by VALUE identity rather than list position, because the
 * reporting pass rewrites this list underneath the render.
 *
 * WHAT ACKNOWLEDGING REQUIRES WAS RULED ON 2026-08-26 AND IS NOT RECONCILIATION. The owner: "A
 * durable write IS the acknowledgement. Stored means released. Reconciliation is a separate concern
 * and the device never waits on it." Requiring reconciliation would have left a case-3 record —
 * one naming no order — unclearable forever, since nothing can reconcile a payment with no order to
 * reconcile it against.
 */
export default function HeldOrphanPaymentNotice() {
  const [held, setHeld] = useState<HeldOrphanPayment[]>([]);
  /**
   * Per-record UI state, keyed by the same VALUE identity the list is keyed by — never by index,
   * for the reason spelled out on heldOrphanIdentity: the reporting pass rewrites this list
   * underneath the render, so an index captured at press time can address a different record.
   *
   * 'saving' disables the button; 'failed' renders HELD_ORPHAN_NOT_SAVED beneath it.
   */
  const [busy, setBusy] = useState<Record<string, 'saving' | 'failed'>>({});

  /**
   * Re-read on focus, not only on mount: the hold is written by processPaymentIntent DURING a
   * payment on this same screen, so a mount-only read would miss the one that just happened.
   *
   * AND REPORT BEFORE READING (#344, expanded scope). Every held record is reported to the server
   * on each focus, and one the server acknowledges as settled is dropped — so a payment that
   * resolves stops nagging without anyone pressing anything, and the notice only ever shows what is
   * genuinely still outstanding. This IS the retry loop: no scheduler and no background task, just
   * the screen staff are already on.
   *
   * The pass never throws and never blocks the payment in progress; a failed one leaves everything
   * held for the next focus.
   */
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const refresh = async () => {
        try {
          const token = await getTerminalToken();
          if (token) {
            await runOrphanReportPass({
              getHeld: getHeldOrphanPayments,
              setHeld: setHeldOrphanPayments,
              verify: orderId => verifyTerminalPayment(orderId, token),
              onOutcome: (row, outcome) =>
                recordWiretapEvent('payment.orphan.reported', {
                  orphanOrderId: row.orphanOrderId || '(none)',
                  reason: row.reason,
                  voucherNo: row.voucherNo ?? '(none)',
                  outcome,
                }),
            });
          }
        } catch {
          // Reporting is opportunistic. Whatever happened, fall through and show what is held.
        }
        const rows = await getHeldOrphanPayments();
        if (!cancelled) {
          setHeld(rows);
        }
      };

      refresh();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (held.length === 0) {
    return null;
  }

  /**
   * Acknowledge ONE record: STORE IT, THEN RELEASE IT — ruling 3, and never the other order.
   *
   * Re-reads the store afterwards rather than filtering local state, so what the operator sees next
   * is what is actually persisted — including anything the reporting pass resolved while this
   * screen was open.
   *
   * NO TOKEN IS NOT AN ACKNOWLEDGEMENT. A device with no session cannot have stored anything, so it
   * takes the same 'failed' branch as a network error rather than falling through to a local
   * delete. This is the branch a `getTerminalToken()` returning null would otherwise skip past.
   */
  const acknowledgeOne = async (row: HeldOrphanPayment) => {
    const key = heldOrphanIdentity(row);
    setBusy(prev => ({...prev, [key]: 'saving'}));

    const token = await getTerminalToken();
    const {outcome} = token
      ? await storeAndReleaseHeldOrphan(row, {
          store: body => storeHeldOrphanPayment(body, token),
          release: r => acknowledgeHeldOrphanPayment(heldOrphanIdentity(r)).then(() => undefined),
          onOutcome: (r, result, status) =>
            recordWiretapEvent('payment.orphan.acknowledged', {
              orphanOrderId: r.orphanOrderId || '(none)',
              voucherNo: r.voucherNo ?? '(none)',
              businessOrderNo: r.businessOrderNo ?? '(none)',
              outcome: result,
              status,
            }),
        })
      : {outcome: 'kept' as const};

    setBusy(prev => {
      const next = {...prev};
      if (outcome === 'released') {
        delete next[key];
      } else {
        next[key] = 'failed';
      }
      return next;
    });
    setHeld(await getHeldOrphanPayments());
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialCommunityIcons
          name="alert-decagram"
          size={22}
          color={Colors.amber}
        />
        <Text style={styles.title}>{HELD_ORPHAN_TITLE}</Text>
      </View>

      {held.map(row => (
        <View key={heldOrphanIdentity(row)} style={styles.record}>
          <Text style={styles.body}>
            {row.reason === 'unknown_order'
              ? HELD_ORPHAN_BODY_UNKNOWN_ORDER
              : HELD_ORPHAN_BODY}
          </Text>
          {/*
            The voucher is the operator's handle on the actual transaction — it is what they will
            search for on the reader or quote to support. A notice that says "a payment exists"
            without saying WHICH cannot be acted on.
          */}
          {row.voucherNo ? (
            <Text style={styles.detail}>Voucher {row.voucherNo}</Text>
          ) : null}
          {row.orphanOrderId ? (
            <Text style={styles.detail}>Order {row.orphanOrderId}</Text>
          ) : (
            /*
              Case 3 only. A case-2 record is reported to the server on every visit and clears
              itself once that order settles; this one has no order to report against, so it will
              never clear on its own and saying so is the difference between the two states.
            */
            <Text style={styles.detail}>{HELD_ORPHAN_NEEDS_A_PERSON}</Text>
          )}
          <Pressable
            style={[
              styles.ackButton,
              busy[heldOrphanIdentity(row)] === 'saving' && styles.ackButtonBusy,
            ]}
            // Disabled only while the store is in flight. A record that FAILED to save stays
            // pressable on purpose: retrying is the whole action available to the operator, and a
            // button that greys itself out after one failure would leave them with nothing to do.
            disabled={busy[heldOrphanIdentity(row)] === 'saving'}
            onPress={() => {
              void acknowledgeOne(row);
            }}>
            <Text style={styles.ackText}>
              {busy[heldOrphanIdentity(row)] === 'saving'
                ? HELD_ORPHAN_SAVING
                : HELD_ORPHAN_ACKNOWLEDGE}
            </Text>
          </Pressable>
          {/*
            The button did nothing, so it has to say so. Without this the operator presses "I have
            checked this payment", the record stays on screen, and the only reading available to
            them is that the terminal is broken — which is how a person ends up pressing it
            repeatedly, or deciding the notice can be ignored.
          */}
          {busy[heldOrphanIdentity(row)] === 'failed' ? (
            <Text style={styles.notSaved}>{HELD_ORPHAN_NOT_SAVED}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.amberLight,
    borderWidth: 1,
    borderColor: Colors.amber,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  title: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    flexShrink: 1,
  },
  body: {
    ...Typography.small,
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
  detail: {
    ...Typography.tiny,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  /**
   * Each record is visually a unit with its own action, so it is unambiguous WHICH payment the
   * button below it acknowledges. With one button under a stack of records that was guesswork.
   */
  record: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.amber,
    paddingTop: Spacing.sm,
    marginTop: Spacing.sm,
    gap: Spacing.xs,
  },
  ackButton: {
    marginTop: Spacing.sm,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.amber,
  },
  ackText: {
    ...Typography.small,
    color: Colors.amber,
    fontWeight: '600',
  },
  ackButtonBusy: {
    opacity: 0.55,
  },
  /**
   * Deliberately the same weight as the body rather than an error red. Nothing about the PAYMENT
   * went wrong — a save did not go through — and colouring it as an error is the conflation
   * UNCONFIRMED_CHECK_FAILED exists to prevent, one screen over.
   */
  notSaved: {
    ...Typography.small,
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
});
