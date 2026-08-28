import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import StrandedRequestPrompt from './StrandedRequestPrompt';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  CLOSE_CONFIRM_ACTION,
  CLOSE_CONFIRM_BODY,
  CLOSE_CONFIRM_BODY_NO_LINE_TRACKING,
  CLOSE_CONFIRM_CANCEL,
  CLOSE_CONFIRM_TITLE,
  CLOSE_FAILED_GENERIC,
  CLOSE_FAILED_PENDING_REQUESTS,
  CLOSE_REFUSED_BODY,
  CLOSE_REFUSED_DISMISS,
  CLOSE_REFUSED_TITLE,
  CLOSE_TABLE_BUTTON,
  CLOSE_TABLE_CHECKING,
  CLOSE_TABLE_IN_PROGRESS,
  CLOSE_TABLE_REFUSAL_COPY,
} from '../constants/closeTableCopy';
import {
  ApiRequestError,
  closeTable,
  getTablesWithMeta,
  getTabLines,
  PendingOrderRequest,
} from '../lib/api';
import {
  CloseTableRefusalId,
  evaluateCloseTableRefusals,
  findTableRow,
} from '../lib/closeTableRefusals';
import {getTerminalToken} from '../lib/storage';
import {useServiceSession} from '../context/ServiceSessionContext';

/**
 * CLOSE TABLE, ON THE WAITER TABLE VIEW.
 *
 * SETTLING IS NOT CLOSING, AND PAID IS NOT CLOSED. Taking money settles ORDERS; the tab carries
 * `settled_at` separately from `status` and the settle route treats the two as different facts.
 * This control is the only thing on this screen that ends a session, and it only ever runs from a
 * deliberate press. There is NO effect in this file, and no branch anywhere in it, that closes a
 * table because it noticed the table was paid. A settled tab is an ordinary input to closing, not
 * a trigger for it.
 *
 * WHY THE WHOLE CONTROL LIVES IN ONE COMPONENT. Another agent is building the settle control on
 * this same screen in this same cycle. Everything here — button, pre-flight, both sheets, the
 * request, the failure handling — is inside this file so that ServiceTableScreen gains an import
 * and one element, and the two pieces of work do not fight over a screen body.
 *
 * WHY THE CHECK RUNS ON PRESS RATHER THAN ON LOAD:
 *
 *   1. FRESHNESS. A verdict computed when the screen loaded would be answering about a table that
 *      has since been paid, cooked for, or charged. The one moment the answer must be true is the
 *      moment the waiter asks.
 *   2. AN ANSWER BEATS A DEAD BUTTON. A greyed-out control tells a waiter nothing and sends them
 *      to the dashboard. This one always presses, and when it refuses it says every reason.
 *
 * The refusal set itself is NOT here. It is lib/closeTableRefusals, which is the single place to
 * change it. This file gathers the snapshot and renders the verdict; it never decides one.
 */

type Props = {
  tableId: string;
  tabId: string;
  /** Lines already in this device's unsent basket for this tab. Feeds one refusal rule. */
  unsentRoundLineCount: number;
  /** Called after the server confirms the close, so the screen can leave. */
  onClosed: () => void;
};

type Phase = 'idle' | 'checking' | 'refused' | 'confirming' | 'closing';

export default function CloseTableAction({
  tableId,
  tabId,
  unsentRoundLineCount,
  onClosed,
}: Props) {
  const {table: sessionTable, endSession} = useServiceSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [refusals, setRefusals] = useState<CloseTableRefusalId[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [strandedRequests, setStrandedRequests] = useState<PendingOrderRequest[]>([]);
  const [strandedMessage, setStrandedMessage] = useState<string>('');
  /**
   * Whether the tab this close is about has NO line tracking. Captured from the PRE-FLIGHT
   * SNAPSHOT rather than re-read at render: the sheet must describe the table as it was when the
   * rules were evaluated, and a refetch in between would let it describe one table while the
   * verdict came from another.
   */
  const [noLineTracking, setNoLineTracking] = useState(false);

  /**
   * Re-read both halves of the truth, then ask the refusal set.
   *
   * BOTH FETCHES ARE INDIVIDUALLY CAUGHT AND TURNED INTO NULL rather than thrown. A failure to
   * read is not an error to show — it is a refusal, and rules 1 and 2 are what say so. Throwing
   * here would surface a network message where the waiter needs a reason.
   *
   * The tables route collapses 401 and 403 into TerminalAuthError, unlike the service routes. That
   * is swallowed here too, deliberately: an expired terminal session must not be reported by this
   * button as anything other than "cannot tell, so no". The screen's own loader is what surfaces a
   * dead session, on its next refresh.
   */
  const runPreflight = useCallback(async () => {
    const token = await getTerminalToken().catch(() => null);
    if (!token) {
      return {
        table: null,
        lines: null,
        cardInFlightTimeoutSeconds: null,
        unsentRoundLineCount,
      };
    }

    const [tablesResult, linesResult] = await Promise.all([
      getTablesWithMeta(token).catch(() => null),
      getTabLines(tabId, token).catch(() => null),
    ]);

    return {
      table: findTableRow(tablesResult?.tables ?? null, tableId),
      lines: linesResult,
      cardInFlightTimeoutSeconds: tablesResult?.cardInFlightTimeoutSeconds ?? null,
      unsentRoundLineCount,
    };
  }, [tabId, tableId, unsentRoundLineCount]);

  const handlePress = useCallback(async () => {
    setFailure(null);
    setPhase('checking');
    const snapshot = await runPreflight();
    // A settled QR tab now passes the rules (owner's ruling 2026-08-28), and the confirm sheet is
    // the only place the waiter learns nothing checked the food. See closeTableRefusals rule 11.
    setNoLineTracking(snapshot.lines != null && snapshot.lines.has_lines !== true);
    const found = evaluateCloseTableRefusals(snapshot);
    if (found.length > 0) {
      setRefusals(found);
      setPhase('refused');
      return;
    }
    setRefusals([]);
    setPhase('confirming');
  }, [runPreflight]);

  const handleConfirm = useCallback(async () => {
    setPhase('closing');
    setFailure(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Terminal session not found.');
      }
      await closeTable(tableId, token);

      /**
       * The session on THIS DEVICE dies with the table it was holding.
       *
       * Not a refusal and not a server fact — a device-local consequence. The waiter session is
       * the only place a "waiter session" exists anywhere in the system, and leaving one pointed
       * at a tab that no longer exists means the next Add Round on this screen walks into a closed
       * tab. Only cleared when the session is actually holding THIS tab; another table's session
       * is none of this control's business.
       */
      if (sessionTable && sessionTable.tabId === tabId) {
        endSession();
      }

      setPhase('idle');
      onClosed();
    } catch (err) {
      /**
       * THE REFUSAL THIS DEVICE CANNOT PREDICT.
       *
       * Rounds a customer placed that are still waiting to be accepted or declined block the close
       * server-side, and neither payload the pre-flight reads carries them. The 409 names the rows
       * and, per row, whether each is a stranded `accepting` claim that staff can release or a real
       * `waiting_review` round they must go and review. Showing that is the difference between a
       * dead end and an answer, so it is handed to the shared prompt rather than flattened into a
       * failure message.
       */
      if (
        err instanceof ApiRequestError &&
        err.code === 'PENDING_ORDER_REQUESTS' &&
        err.pendingRequests.length > 0
      ) {
        setStrandedRequests(err.pendingRequests);
        setStrandedMessage(err.message);
        setPhase('idle');
        return;
      }
      setFailure(
        err instanceof ApiRequestError && err.code === 'PENDING_ORDER_REQUESTS'
          ? CLOSE_FAILED_PENDING_REQUESTS
          : CLOSE_FAILED_GENERIC,
      );
      setPhase('idle');
    }
  }, [endSession, onClosed, sessionTable, tabId, tableId]);

  const busy = phase === 'checking' || phase === 'closing';

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{busy}}
        testID="close-table-button"
        style={[styles.button, busy && styles.buttonBusy]}
        disabled={busy}
        onPress={handlePress}>
        {busy ? (
          <ActivityIndicator color={Colors.textPrimary} />
        ) : (
          <MaterialCommunityIcons
            name="table-off"
            size={22}
            color={Colors.textPrimary}
          />
        )}
        <Text style={styles.buttonText} numberOfLines={1}>
          {phase === 'checking'
            ? CLOSE_TABLE_CHECKING
            : phase === 'closing'
            ? CLOSE_TABLE_IN_PROGRESS
            : CLOSE_TABLE_BUTTON}
        </Text>
      </Pressable>

      {failure ? (
        <Text testID="close-table-failure" style={styles.failureText}>
          {failure}
        </Text>
      ) : null}

      {/* EVERY reason, not the first one. A waiter fixing one and being sent back for a second
          they could have fixed on the same trip has been told the truth twice instead of once. */}
      <Modal
        visible={phase === 'refused'}
        transparent
        animationType="fade"
        onRequestClose={() => setPhase('idle')}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} testID="close-table-refusal-sheet">
            <Text style={styles.sheetTitle}>{CLOSE_REFUSED_TITLE}</Text>
            <Text style={styles.sheetBody}>{CLOSE_REFUSED_BODY}</Text>
            <ScrollView style={styles.reasonScroll}>
              {refusals.map(id => (
                <View key={id} style={styles.reasonRow} testID={`close-refusal-${id}`}>
                  <MaterialCommunityIcons
                    name="alert-circle-outline"
                    size={18}
                    color={Colors.red}
                  />
                  <Text style={styles.reasonText}>
                    {CLOSE_TABLE_REFUSAL_COPY[id]}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <Pressable
              style={styles.secondaryAction}
              testID="close-refusal-dismiss"
              onPress={() => setPhase('idle')}>
              <Text style={styles.secondaryActionText}>
                {CLOSE_REFUSED_DISMISS}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={phase === 'confirming'}
        transparent
        animationType="fade"
        onRequestClose={() => setPhase('idle')}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} testID="close-table-confirm-sheet">
            <Text style={styles.sheetTitle}>{CLOSE_CONFIRM_TITLE}</Text>
            <Text style={styles.sheetBody}>
              {noLineTracking
                ? CLOSE_CONFIRM_BODY_NO_LINE_TRACKING
                : CLOSE_CONFIRM_BODY}
            </Text>
            <Pressable
              style={styles.primaryAction}
              testID="close-table-confirm"
              onPress={handleConfirm}>
              <Text style={styles.primaryActionText}>{CLOSE_CONFIRM_ACTION}</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryAction}
              testID="close-table-cancel"
              onPress={() => setPhase('idle')}>
              <Text style={styles.secondaryActionText}>
                {CLOSE_CONFIRM_CANCEL}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <StrandedRequestPrompt
        visible={strandedRequests.length > 0}
        requests={strandedRequests}
        message={strandedMessage}
        onDismiss={() => setStrandedRequests([])}
        onReleased={() => {
          setStrandedRequests([]);
          // Straight back to the pre-flight, never straight to the close: releasing a stranded
          // claim clears ONE reason, and the rest of the refusal set has not been re-asked.
          handlePress();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 18,
    paddingHorizontal: Spacing.md,
    minHeight: 60,
  },
  buttonBusy: {opacity: 0.6},
  buttonText: {
    color: Colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  failureText: {
    ...Typography.small,
    color: Colors.red,
    marginTop: Spacing.xs,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  sheetTitle: {...Typography.subheading, color: Colors.textPrimary},
  sheetBody: {...Typography.small, color: Colors.textSecondary},
  reasonScroll: {maxHeight: 260},
  reasonRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: Colors.redLight,
    borderRadius: 10,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  reasonText: {flex: 1, ...Typography.small, color: Colors.red},
  primaryAction: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryActionText: {color: Colors.white, fontSize: 18, fontWeight: '700'},
  secondaryAction: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  secondaryActionText: {
    color: Colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
});
