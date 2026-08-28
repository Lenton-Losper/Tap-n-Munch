/**
 * EDIT A LINE BEFORE THE KITCHEN STARTS IT.
 *
 * A waiter taps a line on the table screen; this sheet changes its quantity or removes it. The
 * whole model and the server contract are documented in lib/amendTabLines.ts — read that first.
 *
 * ================================================================================================
 * WHAT THIS COMPONENT MAY AND MAY NOT DECIDE
 * ================================================================================================
 *
 * It decides NOTHING about the window. `canAmendLine` is an AFFORDANCE — it stops the sheet
 * offering an edit that is certainly doomed — but the server is the authority, and it can refuse a
 * line this screen thought was open, because the kitchen may tap Cooked between the render and the
 * press. That race is the whole reason refusals come back per line, and it is why this sheet
 * renders `refused` rather than treating a 200 with refusals as success.
 *
 * ONE CALL. A quantity change is void-plus-add inside one server transaction. This component never
 * issues two requests, and never retries the refused half of a result: those lines were refused
 * because the kitchen already has them, and re-sending them would either fail again or, worse,
 * void food that is being cooked.
 */
import React, {useCallback, useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing} from '../constants/theme';
import * as Copy from '../constants/amendCopy';
import {amendTabLines, ApiRequestError} from '../lib/api';
import {canAmendLine, type AmendResult, type RefusedAmendment} from '../lib/amendTabLines';
import {getTerminalToken} from '../lib/storage';
import type {TabLine} from '../lib/tabLines';

type Props = {
  tabId: string;
  line: TabLine | null;
  onClose: () => void;
  /** Called after a successful call so the screen can refetch. Never called on a refusal-only result. */
  onAmended: () => void;
};

export default function AmendLineSheet({tabId, line, onClose, onAmended}: Props) {
  const [quantity, setQuantity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<RefusedAmendment[]>([]);

  const open = line != null;
  const current = quantity ?? line?.quantity ?? 0;
  const editable = line != null && canAmendLine(line);

  const reset = useCallback(() => {
    setQuantity(null);
    setBusy(false);
    setFailure(null);
    setRefusals([]);
  }, []);

  const dismiss = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const submit = useCallback(
    async (nextQuantity: number) => {
      if (!line || busy) {
        return;
      }
      setBusy(true);
      setFailure(null);
      setRefusals([]);

      try {
        const token = await getTerminalToken();
        if (!token) {
          throw new Error(Copy.AMEND_NO_SESSION);
        }

        const result: AmendResult = await amendTabLines(
          tabId,
          [{line_id: line.id, new_quantity: nextQuantity}],
          token,
        );

        /**
         * A 200 can still mean nothing changed. `applied` empty with `refused` populated is the
         * kitchen having won the race, and it must NOT read as success — the waiter has to know
         * the line is still exactly as the customer will be charged for it.
         */
        if (result.applied.length === 0 && result.refused.length > 0) {
          setRefusals(result.refused);
          setBusy(false);
          return;
        }

        reset();
        onAmended();
        onClose();
      } catch (err) {
        const coded = err instanceof ApiRequestError ? err.code : null;
        setFailure(
          coded === 'AMEND_FAILED'
            ? Copy.AMEND_FAILED_NOTHING_CHANGED
            : err instanceof Error
            ? err.message
            : Copy.AMEND_FAILED_NOTHING_CHANGED,
        );
        setBusy(false);
      }
    },
    [busy, line, onAmended, onClose, reset, tabId],
  );

  if (!open || !line) {
    return null;
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title} numberOfLines={2}>
            {line.name_snapshot}
          </Text>

          {/* The window is closed. Say so and offer nothing — an edit control here would be a
              button that cannot work. */}
          {!editable ? (
            <>
              <Text style={styles.body}>{Copy.AMEND_WINDOW_CLOSED}</Text>
              <Pressable style={styles.secondaryButton} onPress={dismiss}>
                <Text style={styles.secondaryText}>{Copy.AMEND_DISMISS}</Text>
              </Pressable>
            </>
          ) : refusals.length > 0 ? (
            <>
              {/* The race, rendered. Per line, because a round can be half-cooked. */}
              <Text style={styles.body}>{Copy.AMEND_REFUSED_HEADING}</Text>
              {refusals.map(r => (
                <View key={r.line_id} style={styles.refusalRow}>
                  <MaterialCommunityIcons
                    name="alert-circle-outline"
                    size={18}
                    color={Colors.red}
                  />
                  <Text style={styles.refusalText}>
                    {Copy.AMEND_REFUSAL_REASON[r.reason] ?? Copy.AMEND_REFUSAL_UNKNOWN}
                  </Text>
                </View>
              ))}
              <Pressable style={styles.secondaryButton} onPress={dismiss}>
                <Text style={styles.secondaryText}>{Copy.AMEND_DISMISS}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.body}>{Copy.AMEND_BODY}</Text>

              <View style={styles.stepper}>
                <Pressable
                  style={styles.stepButton}
                  disabled={busy || current <= 0}
                  onPress={() => setQuantity(Math.max(0, current - 1))}>
                  <MaterialCommunityIcons name="minus" size={28} color={Colors.textPrimary} />
                </Pressable>
                <Text style={styles.quantity}>{current}</Text>
                <Pressable
                  style={styles.stepButton}
                  disabled={busy}
                  onPress={() => setQuantity(current + 1)}>
                  <MaterialCommunityIcons name="plus" size={28} color={Colors.textPrimary} />
                </Pressable>
              </View>

              {/* Zero is a removal, and it says so rather than looking like a quantity of none. */}
              <Text style={styles.effect}>
                {current === 0 ? Copy.AMEND_EFFECT_REMOVE : Copy.AMEND_EFFECT_CHANGE}
              </Text>

              {failure ? <Text style={styles.failure}>{failure}</Text> : null}

              <Pressable
                style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
                disabled={busy || current === line.quantity}
                onPress={() => submit(current)}>
                <Text style={styles.primaryText}>
                  {busy ? Copy.AMEND_IN_PROGRESS : Copy.AMEND_CONFIRM}
                </Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} disabled={busy} onPress={dismiss}>
                <Text style={styles.secondaryText}>{Copy.AMEND_CANCEL}</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  title: {fontSize: 24, fontWeight: '800', color: Colors.textPrimary},
  body: {fontSize: 16, color: Colors.textSecondary, lineHeight: 22},
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginVertical: Spacing.sm,
  },
  stepButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quantity: {fontSize: 40, fontWeight: '800', color: Colors.textPrimary, minWidth: 60, textAlign: 'center'},
  effect: {fontSize: 15, color: Colors.textSecondary, textAlign: 'center'},
  failure: {fontSize: 15, color: Colors.red, lineHeight: 21},
  refusalRow: {flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs},
  refusalText: {flex: 1, fontSize: 15, color: Colors.textPrimary, lineHeight: 21},
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryButtonDisabled: {backgroundColor: Colors.surface},
  primaryText: {color: Colors.white, fontSize: 18, fontWeight: '700'},
  secondaryButton: {paddingVertical: 16, alignItems: 'center'},
  secondaryText: {color: Colors.textSecondary, fontSize: 16, fontWeight: '600'},
});
