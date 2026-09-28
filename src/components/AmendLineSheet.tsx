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
 *
 * ================================================================================================
 * SUCCESS IS SAID, NEVER IMPLIED. (Sprint 2026-09-28 brief — Riviera Table 1, order #160.)
 * ================================================================================================
 *
 * A tester believed they had cancelled Modena Pasta N$240. The server never recorded anything, and
 * the dish was cooked. Success here used to be signalled ONLY by the sheet closing, which looks
 * exactly like "Leave it as it is", the back button, or walking away mid-PIN; and a 200 with the
 * line missing from `applied` closed the sheet too. So:
 *
 *   - The sheet stays open after every request and SAYS the outcome. "Removed — N$x off the bill"
 *     appears only when the server's `applied` names this line (lineAmendOutcome).
 *   - A refusal names the reason and says NOT removed, still on the bill.
 *   - Anything else — timeout, no network, 5xx, unreadable 200, a 200 silent about this line —
 *     reads "Cancellation NOT confirmed — check the table". Never success.
 *   - After EVERY outcome, and if the sheet goes away with a request in flight, `onRefetch` asks
 *     the screen to re-read the tab from the server. The list is never patched locally.
 *   - While a request is in flight the sheet cannot be dismissed (buttons, back button), and a
 *     response that arrives for a request this sheet no longer owns is dropped.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing} from '../constants/theme';
import * as Copy from '../constants/amendCopy';
import {
  amendTabLines,
  ApiRequestError,
  authorizeTerminalAction,
  RequestOutcomeUnknownError,
  TerminalAuthError,
} from '../lib/api';
import {
  amountOffCents,
  canAmendLine,
  lineAmendOutcome,
  type LineAmendOutcome,
} from '../lib/amendTabLines';
import {getTerminalToken} from '../lib/storage';
import type {TabLine} from '../lib/tabLines';
import VoidApproval from './VoidApproval';
import {
  isReduction,
  reductionEffect,
  voidApprovalComplete,
  voidFailureMessage,
  type VoidApprovalDraft,
} from '../lib/voidApproval';
import {VOID_CONFIRM} from '../constants/voidCopy';

type Props = {
  tabId: string;
  line: TabLine | null;
  onClose: () => void;
  /**
   * RE-READ THE TAB. Called after every request outcome — confirmed, refused, failed or unknown —
   * and when the sheet is torn down with a request still in flight. It says nothing about success:
   * the sheet stays open and tells the waiter what happened. Never close the sheet from here.
   */
  onRefetch: () => void;
};

/** What the sheet is saying after a request. Only `success` is ever green. */
type Verdict = {tone: 'success' | 'refused' | 'unknown'; title: string; body?: string};

function money(cents: number): string {
  return `N$${(cents / 100).toFixed(2)}`;
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}

/** The words for one line's outcome. Exported for the scenario tests; not a second decision. */
export function verdictFor(
  outcome: LineAmendOutcome,
  line: {name_snapshot: string; total_cents?: number | null},
  isVoid: boolean,
): Verdict {
  const name = line.name_snapshot;
  if (outcome.kind === 'confirmed') {
    const off = amountOffCents(line.total_cents, outcome.previousQuantity, outcome.quantity);
    if (outcome.effect === 'removed') {
      return {
        tone: 'success',
        title:
          off != null
            ? fill(Copy.AMEND_CONFIRMED_REMOVED, {name, amount: money(off)})
            : fill(Copy.AMEND_CONFIRMED_REMOVED_NO_AMOUNT, {name}),
      };
    }
    if (outcome.effect === 'reduced') {
      return {
        tone: 'success',
        title:
          off != null
            ? fill(Copy.AMEND_CONFIRMED_REDUCED, {name, quantity: outcome.quantity, amount: money(off)})
            : fill(Copy.AMEND_CONFIRMED_REDUCED_NO_AMOUNT, {name, quantity: outcome.quantity}),
      };
    }
    return {
      tone: 'success',
      title: fill(Copy.AMEND_CONFIRMED_INCREASED, {name, quantity: outcome.quantity}),
    };
  }
  if (outcome.kind === 'refused') {
    return {
      tone: 'refused',
      title: fill(Copy.AMEND_REFUSED_TITLE, {name}),
      body: Copy.AMEND_REFUSAL_REASON[outcome.reason] ?? Copy.AMEND_REFUSAL_UNKNOWN,
    };
  }
  return unknownVerdict(isVoid);
}

function unknownVerdict(isVoid: boolean): Verdict {
  return {
    tone: 'unknown',
    title: isVoid ? Copy.AMEND_NOT_CONFIRMED_TITLE : Copy.AMEND_CHANGE_NOT_CONFIRMED_TITLE,
    body: Copy.AMEND_NOT_CONFIRMED_BODY,
  };
}

/** A failure at /authorize. The amend was never sent, so every one of these is definite. */
function authorizeFailureMessage(err: unknown): string {
  if (err instanceof RequestOutcomeUnknownError) {
    return Copy.AMEND_AUTHORIZE_UNREACHABLE;
  }
  if (err instanceof TerminalAuthError) {
    return Copy.AMEND_NO_SESSION;
  }
  if (err instanceof ApiRequestError) {
    if (err.code === 'PIN_MISMATCH') {
      // The route's own count, when it sent one: the next wrong PIN may lock this manager out.
      const base = voidFailureMessage('PIN_MISMATCH') ?? Copy.AMEND_AUTHORIZE_UNREACHABLE;
      return err.attemptsRemaining != null
        ? `${base} ${err.attemptsRemaining} ${err.attemptsRemaining === 1 ? 'try' : 'tries'} left before it locks.`
        : base;
    }
    // PIN_LOCKED carries its own lockout copy in the message.
    if (err.code === 'PIN_LOCKED') {
      return `${err.message} Nothing came off the bill.`;
    }
    return voidFailureMessage(err.code ?? null) ?? Copy.AMEND_AUTHORIZE_UNREACHABLE;
  }
  return Copy.AMEND_AUTHORIZE_UNREACHABLE;
}

export default function AmendLineSheet({tabId, line, onClose, onRefetch}: Props) {
  const [quantity, setQuantity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [approval, setApproval] = useState<VoidApprovalDraft | null>(null);

  /**
   * WHICH REQUEST THIS SHEET STILL OWNS. Bumped on every submit and every teardown; a response
   * whose id is no longer current is dropped, so a late answer can never paint "removed" onto a
   * sheet that has since been reset or opened for another line.
   */
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);
  const onRefetchRef = useRef(onRefetch);
  onRefetchRef.current = onRefetch;

  const open = line != null;
  const current = quantity ?? line?.quantity ?? 0;
  const editable = line != null && canAmendLine(line);
  const lineId = line?.id ?? null;

  /**
   * TAKING FOOD OFF THE BILL, WHICH IS NOT THE SAME AS CHANGING A QUANTITY.
   *
   * Tested against the line's CURRENT quantity, exactly as the server tests it, so the sheet asks
   * for a PIN in precisely the cases the server demands one. 3→1 is as much a void as 3→0.
   */
  const isVoid = line != null && isReduction(line.quantity, current);

  const reset = useCallback(() => {
    setQuantity(null);
    setBusy(false);
    setFailure(null);
    setVerdict(null);
    setApproval(null);
  }, []);

  /**
   * The sheet went away (another line, or unmounted) while a request was out. Its answer can no
   * longer be shown, so it is disowned — and the tab is re-read, because the server may have acted
   * on it. This is the ONLY way a request's outcome reaches the screen without the sheet saying it.
   */
  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (inFlightRef.current) {
        inFlightRef.current = false;
        onRefetchRef.current();
      }
    };
  }, [lineId]);

  // A different line is a different sheet.
  useEffect(() => {
    reset();
  }, [lineId, reset]);

  const dismiss = useCallback(() => {
    // Blocked while a request is out: closing mid-request is exactly how a waiter walks away
    // believing something happened.
    if (inFlightRef.current) {
      return;
    }
    reset();
    onClose();
  }, [onClose, reset]);

  const submit = useCallback(
    async (nextQuantity: number) => {
      if (!line || inFlightRef.current) {
        return;
      }
      const requestId = ++requestIdRef.current;
      const owned = () => requestIdRef.current === requestId;
      inFlightRef.current = true;
      setBusy(true);
      setFailure(null);
      setVerdict(null);
      const voiding = isReduction(line.quantity, nextQuantity);

      const finish = () => {
        if (!owned()) {
          return;
        }
        inFlightRef.current = false;
        setBusy(false);
        // After ANY outcome. The screen re-reads what the server has; nothing is patched here.
        onRefetchRef.current();
      };

      const token = await getTerminalToken().catch(() => null);
      if (!owned()) {
        return;
      }
      if (!token) {
        setFailure(Copy.AMEND_NO_SESSION);
        finish();
        return;
      }

      /**
       * MINTED AND SPENT IN ONE PRESS.
       *
       * The PIN buys a single-use, short-lived token for purpose 'line_void', and the amend
       * consumes it. Doing both here rather than on a separate Approve tap means the token
       * cannot expire while the table argues about the bill, and means there is no state in
       * which a manager has approved and nothing has happened.
       *
       * The permission is checked at BOTH ends -- mint and consume -- since 2026-09-04, because
       * one enforcement point is one bug away from none.
       */
      let extras: Parameters<typeof amendTabLines>[3];
      if (voiding) {
        if (!voidApprovalComplete(approval) || !approval) {
          // Unreachable through the button, which is disabled until this is true. Kept because
          // "the button was disabled" is not an authorisation check.
          inFlightRef.current = false;
          setBusy(false);
          return;
        }
        try {
          const auth = await authorizeTerminalAction(
            approval.staffUserId,
            approval.pin.trim(),
            'line_void',
            token,
          );
          extras = {
            staffUserId: approval.staffUserId,
            authorizationTokenId: auth.token_id,
            voidReason: approval.reason.trim(),
          };
        } catch (err) {
          if (!owned()) {
            return;
          }
          // Nothing was sent to the amend route, so this is definite: nothing came off.
          setFailure(authorizeFailureMessage(err));
          // The PIN is cleared on any failure. Leaving it on screen after a refusal invites a
          // second press of the same wrong code, and it is somebody's PIN at a table.
          setApproval(prev => (prev ? {...prev, pin: ''} : prev));
          finish();
          return;
        }
      }

      try {
        const result = await amendTabLines(
          tabId,
          [{line_id: line.id, new_quantity: nextQuantity}],
          token,
          extras,
        );
        if (!owned()) {
          return;
        }
        setVerdict(
          verdictFor(
            lineAmendOutcome(result, {
              lineId: line.id,
              previousQuantity: line.quantity,
              requestedQuantity: nextQuantity,
            }),
            line,
            voiding,
          ),
        );
      } catch (err) {
        if (!owned()) {
          return;
        }
        const coded = err instanceof ApiRequestError && err.status < 500 ? err.code ?? null : null;
        // The named approval refusals are 400/403s the route returns BEFORE it touches a line, so
        // each can say "nothing changed" truthfully and leave the editor up for another try.
        const definite = voidFailureMessage(coded);
        if (definite) {
          setFailure(definite);
          setApproval(prev => (prev ? {...prev, pin: ''} : prev));
        } else if (err instanceof TerminalAuthError) {
          setFailure(Copy.AMEND_NO_SESSION);
        } else {
          // Timeout, no network, 5xx, anything unrecognised: the server may have done it.
          setVerdict(unknownVerdict(voiding));
        }
      }
      finish();
    },
    [approval, line, tabId],
  );

  if (!open || !line) {
    return null;
  }

  const verdictColor =
    verdict?.tone === 'success' ? Colors.green : verdict?.tone === 'refused' ? Colors.red : Colors.amber;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      // The hardware back button. Ignored while a request is out — see dismiss.
      onRequestClose={dismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="amend-sheet">
          <Text style={styles.title} numberOfLines={2}>
            {line.name_snapshot}
          </Text>

          {line.is_voided ? (
            <>
              <Text style={styles.body} testID="amend-already-voided">
                {Copy.AMEND_ALREADY_VOIDED}
              </Text>
              <Pressable style={styles.secondaryButton} onPress={dismiss} testID="amend-dismiss">
                <Text style={styles.secondaryText}>{Copy.AMEND_DISMISS}</Text>
              </Pressable>
            </>
          ) : !editable ? (
            <>
              {/* Cooked. Tappable so the waiter gets an answer, and the answer is that nothing
                  has been removed — never an invitation to cancel it by word of mouth. */}
              <Text style={styles.body} testID="amend-window-closed">
                {Copy.AMEND_WINDOW_CLOSED}
              </Text>
              <Pressable style={styles.secondaryButton} onPress={dismiss} testID="amend-dismiss">
                <Text style={styles.secondaryText}>{Copy.AMEND_DISMISS}</Text>
              </Pressable>
            </>
          ) : verdict ? (
            <>
              <View style={styles.verdictRow} testID={`amend-verdict-${verdict.tone}`}>
                <MaterialCommunityIcons
                  name={
                    verdict.tone === 'success'
                      ? 'check-circle-outline'
                      : verdict.tone === 'refused'
                      ? 'alert-circle-outline'
                      : 'help-circle-outline'
                  }
                  size={22}
                  color={verdictColor}
                />
                <Text style={[styles.verdictTitle, {color: verdictColor}]} testID="amend-verdict-title">
                  {verdict.title}
                </Text>
              </View>
              {verdict.body ? (
                <Text style={styles.body} testID="amend-verdict-body">
                  {verdict.body}
                </Text>
              ) : null}
              <Pressable style={styles.secondaryButton} onPress={dismiss} testID="amend-dismiss">
                <Text style={styles.secondaryText}>{Copy.AMEND_DISMISS}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.body}>{Copy.AMEND_BODY}</Text>

              <View style={styles.stepper}>
                <Pressable
                  testID="amend-minus"
                  style={styles.stepButton}
                  disabled={busy || current <= 0}
                  onPress={() => setQuantity(Math.max(0, current - 1))}>
                  <MaterialCommunityIcons name="minus" size={28} color={Colors.textPrimary} />
                </Pressable>
                <Text style={styles.quantity}>{current}</Text>
                <Pressable
                  testID="amend-plus"
                  style={styles.stepButton}
                  disabled={busy}
                  onPress={() => setQuantity(current + 1)}>
                  <MaterialCommunityIcons name="plus" size={28} color={Colors.textPrimary} />
                </Pressable>
              </View>

              {/* Zero is a removal and says so; so does 3→1, which takes two off the bill and
                  used to read as an ordinary quantity change. */}
              <Text style={styles.effect} testID="amend-effect">
                {reductionEffect(line.quantity, current)}
              </Text>

              {/* Only when food is coming off. An increase needs nobody's approval. */}
              {isVoid ? (
                <VoidApproval draft={approval} onChange={setApproval} disabled={busy} />
              ) : null}

              {failure ? (
                <Text style={styles.failure} testID="amend-failure">
                  {failure}
                </Text>
              ) : null}

              <Pressable
                testID="amend-confirm"
                style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
                disabled={
                  busy ||
                  current === line.quantity ||
                  // A void with nobody named, no PIN or no reason is refused by the server. The
                  // button is dead rather than letting a waiter announce it and be told after.
                  (isVoid && !voidApprovalComplete(approval))
                }
                onPress={() => submit(current)}>
                <Text style={styles.primaryText}>
                  {busy ? Copy.AMEND_WAIT : isVoid ? VOID_CONFIRM : Copy.AMEND_CONFIRM}
                </Text>
              </Pressable>
              <Pressable
                testID="amend-cancel"
                style={styles.secondaryButton}
                disabled={busy}
                onPress={dismiss}>
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
  verdictRow: {flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.xs},
  verdictTitle: {flex: 1, fontSize: 18, fontWeight: '700', lineHeight: 24},
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
