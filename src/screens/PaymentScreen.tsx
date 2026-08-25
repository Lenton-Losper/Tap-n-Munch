import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import LoadingButton from '../components/LoadingButton';
import {usePaymentStateMachine} from '../components/PaymentStateMachine';
import StrandedRequestPrompt from '../components/StrandedRequestPrompt';
import HeldOrphanPaymentNotice from '../components/HeldOrphanPaymentNotice';
import {PAYMENT_ADVISORY_CEILING_S} from '../constants';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  ApiRequestError,
  closeTable,
  completePayment,
  completePaymentReliably,
  getOrder,
  getTerminalInfo,
  recordSaleEvent,
  resolvePaymentMethodsAvailability,
  verifyTerminalPayment,
  type CompletePaymentResult,
  type PendingOrderRequest,
} from '../lib/api';
import {
  classifyFailureReport,
  classifySuccessReportError,
} from '../lib/paymentReportOutcome';
import {
  ALREADY_SETTLED_MESSAGE,
  UNCONFIRMED_CHECK_ACTION,
  UNCONFIRMED_CHECK_FAILED,
  UNCONFIRMED_CHECK_IN_PROGRESS,
  UNCONFIRMED_EXPLANATION,
  UNCONFIRMED_INSTRUCTION,
  UNCONFIRMED_NOT_REPORTED,
  UNCONFIRMED_RETRY_ACTION,
  UNCONFIRMED_STILL_UNRESOLVED,
  UNCONFIRMED_TITLE,
  paymentProcessingElapsed,
  PAYMENT_OVER_CEILING_TITLE,
  PAYMENT_OVER_CEILING_BODY,
  PAYMENT_CHECK_STATUS_LABEL,
} from '../constants/paymentCopy';
import {formatCurrency, getItemLineTotal} from '../lib/currency';
import {getPostPaymentAction} from '../lib/postPaymentAction';
import {
  declinedFailureReference,
  processPaymentIntent,
  resolveAmbiguousPaymentWithFinatic,
  unconfirmedFailureReference,
  TERMINAL_USER_CANCELLED_REASON,
  type PaymentResult,
} from '../lib/payment';
import {recordWiretapEvent} from '../lib/wiretap';
import {printReceiptForOrder, sendReceiptEmailForOrder} from '../lib/receiptPrinting';
import {
  describeReceiptPrintError,
  getReceiptPrintingEnabled,
} from '../lib/receiptPrintSettings';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';
import StatusBadge from '../components/StatusBadge';
import {Order} from '../types';

type Props = NativeStackScreenProps<MainStackParamList, 'Payment'>;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAmountPaid(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `NAD ${safe.toFixed(2)}`;
}

export default function PaymentScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {orderId, tableId, tableNumber, total, orderNumber, placedAt} =
    route.params;
  const {
    machineState,
    isHydrated,
    startPayment,
    paymentSuccess,
    paymentFailed,
    paymentUnconfirmed,
    reset,
  } = usePaymentStateMachine(orderId);
  /** #327. In-flight guard for the idempotent status check offered on the UNCONFIRMED screen. */
  const [checkingStatus, setCheckingStatus] = useState(false);
  /**
   * #346 — HOW LONG THIS PAYMENT HAS BEEN RUNNING. Ticks once a second while the payment is in
   * flight and resets to 0 when it is not, so the pill can show elapsed time and a ceiling
   * instead of an unbounded "please wait".
   *
   * The old screen showed no duration at all, which is why staff could not tell 3 seconds from 3
   * minutes and re-rang the sale at a median of 42s. See paymentCopy's #346 block.
   */
  const [paymentElapsedS, setPaymentElapsedS] = useState(0);
  /**
   * #326. Set when this order was found ALREADY paid rather than paid by this attempt. The screen
   * is a success either way — the money is there — but saying so plainly beats a bare "Payment
   * successful" that hides the fact that this attempt was not what settled it.
   */
  const [alreadySettled, setAlreadySettled] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(true);
  const [closingTable, setClosingTable] = useState(false);
  /** #120 residual: rows blocking this close, and the close route's own message. */
  const [strandedRequests, setStrandedRequests] = useState<PendingOrderRequest[]>([]);
  const [strandedMessage, setStrandedMessage] = useState('');
  const [canCloseTable, setCanCloseTable] = useState(false);
  const [printState, setPrintState] = useState<
    'idle' | 'printing' | 'success' | 'failed'
  >('idle');
  const [printError, setPrintError] = useState<string | null>(null);
  const [emailState, setEmailState] = useState<
    'idle' | 'sending' | 'success' | 'failed'
  >('idle');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [lastEmailSentTo, setLastEmailSentTo] = useState<string | null>(null);
  const [showEmailPrompt, setShowEmailPrompt] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [emailPromptError, setEmailPromptError] = useState<string | null>(null);
  const [receiptSkipped, setReceiptSkipped] = useState(false);
  /** Runtime developer toggle (Diagnostics). Default false until enabled. */
  const [receiptPrintingEnabled, setReceiptPrintingEnabled] = useState(false);
  /** Kiosk: defer leave until print settles (when printing is on). */
  const [kioskAutoReturnPending, setKioskAutoReturnPending] = useState(false);
  const [kioskAutoReturnDelayMs, setKioskAutoReturnDelayMs] = useState(3000);
  /** Chosen before launching Finatic or cash tender UI. */
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'cash' | null>(
    null,
  );
  /** Raw tendered input (digits + optional decimal). */
  const [tenderedText, setTenderedText] = useState('');
  /** From GET /api/terminal/me — refreshed each time Charge is focused. */
  const [cardPaymentEnabled, setCardPaymentEnabled] = useState(true);
  const [cashPaymentEnabled, setCashPaymentEnabled] = useState(true);
  const [paymentConfigLoading, setPaymentConfigLoading] = useState(true);
  const [paymentConfigError, setPaymentConfigError] = useState<string | null>(
    null,
  );

  const resolvedTableId = order?.table_id ?? tableId;
  const bothMethodsEnabled = cardPaymentEnabled && cashPaymentEnabled;
  const noMethodsEnabled = !cardPaymentEnabled && !cashPaymentEnabled;
  const showMethodPicker = bothMethodsEnabled;

  const tenderedAmount = (() => {
    const cleaned = tenderedText.replace(/[^0-9.]/g, '');
    if (!cleaned) {
      return 0;
    }
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  })();
  const changeDue = Math.max(0, tenderedAmount - total);
  const canConfirmCash = tenderedAmount >= total && total >= 0;

  const applyPaymentMethodAvailability = useCallback(
    (cardEnabled: boolean, cashEnabled: boolean) => {
      setCardPaymentEnabled(cardEnabled);
      setCashPaymentEnabled(cashEnabled);
      if (cardEnabled && cashEnabled) {
        // Dual choice: keep selection null until staff picks (or leave prior pick).
        return;
      }
      if (cardEnabled && !cashEnabled) {
        setPaymentMethod('card');
        setTenderedText('');
        return;
      }
      if (cashEnabled && !cardEnabled) {
        setPaymentMethod('cash');
        return;
      }
      // Both off — clear selection so we don't offer a dead path.
      setPaymentMethod(null);
      setTenderedText('');
    },
    [],
  );

  const loadOrder = useCallback(async () => {
    setLoadingOrder(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        return;
      }
      const fetched = await getOrder(orderId, token);
      setOrder(fetched);
    } catch {
      // Summary still works from route params
    } finally {
      setLoadingOrder(false);
    }
  }, [orderId]);

  const loadPaymentConfig = useCallback(async () => {
    setPaymentConfigLoading(true);
    setPaymentConfigError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setPaymentConfigError('Terminal session not found. Please re-activate.');
        // No session: block payment rather than inventing methods.
        applyPaymentMethodAvailability(false, false);
        return;
      }
      const info = await getTerminalInfo(token);
      const {cardEnabled, cashEnabled} = resolvePaymentMethodsAvailability(info);
      applyPaymentMethodAvailability(cardEnabled, cashEnabled);
    } catch (err) {
      // Network/auth blip: keep taking payments with both methods (today's default)
      // rather than locking the floor. Explicit both-off from API still blocks below.
      setPaymentConfigError(
        err instanceof Error
          ? err.message
          : 'Could not refresh payment settings',
      );
      applyPaymentMethodAvailability(true, true);
    } finally {
      setPaymentConfigLoading(false);
    }
  }, [applyPaymentMethodAvailability]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // Re-fetch restaurant payment flags whenever Charge is shown so web toggles
  // apply without an app restart (AuthContext only validates /me and discards body).
  useFocusEffect(
    useCallback(() => {
      loadPaymentConfig();
    }, [loadPaymentConfig]),
  );

  useEffect(() => {
    getReceiptPrintingEnabled().then(setReceiptPrintingEnabled);
  }, []);

  // Android back / replace away must not leave a SUCCESS that the next Charge hydrates.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', () => {
      reset();
    });
    return unsub;
  }, [navigation, reset]);

  const attemptPrintReceipt = useCallback(async () => {
    const enabled = await getReceiptPrintingEnabled();
    if (!enabled) {
      return;
    }
    setReceiptPrintingEnabled(true);
    setPrintState('printing');
    setPrintError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setPrintState('failed');
        setPrintError('Printing failed');
        return;
      }
      const result = await printReceiptForOrder(orderId, token, 'receipt');
      if (result.success) {
        setPrintState('success');
      } else {
        setPrintState('failed');
        setPrintError(describeReceiptPrintError(result.errorCode));
      }
    } catch {
      setPrintState('failed');
      setPrintError('Printing failed');
    }
  }, [orderId]);

  // Auto-print when payment succeeds and developer receipt-printing toggle is on.
  // Print failure never affects payment outcome.
  useEffect(() => {
    if (receiptPrintingEnabled && machineState.state === 'PAYMENT_SUCCESS') {
      attemptPrintReceipt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState.state, receiptPrintingEnabled]);

  // Kiosk: never leave mid-print. Wait for success/failure, then hold briefly so
  // staff can read a failure message before the screen disappears.
  useEffect(() => {
    if (!kioskAutoReturnPending || machineState.state !== 'PAYMENT_SUCCESS') {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const leave = (delayMs: number) => {
      timer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setKioskAutoReturnPending(false);
        reset();
        navigation.goBack();
      }, delayMs);
    };

    if (!receiptPrintingEnabled) {
      leave(kioskAutoReturnDelayMs);
      return () => {
        cancelled = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
    }

    // Printing on: wait until attempt finishes (printing → success|failed).
    // Stay on idle briefly until auto-print flips to printing.
    if (printState === 'idle' || printState === 'printing') {
      // Safety: if print never starts/settles, still leave after a hard cap.
      timer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setKioskAutoReturnPending(false);
        reset();
        navigation.goBack();
      }, 20000);
      return () => {
        cancelled = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
    }

    const holdMs = printState === 'failed' ? 2500 : 800;
    leave(holdMs);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [
    kioskAutoReturnPending,
    kioskAutoReturnDelayMs,
    machineState.state,
    receiptPrintingEnabled,
    printState,
    reset,
    navigation,
  ]);

  const openEmailPrompt = () => {
    setEmailPromptError(null);
    setShowEmailPrompt(true);
  };

  const handleSendEmail = async () => {
    const trimmed = emailInput.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailPromptError('Enter a valid email address');
      return;
    }

    setEmailState('sending');
    setEmailError(null);
    setEmailPromptError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setEmailState('failed');
        setEmailError('Session expired');
        return;
      }
      const result = await sendReceiptEmailForOrder(orderId, trimmed, token);
      if (result.success) {
        setEmailState('success');
        setLastEmailSentTo(trimmed);
        setShowEmailPrompt(false);
        setEmailInput('');
      } else {
        setEmailState('failed');
        setEmailError(result.error ?? 'Failed to send receipt email');
      }
    } catch (err) {
      setEmailState('failed');
      setEmailError(err instanceof Error ? err.message : 'Failed to send receipt email');
    }
  };

  const goToOrders = () => {
    reset();
    navigation.navigate('MainTabs', {screen: 'Orders'});
  };

  const finishSuccessfulPayment = useCallback(
    async (
      token: string,
      opts: {
        reference: string;
        paymentMethod: 'card' | 'cash';
        voucherNo?: string;
        businessOrderNo?: string;
        /** Card-only: record sale event for refunds when Finatic ids exist. */
        recordFinaticSale?: boolean;
      },
    ) => {
      /**
       * #326. ALREADY_PAID IS A SETTLED ORDER, NOT A FAILED PAYMENT.
       *
       * The 409 means our own atomic claim refused a second `paid` write because the order is
       * already paid — almost always because the webhook-signature fallback verified it from
       * Finatic seconds earlier, which #107 makes the normal path rather than an edge case. On
       * 2026-08-21 order #851's card had cleared (`trans_status 2`, N$51.00) and this exception
       * still drove the screen to FAILED with "Contact support before retrying." — a retry prompt
       * on a paid order.
       *
       * Only ALREADY_PAID is absorbed. Everything else still throws, so the outer catch's Finatic
       * recovery is untouched: PAYMENT_CLAIM_CONFLICT in particular says the order "may" already be
       * paid, and a maybe must not be rendered as a settled sale.
       */
      let paymentResult: CompletePaymentResult;
      try {
        paymentResult = await completePayment(orderId, token, {
          status: 'success',
          reference: opts.reference,
          voucherNo: opts.voucherNo,
          businessOrderNo: opts.businessOrderNo,
          amount: total,
          paymentMethod: opts.paymentMethod,
        });
      } catch (err) {
        const code = err instanceof ApiRequestError ? err.code : undefined;
        if (classifySuccessReportError(code) !== 'settled') {
          throw err;
        }
        recordWiretapEvent('payment.exit', {
          exit: 'already_paid_treated_as_settled',
          reportsToServer: true,
          note: '#326: order was already paid; rendering settled, not failed',
        });
        setAlreadySettled(true);
        // canClose is unknowable from a 409 body. False is the safe default: it offers no close
        // button rather than a wrong one, and the table can still be closed from the dashboard.
        paymentResult = {canClose: false, success: true, outcome: 'already_paid'};
      }

      if (
        opts.recordFinaticSale &&
        opts.businessOrderNo &&
        opts.voucherNo
      ) {
        recordSaleEvent(
          {
            orderIds: [orderId],
            businessOrderNo: opts.businessOrderNo,
            transactionId: opts.voucherNo,
            amount: total,
          },
          token,
        ).then(saleRecord => {
          if (!saleRecord.ok) {
            console.warn(
              '[PaymentScreen] recordSaleEvent failed:',
              saleRecord.error,
            );
          }
        });
      }

      const orderForAction: Order =
        order ?? {
          id: orderId,
          restaurant_id: '',
          table_number: tableNumber,
          order_number: orderNumber ?? 0,
          status: 'ready',
          items: [],
          total,
          placed_at: placedAt ?? new Date().toISOString(),
          channel: 'table',
        };

      const action = getPostPaymentAction(orderForAction, paymentResult.canClose);

      if (action.type === 'auto_return') {
        setKioskAutoReturnDelayMs(action.delayMs);
        setKioskAutoReturnPending(true);
        paymentSuccess(opts.reference);
      } else {
        setKioskAutoReturnPending(false);
        setCanCloseTable(action.canClose);
        paymentSuccess(opts.reference);
      }
    },
    [
      order,
      orderId,
      orderNumber,
      placedAt,
      tableNumber,
      total,
      paymentSuccess,
    ],
  );

  const handleProcessPayment = async () => {
    startPayment(orderId, total);
    let token: string | null = null;
    /**
     * Hoisted so the outer catch can see what the device actually decided. Without this the
     * catch has no idea a user cancel ever happened and reports it as a bare failure — see the
     * `outer_catch` exit below.
     */
    let lastResult: PaymentResult | null = null;
    try {
      token = await getTerminalToken();
      if (!token) {
        recordWiretapEvent('payment.exit', {
          exit: 'no_token_pre_payment',
          reportsToServer: false,
          note: 'no payment attempted, nothing to report',
        });
        throw new Error('Session expired');
      }

      let result = await processPaymentIntent(total, orderId);
      lastResult = result;

      // Ambiguous / orphaned device outcomes: ask Finatic before assuming failure.
      if (
        !result.success &&
        (result.outcomeKind === 'ambiguous' ||
          result.outcomeKind === 'orphaned_ambiguous' ||
          result.orphaned)
      ) {
        result = await resolveAmbiguousPaymentWithFinatic(orderId, result);
        lastResult = result;
      }

      if (result.success && result.reference) {
        await finishSuccessfulPayment(token, {
          reference: result.reference,
          paymentMethod: 'card',
          voucherNo: result.voucherNo,
          businessOrderNo: result.businessOrderNo,
          recordFinaticSale: true,
        });
      } else {
        const failureReference =
          result.reference?.trim() ||
          (result.outcomeKind === 'confirmed_failure' && result.gatewayResult
            ? declinedFailureReference(result.gatewayResult)
            : unconfirmedFailureReference());
        const baseError =
          result.error ?? 'Payment outcome could not be confirmed on this device';
        // A user cancel never reached the gateway, so tell the server explicitly rather than
        // letting it query Finatic, get E04111 and leave the order pending forever. Set ONLY
        // for outcomeKind 'user_cancelled', which native raises ONLY on RESULT_CANCELED --
        // an ambiguous outcome must keep going through verification.
        const userCancelled = result.outcomeKind === 'user_cancelled';
        // Which exit ran, recorded BEFORE the call. If this marker is absent from the wiretap
        // but a completePayment.request is present, the report came from the outer catch below
        // and the cancel classification was lost on the way.
        recordWiretapEvent('payment.exit', {
          exit: 'main_failure_branch',
          reportsToServer: true,
          outcomeKind: result.outcomeKind ?? '(none)',
          userCancelled,
          willSendCancelFields: userCancelled,
          reference: failureReference,
        });
        const completed = await completePaymentReliably(orderId, token, {
          status: 'failed',
          reference: failureReference,
          amount: total,
          paymentMethod: 'card',
          businessOrderNo: result.businessOrderNo,
          ...(userCancelled
            ? {
                cancellationReason: TERMINAL_USER_CANCELLED_REASON,
                noGatewayAttempt: true,
              }
            : {}),
        });
        /**
         * #327 / #326. BRANCH ON THE OUTCOME, NOT ON WHETHER THE REPORT LANDED.
         *
         * This used to do exactly one thing with `completed`: append
         * `— could not notify the system. Contact support before retrying.` to whatever the device
         * said when it was null, and show the device's own message otherwise. So all three server
         * answers — money found, money definitively not taken, and CANNOT SAY — rendered as the
         * same FAILED screen, and #326's dangling em dash came from gluing that fragment onto a
         * device message that already ended in a full stop.
         *
         * `corrected_to_paid` reaching a FAILED screen was its own live defect: the server verified
         * with Finatic, found the money, and the operator was told the payment failed.
         */
        const classification = classifyFailureReport(completed);
        recordWiretapEvent('payment.report.classified', {
          orderId,
          outcome: completed?.outcome ?? '(none)',
          success: completed ? completed.success : '(not reported)',
          classification,
        });

        if (classification === 'settled') {
          // The device was wrong and the server proved it. Money was taken; this is a sale.
          setCanCloseTable(completed?.canClose ?? false);
          setKioskAutoReturnPending(false);
          paymentSuccess(failureReference);
        } else if (classification === 'not_paid') {
          // Definitively not taken and now resolved. A plain failure, and the only branch of the
          // three where "Try again" is the right primary action.
          paymentFailed(baseError);
        } else {
          // Unknown. One complete sentence, never a concatenation.
          paymentUnconfirmed(completed ? baseError : UNCONFIRMED_NOT_REPORTED);
        }
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Payment failed';

      /**
       * #326. THIS IS WHERE THE REPORTED SCREEN CAME FROM, and it must be handled before anything
       * else in this catch runs.
       *
       * Order #851, 07:18: finishSuccessfulPayment threw ALREADY_PAID, the recovery below re-ran it,
       * it threw ALREADY_PAID again, the inner catch appended NOT_REPORTED_SUFFIX to a message that
       * already ended in a full stop, and the screen read
       * "This order was already paid. — could not notify the system. Contact support before
       * retrying." on an order whose card had cleared.
       *
       * Returning here also stops the second, worse half: everything below reports
       * `status: 'failed'` to the server for an order that is PAID.
       */
      const settledCode = err instanceof ApiRequestError ? err.code : undefined;
      if (classifySuccessReportError(settledCode) === 'settled') {
        recordWiretapEvent('payment.exit', {
          exit: 'outer_catch_already_paid',
          reportsToServer: false,
          note: '#326: already paid — settled, and NOT reported as a failure',
        });
        setAlreadySettled(true);
        setCanCloseTable(false);
        setKioskAutoReturnPending(false);
        paymentSuccess(lastResult?.reference ?? unconfirmedFailureReference());
        return;
      }

      let finalMessage = message;
      /** True when the server was never told this attempt happened — i.e. the result is unknown. */
      let reportDelivered = false;
      /** Set from the server's `outcome` when the report did land, so the classifier can see it. */
      let reportResponse: CompletePaymentResult | null = null;
      // Always tell the backend — never leave a silent gap after a card attempt.
      try {
        const reportToken = token ?? (await getTerminalToken());
        if (reportToken) {
          // Last chance: Finatic may have charged even if JS threw mid-flight.
          const recovered = await resolveAmbiguousPaymentWithFinatic(orderId, {
            success: false,
            outcomeKind: 'ambiguous',
            error: message,
          });
          if (recovered.success && recovered.reference) {
            await finishSuccessfulPayment(reportToken, {
              reference: recovered.reference,
              paymentMethod: 'card',
              voucherNo: recovered.voucherNo,
              businessOrderNo: recovered.businessOrderNo,
              recordFinaticSale: true,
            });
            return;
          }
          /**
           * Carry the device's classification into the catch.
           *
           * Found by tracing every exit of this function: this path reported `status: 'failed'`
           * with NO cancellationReason, so a user cancel that reached here was reported as a
           * bare failure, sent to Finatic verification, answered E04111 and stranded — the exact
           * symptom the bypass exists to prevent, on a second path nobody had looked at.
           *
           * Guarded on the pre-catch result, not on the error: an exception with no prior
           * user_cancelled result is genuinely unknown and MUST stay ambiguous. The cancel
           * already happened before whatever threw, so the classification is still true; what we
           * lost was only the ability to report it.
           */
          const cancelledBeforeThrow =
            lastResult?.outcomeKind === 'user_cancelled';
          recordWiretapEvent('payment.exit', {
            exit: 'outer_catch',
            reportsToServer: true,
            threwWith: message,
            priorOutcomeKind: lastResult?.outcomeKind ?? '(none)',
            willSendCancelFields: cancelledBeforeThrow,
          });
          const completed = await completePaymentReliably(orderId, reportToken, {
            status: 'failed',
            reference: unconfirmedFailureReference(),
            amount: total,
            paymentMethod: 'card',
            businessOrderNo: recovered.businessOrderNo,
            ...(cancelledBeforeThrow
              ? {
                  cancellationReason: TERMINAL_USER_CANCELLED_REASON,
                  noGatewayAttempt: true,
                }
              : {}),
          });
          reportDelivered = completed != null;
          reportResponse = completed;
          if (!completed) {
            finalMessage = UNCONFIRMED_NOT_REPORTED;
          }
        } else {
          recordWiretapEvent('payment.exit', {
            exit: 'outer_catch_no_token',
            reportsToServer: false,
            threwWith: message,
          });
          finalMessage = UNCONFIRMED_NOT_REPORTED;
        }
      } catch (reportErr) {
        console.warn(
          '[PaymentScreen] failed to report outer-catch payment outcome:',
          reportErr,
        );
        // Last exit, and the only one where the server genuinely never hears.
        recordWiretapEvent('payment.exit', {
          exit: 'outer_catch_report_threw',
          reportsToServer: false,
          threwWith: message,
          reportError:
            reportErr instanceof Error ? reportErr.message : String(reportErr),
        });
        finalMessage = UNCONFIRMED_NOT_REPORTED;
      }

      /**
       * #327. Something threw mid-payment, so the device never established what happened. That is
       * the definition of unknown, and the branch below is the only one that can promote it to a
       * resolved state — and only on the server's own word.
       *
       * The pre-#327 code ended `paymentFailed(finalMessage)` unconditionally: every exception
       * during a card payment was rendered as a definite decline, including the ones where the
       * card had been charged and only the reporting failed.
       */
      const classification = reportDelivered
        ? classifyFailureReport(reportResponse)
        : 'unknown';
      recordWiretapEvent('payment.report.classified', {
        orderId,
        exit: 'outer_catch',
        outcome: reportResponse?.outcome ?? '(none)',
        reportDelivered,
        classification,
      });

      if (classification === 'settled') {
        setCanCloseTable(reportResponse?.canClose ?? false);
        setKioskAutoReturnPending(false);
        paymentSuccess(unconfirmedFailureReference());
      } else if (classification === 'not_paid') {
        paymentFailed(finalMessage);
      } else {
        paymentUnconfirmed(finalMessage);
      }
    }
  };

  /**
   * #327 — the PRIMARY action on the UNCONFIRMED screen. Asks the server what actually happened.
   *
   * IT IS IDEMPOTENT, which is why it is the primary action and why it is safe to press repeatedly.
   * `POST /api/terminal/orders/[orderId]/verify-payment` takes no payment: it returns early if the
   * order is already `paid`, otherwise it queries Finatic for the order's existing
   * merchant_order_no and, only if Finatic says paid, settles through the same atomic
   * markOrderPaidConfirmed claim the callback uses. Nothing new is charged and nothing is created.
   *
   * ONLY `paid === true` RESOLVES ANYTHING. `paid: false` is not "not paid" — E04111 means Finatic
   * has no record, which is the exact ambiguity that put this order here, and the 2026-08-05 ruling
   * is that E04111 alone must never authorise a cancel. So a negative answer leaves the screen
   * unconfirmed rather than promoting it to FAILED.
   */
  const handleCheckPaymentStatus = async () => {
    if (checkingStatus) {
      return;
    }
    setCheckingStatus(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const verdict = await verifyTerminalPayment(orderId, token);
      recordWiretapEvent('payment.status.checked', {
        orderId,
        ok: verdict.ok,
        paid: verdict.paid,
        source: verdict.source ?? '(none)',
        status: verdict.status ?? '(none)',
      });

      if (verdict.paid) {
        setAlreadySettled(true);
        setCanCloseTable(false);
        setKioskAutoReturnPending(false);
        paymentSuccess(
          verdict.transactionId ?? verdict.merchantOrderNo ?? orderId,
        );
        return;
      }

      // Still unresolved. Stay unconfirmed — the food still must not be released.
      paymentUnconfirmed(UNCONFIRMED_STILL_UNRESOLVED);
    } catch (err) {
      console.warn('[PaymentScreen] verify-payment failed:', err);
      recordWiretapEvent('payment.status.checked', {
        orderId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      // The CHECK failed, which says nothing about the payment. Still unconfirmed.
      paymentUnconfirmed(UNCONFIRMED_CHECK_FAILED);
    } finally {
      setCheckingStatus(false);
    }
  };

  const handleConfirmCash = async () => {
    if (!canConfirmCash) {
      return;
    }
    startPayment(orderId, total);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      // Local cash reference only — no Finatic voucher / businessOrderNo.
      const reference = `CASH-${Date.now()}`;
      await finishSuccessfulPayment(token, {
        reference,
        paymentMethod: 'cash',
        recordFinaticSale: false,
      });
    } catch (err) {
      paymentFailed(err instanceof Error ? err.message : 'Cash payment failed');
    }
  };

  const onTenderedChange = (text: string) => {
    // Allow digits and a single decimal point (max 2 fractional digits).
    let cleaned = text.replace(/[^0-9.]/g, '');
    const firstDot = cleaned.indexOf('.');
    if (firstDot !== -1) {
      cleaned =
        cleaned.slice(0, firstDot + 1) +
        cleaned.slice(firstDot + 1).replace(/\./g, '');
      const [whole, frac = ''] = cleaned.split('.');
      cleaned = `${whole}.${frac.slice(0, 2)}`;
    }
    setTenderedText(cleaned);
  };

  const handleCloseTable = async () => {
    if (!resolvedTableId) {
      Alert.alert(
        'Error',
        'Failed to close table. Please close from the dashboard.',
      );
      goToOrders();
      return;
    }

    setClosingTable(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      await closeTable(resolvedTableId, token);
      goToOrders();
    } catch (err) {
      /**
       * #120 residual, same dead end as TableDetailScreen. Note this branch does NOT call
       * goToOrders(): navigating away is what made the old handler a dead end, because it took
       * staff off the only screen that could show them why the close failed.
       */
      if (
        err instanceof ApiRequestError &&
        err.code === 'PENDING_ORDER_REQUESTS' &&
        err.pendingRequests.length > 0
      ) {
        setStrandedRequests(err.pendingRequests);
        setStrandedMessage(err.message);
        return;
      }
      Alert.alert(
        'Error',
        'Failed to close table. Please close from the dashboard.',
      );
      goToOrders();
    } finally {
      setClosingTable(false);
    }
  };

  const handleBackToOrders = () => {
    goToOrders();
  };

  const {state, error} = machineState;
  /**
   * #327. The bottom bar's big "Process Payment" / "Confirm cash" button is disabled while a
   * payment is UNCONFIRMED, not only while one is in progress.
   *
   * Without this the issue's ordering is defeated by the layout: the UNCONFIRMED card's own primary
   * action is CHECK, but the screen's largest, most habitual button sits below it and would still
   * charge a card for an order that may already be paid. Taking payment again stays reachable — it
   * costs one deliberate tap on the card's secondary action, which resets to IDLE and re-enables
   * this button.
   */
  const paymentActionsBlocked =
    state === 'PAYMENT_IN_PROGRESS' || state === 'PAYMENT_UNCONFIRMED';

  /**
   * The tick. Deliberately a wall-clock delta rather than a counter incremented each interval:
   * setInterval drifts and is throttled when the app is backgrounded, and this screen IS
   * backgrounded for most of a card payment — WiseCashier is a separate activity on top of it. A
   * counter would under-report exactly when the number matters most, on return from the reader.
   */
  useEffect(() => {
    if (state !== 'PAYMENT_IN_PROGRESS') {
      setPaymentElapsedS(0);
      return;
    }
    const startedAt = Date.now();
    setPaymentElapsedS(0);
    const id = setInterval(() => {
      setPaymentElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  const paymentOverCeiling = paymentElapsedS >= PAYMENT_ADVISORY_CEILING_S;
  const displayOrderNumber = order?.order_number ?? orderNumber;
  const displayPlacedAt = order?.placed_at ?? placedAt ?? new Date().toISOString();
  const items = order?.items ?? [];

  // Wait for AsyncStorage hydrate so a legacy persisted SUCCESS cannot flash briefly.
  if (!isHydrated) {
    return (
      <View style={[styles.wrapper, styles.loadingWrap]}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  if (state === 'PAYMENT_SUCCESS') {
    return (
      <View style={styles.wrapper}>
        <View style={[styles.successScreen, {paddingBottom: insets.bottom + Spacing.lg}]}>
          <View style={styles.successContent}>
            <MaterialCommunityIcons
              name="check-circle"
              size={72}
              color={Colors.green}
            />
            <Text style={styles.successTitle}>Payment successful</Text>
            <Text style={styles.successAmount}>{formatAmountPaid(total)}</Text>

            {/*
              #326. Still a success screen — the money is there — but this attempt is not what put
              it there. Saying so is what stops the operator wondering whether to take payment
              again, which is the behaviour that turns a stale picture into a second charge.
            */}
            {alreadySettled ? (
              <Text style={styles.alreadySettledNote}>
                {ALREADY_SETTLED_MESSAGE}
              </Text>
            ) : null}

            {paymentMethod === 'cash' && tenderedAmount > 0 ? (
              <View style={styles.cashSuccessSummary}>
                <View style={styles.cashSuccessRow}>
                  <Text style={styles.cashSuccessLabel}>Amount paid</Text>
                  <Text style={styles.cashSuccessValue}>
                    {formatAmountPaid(tenderedAmount)}
                  </Text>
                </View>
                <View style={styles.cashSuccessRow}>
                  <Text style={styles.cashSuccessLabel}>Change due</Text>
                  <Text
                    style={[
                      styles.cashSuccessValue,
                      styles.cashSuccessChange,
                    ]}>
                    {formatAmountPaid(changeDue)}
                  </Text>
                </View>
              </View>
            ) : null}

            {!receiptSkipped && (
              <View style={styles.receiptCard}>
                <View style={styles.receiptActions}>
                  {receiptPrintingEnabled ? (
                    <Pressable
                      style={[
                        styles.receiptActionButton,
                        printState === 'printing' && styles.buttonDisabled,
                      ]}
                      disabled={printState === 'printing'}
                      onPress={attemptPrintReceipt}>
                      {printState === 'printing' ? (
                        <ActivityIndicator color={Colors.primary} size="small" />
                      ) : (
                        <>
                          <MaterialCommunityIcons
                            name="printer-outline"
                            size={20}
                            color={Colors.textPrimary}
                          />
                          <Text style={styles.receiptActionText}>Print</Text>
                        </>
                      )}
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={[
                      styles.receiptActionButton,
                      emailState === 'sending' && styles.buttonDisabled,
                    ]}
                    disabled={emailState === 'sending'}
                    onPress={openEmailPrompt}>
                    {emailState === 'sending' ? (
                      <ActivityIndicator color={Colors.primary} size="small" />
                    ) : (
                      <>
                        <MaterialCommunityIcons
                          name="email-outline"
                          size={20}
                          color={Colors.textPrimary}
                        />
                        <Text style={styles.receiptActionText}>Email</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    style={styles.receiptActionButton}
                    onPress={() => setReceiptSkipped(true)}>
                    <Text style={styles.receiptActionText}>Skip</Text>
                  </Pressable>
                </View>

                {receiptPrintingEnabled && printState === 'success' && (
                  <View style={styles.receiptStatusRow}>
                    <MaterialCommunityIcons
                      name="check-circle-outline"
                      size={16}
                      color={Colors.green}
                    />
                    <Text style={styles.receiptStatusTextSuccess}>Receipt printed</Text>
                  </View>
                )}
                {receiptPrintingEnabled && printState === 'failed' && (
                  <View style={styles.receiptStatusRow}>
                    <MaterialCommunityIcons
                      name="alert-circle-outline"
                      size={16}
                      color={Colors.red}
                    />
                    <Text style={styles.receiptStatusTextError}>
                      {printError ?? 'Printing failed'}
                    </Text>
                  </View>
                )}
                {emailState === 'success' && (
                  <View style={styles.receiptStatusRow}>
                    <MaterialCommunityIcons
                      name="check-circle-outline"
                      size={16}
                      color={Colors.green}
                    />
                    <Text style={styles.receiptStatusTextSuccess}>
                      Emailed to {lastEmailSentTo}
                    </Text>
                  </View>
                )}
                {emailState === 'failed' && (
                  <View style={styles.receiptStatusRow}>
                    <MaterialCommunityIcons
                      name="alert-circle-outline"
                      size={16}
                      color={Colors.red}
                    />
                    <Text style={styles.receiptStatusTextError}>
                      {emailError ?? 'Failed to send receipt email'}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>

          <View style={styles.successActions}>
            {canCloseTable ? (
              <Pressable
                style={[styles.primaryButton, closingTable && styles.buttonDisabled]}
                disabled={closingTable}
                onPress={handleCloseTable}>
                {closingTable ? (
                  <ActivityIndicator color={Colors.white} />
                ) : (
                  <Text style={styles.primaryButtonText}>Close Table</Text>
                )}
              </Pressable>
            ) : null}
            <Pressable
              style={[
                canCloseTable ? styles.secondaryButton : styles.primaryButton,
                closingTable && styles.buttonDisabled,
              ]}
              disabled={closingTable}
              onPress={handleBackToOrders}>
              <Text
                style={
                  canCloseTable
                    ? styles.secondaryButtonText
                    : styles.primaryButtonText
                }>
                Back to Orders
              </Text>
            </Pressable>
          </View>
        </View>

        <Modal
          visible={showEmailPrompt}
          transparent
          animationType="fade"
          onRequestClose={() => setShowEmailPrompt(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.emailPromptCard}>
              <Text style={styles.emailPromptTitle}>Email Receipt</Text>
              <TextInput
                style={styles.emailInput}
                placeholder="customer@example.com"
                placeholderTextColor={Colors.textMuted}
                value={emailInput}
                onChangeText={text => {
                  setEmailInput(text);
                  setEmailPromptError(null);
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
              />
              {emailPromptError ? (
                <Text style={styles.failedError}>{emailPromptError}</Text>
              ) : null}
              <View style={styles.emailPromptActions}>
                <Pressable
                  style={[styles.secondaryButton, styles.emailPromptButtonFlex]}
                  onPress={() => {
                    setShowEmailPrompt(false);
                    setEmailInput('');
                    setEmailPromptError(null);
                  }}>
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.primaryButton,
                    styles.emailPromptButtonFlex,
                    emailState === 'sending' && styles.buttonDisabled,
                  ]}
                  disabled={emailState === 'sending'}
                  onPress={handleSendEmail}>
                  {emailState === 'sending' ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Send</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable style={styles.backButton} onPress={() => navigation.goBack()}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <Text style={styles.screenTitle}>Payment</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}>
        {/*
          #344. Above the order card, so it is read before the operator starts tapping. Renders
          nothing when there is no held payment, which is almost always.
        */}
        <HeldOrphanPaymentNotice />

        <View style={styles.topCard}>
          <Text style={styles.tableLabel}>TABLE</Text>
          <Text style={styles.tableNumber}>{tableNumber}</Text>
          <View style={styles.topCardMeta}>
            <Text style={styles.orderNumber}>Order #{displayOrderNumber}</Text>
            <StatusBadge status="ready" />
          </View>
          <View style={styles.timeRow}>
            <MaterialCommunityIcons
              name="clock-outline"
              size={16}
              color={Colors.textMuted}
            />
            <Text style={styles.time}>{formatTime(displayPlacedAt)}</Text>
          </View>
        </View>

        <Text style={styles.sectionHeader}>Order Summary</Text>
        <View style={styles.summarySection}>
          {loadingOrder ? (
            <ActivityIndicator color={Colors.primary} />
          ) : items.length > 0 ? (
            items.map(item => (
              <View key={item.id} style={styles.itemRow}>
                <Text style={styles.itemName}>
                  {item.quantity}x {item.name}
                </Text>
                <Text style={styles.itemPrice}>
                  {formatCurrency(getItemLineTotal(item))}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.itemName}>Order total</Text>
          )}
          <View style={styles.divider} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCurrency(total)}</Text>
          </View>
        </View>

        {state === 'IDLE' ? (
          <>
            {paymentConfigLoading ? (
              <View style={styles.configLoadingRow}>
                <ActivityIndicator color={Colors.primary} />
                <Text style={styles.configLoadingText}>
                  Loading payment options…
                </Text>
              </View>
            ) : null}

            {!paymentConfigLoading && paymentConfigError ? (
              <Pressable
                style={styles.configWarning}
                onPress={loadPaymentConfig}>
                <MaterialCommunityIcons
                  name="wifi-alert"
                  size={20}
                  color={Colors.textMuted}
                />
                <Text style={styles.configWarningText}>
                  {paymentConfigError} · Tap to retry
                </Text>
              </Pressable>
            ) : null}

            {!paymentConfigLoading && noMethodsEnabled ? (
              <View style={styles.blockedCard}>
                <MaterialCommunityIcons
                  name="cancel"
                  size={40}
                  color={Colors.red}
                />
                <Text style={styles.blockedTitle}>Payments unavailable</Text>
                <Text style={styles.blockedBody}>
                  Card and Cash are both turned off for this restaurant. Ask a
                  manager to enable at least one payment method in Settings,
                  then return to this screen.
                </Text>
                <Pressable
                  style={styles.outlinedRedButton}
                  onPress={() => navigation.goBack()}>
                  <Text style={styles.outlinedRedText}>Go back</Text>
                </Pressable>
              </View>
            ) : null}

            {!paymentConfigLoading && !noMethodsEnabled && showMethodPicker ? (
              <>
                <Text style={styles.sectionHeader}>Payment method</Text>
                <View style={styles.methodRow}>
                  <Pressable
                    style={[
                      styles.methodChip,
                      paymentMethod === 'card' && styles.methodChipSelected,
                    ]}
                    onPress={() => setPaymentMethod('card')}>
                    <MaterialCommunityIcons
                      name="credit-card-outline"
                      size={22}
                      color={
                        paymentMethod === 'card'
                          ? Colors.white
                          : Colors.textPrimary
                      }
                    />
                    <Text
                      style={[
                        styles.methodChipText,
                        paymentMethod === 'card' &&
                          styles.methodChipTextSelected,
                      ]}>
                      Card
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.methodChip,
                      paymentMethod === 'cash' && styles.methodChipSelected,
                    ]}
                    onPress={() => setPaymentMethod('cash')}>
                    <MaterialCommunityIcons
                      name="cash"
                      size={22}
                      color={
                        paymentMethod === 'cash'
                          ? Colors.white
                          : Colors.textPrimary
                      }
                    />
                    <Text
                      style={[
                        styles.methodChipText,
                        paymentMethod === 'cash' &&
                          styles.methodChipTextSelected,
                      ]}>
                      Cash
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {!paymentConfigLoading &&
            !noMethodsEnabled &&
            paymentMethod === 'cash' ? (
              <View style={styles.cashPanel}>
                {!showMethodPicker ? (
                  <Text style={styles.sectionHeader}>Cash payment</Text>
                ) : null}
                <View style={styles.cashRow}>
                  <Text style={styles.cashLabel}>Order total</Text>
                  <Text style={styles.cashValue}>{formatCurrency(total)}</Text>
                </View>
                <Text style={styles.cashLabel}>Amount tendered</Text>
                <TextInput
                  style={styles.tenderedInput}
                  value={tenderedText}
                  onChangeText={onTenderedChange}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={Colors.textMuted}
                />
                <View style={styles.cashRow}>
                  <Text style={styles.cashLabel}>Change</Text>
                  <Text
                    style={[
                      styles.cashValue,
                      canConfirmCash
                        ? styles.cashChangeReady
                        : styles.cashChangePending,
                    ]}>
                    {formatCurrency(changeDue)}
                  </Text>
                </View>
              </View>
            ) : null}
          </>
        ) : null}

        {state !== 'IDLE' ? (
          <>
            <Text style={styles.sectionHeader}>Payment Status</Text>

            {/*
              #346 — TWO STATES, NOT ONE. Below the ceiling this is a calm progress line with an
              elapsed count and a stated bound. Past the ceiling it becomes an instruction, because
              at that point the operator's next action decides whether the venue ends up with a
              duplicate charge. The instruction NOT to ring the sale up again is the whole fix.

              No cancel is offered anywhere here, deliberately: we cannot cancel a card at the
              reader from this screen, and an action we cannot perform is worse than none.
            */}
            {state === 'PAYMENT_IN_PROGRESS' && !paymentOverCeiling && (
              <View style={styles.processingPill}>
                <Text style={styles.processingText}>
                  {'● '}
                  {paymentProcessingElapsed(
                    paymentElapsedS,
                    PAYMENT_ADVISORY_CEILING_S,
                  )}
                </Text>
              </View>
            )}

            {state === 'PAYMENT_IN_PROGRESS' && paymentOverCeiling && (
              <View style={styles.overCeilingCard}>
                <View style={styles.overCeilingHeader}>
                  <MaterialCommunityIcons
                    name="clock-alert-outline"
                    size={20}
                    color={Colors.amber}
                  />
                  <Text style={styles.overCeilingTitle}>
                    {PAYMENT_OVER_CEILING_TITLE}
                  </Text>
                </View>
                <Text style={styles.overCeilingBody}>
                  {PAYMENT_OVER_CEILING_BODY}
                </Text>
                <Text style={styles.overCeilingElapsed}>
                  {paymentElapsedS}s
                </Text>
                <LoadingButton
                  style={styles.overCeilingButton}
                  loading={checkingStatus}
                  disabled={checkingStatus}
                  onPress={handleCheckPaymentStatus}
                  spinnerColor={Colors.white}>
                  <Text style={styles.overCeilingButtonText}>
                    {checkingStatus
                      ? UNCONFIRMED_CHECK_IN_PROGRESS
                      : PAYMENT_CHECK_STATUS_LABEL}
                  </Text>
                </LoadingButton>
              </View>
            )}

            {/*
              #327 — the UNCONFIRMED card. Deliberately NOT a variant of the FAILED card:

              - the instruction comes FIRST and before any action, because "do not release this
                order" is the only thing on this screen that prevents the #868 incident;
              - the primary action is CHECK, not retry. Retry is present but visually secondary and
                worded so it does not read as the obvious next tap;
              - "Try again" here re-presents the card for THIS order id — this screen is bound to
                one orderId for its whole life and no path from it creates a sale. Combined with
                #328's per-sale idempotency key, a retry cannot strand a duplicate order.
            */}
            {state === 'PAYMENT_UNCONFIRMED' && (
              <View style={styles.unconfirmedCard}>
                <MaterialCommunityIcons
                  name="help-circle"
                  size={40}
                  color={Colors.amber}
                />
                <Text style={styles.unconfirmedTitle}>{UNCONFIRMED_TITLE}</Text>
                <Text style={styles.unconfirmedInstruction}>
                  {UNCONFIRMED_INSTRUCTION}
                </Text>
                <Text style={styles.unconfirmedExplanation}>
                  {UNCONFIRMED_EXPLANATION}
                </Text>
                {error ? (
                  <Text style={styles.unconfirmedDetail}>{error}</Text>
                ) : null}

                <LoadingButton
                  style={styles.unconfirmedPrimaryButton}
                  loading={checkingStatus}
                  disabled={checkingStatus}
                  onPress={handleCheckPaymentStatus}
                  spinnerColor={Colors.white}>
                  <Text style={styles.unconfirmedPrimaryText}>
                    {checkingStatus
                      ? UNCONFIRMED_CHECK_IN_PROGRESS
                      : UNCONFIRMED_CHECK_ACTION}
                  </Text>
                </LoadingButton>

                <Pressable
                  style={styles.unconfirmedSecondaryButton}
                  disabled={checkingStatus}
                  onPress={() => {
                    reset();
                    setTenderedText('');
                    applyPaymentMethodAvailability(
                      cardPaymentEnabled,
                      cashPaymentEnabled,
                    );
                    if (cardPaymentEnabled && cashPaymentEnabled) {
                      setPaymentMethod(null);
                    }
                  }}>
                  <Text style={styles.unconfirmedSecondaryText}>
                    {UNCONFIRMED_RETRY_ACTION}
                  </Text>
                </Pressable>
              </View>
            )}

            {state === 'PAYMENT_FAILED' && (
              <View style={styles.failedCard}>
                <MaterialCommunityIcons
                  name="alert-circle"
                  size={40}
                  color={Colors.red}
                />
                <Text style={styles.failedTitle}>FAILED</Text>
                <Text style={styles.statusSubtitle}>Payment failed</Text>
                {error ? <Text style={styles.failedError}>{error}</Text> : null}
                <Pressable
                  style={styles.outlinedRedButton}
                  onPress={() => {
                    reset();
                    setTenderedText('');
                    applyPaymentMethodAvailability(
                      cardPaymentEnabled,
                      cashPaymentEnabled,
                    );
                    if (cardPaymentEnabled && cashPaymentEnabled) {
                      setPaymentMethod(null);
                    }
                  }}>
                  <Text style={styles.outlinedRedText}>Try again</Text>
                </Pressable>
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      <View style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.md}]}>
        {noMethodsEnabled || paymentConfigLoading ? (
          <Pressable
            style={[styles.processButton, styles.buttonDisabled]}
            disabled>
            <MaterialCommunityIcons
              name="credit-card-off-outline"
              size={22}
              color={Colors.white}
            />
            <View style={styles.processButtonTextWrap}>
              <Text style={styles.processButtonTitle}>
                {paymentConfigLoading
                  ? 'Loading…'
                  : 'Payments unavailable'}
              </Text>
              <Text style={styles.processButtonSubtitle}>
                {paymentConfigLoading
                  ? 'Checking restaurant settings'
                  : 'Enable Card or Cash in Settings'}
              </Text>
            </View>
          </Pressable>
        ) : paymentMethod === 'cash' ? (
          <LoadingButton
            style={[
              styles.processButton,
              (!canConfirmCash || paymentActionsBlocked) &&
                styles.buttonDisabled,
            ]}
            disabled={!canConfirmCash || paymentActionsBlocked}
            loading={state === 'PAYMENT_IN_PROGRESS'}
            onPress={handleConfirmCash}
            spinnerColor={Colors.white}
            icon={
              <MaterialCommunityIcons
                name="cash-check"
                size={22}
                color={Colors.white}
              />
            }>
            <View style={styles.processButtonTextWrap}>
              <Text style={styles.processButtonTitle}>Confirm cash</Text>
              <Text style={styles.processButtonSubtitle}>
                {canConfirmCash
                  ? `Change ${formatCurrency(changeDue)}`
                  : 'Enter amount tendered'}
              </Text>
            </View>
          </LoadingButton>
        ) : (
          <LoadingButton
            style={[
              styles.processButton,
              (paymentMethod !== 'card' || paymentActionsBlocked) &&
                styles.buttonDisabled,
            ]}
            disabled={paymentMethod !== 'card' || paymentActionsBlocked}
            loading={state === 'PAYMENT_IN_PROGRESS'}
            onPress={handleProcessPayment}
            spinnerColor={Colors.white}
            icon={
              <MaterialCommunityIcons
                name="credit-card-outline"
                size={22}
                color={Colors.white}
              />
            }>
            <View style={styles.processButtonTextWrap}>
              <Text style={styles.processButtonTitle}>Process Payment</Text>
              <Text style={styles.processButtonSubtitle}>
                {paymentMethod === 'card'
                  ? 'Tap card or insert to pay'
                  : 'Select Card or Cash above'}
              </Text>
            </View>
          </LoadingButton>
        )}
      </View>

      {/* #120 residual — same prompt as TableDetailScreen, same close route, same 409. */}
      <StrandedRequestPrompt
        visible={strandedRequests.length > 0}
        requests={strandedRequests}
        message={strandedMessage}
        onDismiss={() => {
          setStrandedRequests([]);
          goToOrders();
        }}
        onReleased={() => {
          // Do NOT auto-close here. The blocker is cleared, but closing the table is the
          // operator's decision and they may have more to settle first.
          setCanCloseTable(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingWrap: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  configLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  configLoadingText: {
    ...Typography.body,
    color: Colors.textMuted,
  },
  configWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
    padding: Spacing.sm,
    borderRadius: 8,
    backgroundColor: Colors.surface,
  },
  configWarningText: {
    ...Typography.small,
    color: Colors.textMuted,
    flex: 1,
  },
  blockedCard: {
    alignItems: 'center',
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    gap: Spacing.sm,
  },
  blockedTitle: {
    ...Typography.subheading,
    color: Colors.red,
    textAlign: 'center',
  },
  blockedBody: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  methodRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  methodChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: 12,
    backgroundColor: Colors.white,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  methodChipSelected: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  methodChipText: {
    ...Typography.body,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  methodChipTextSelected: {
    color: Colors.white,
  },
  cashPanel: {
    backgroundColor: Colors.white,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  cashRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cashLabel: {
    ...Typography.body,
    color: Colors.textMuted,
  },
  cashValue: {
    ...Typography.body,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  cashChangeReady: {
    color: Colors.green,
  },
  cashChangePending: {
    color: Colors.textMuted,
  },
  tenderedInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    fontSize: 22,
    fontWeight: '700',
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
  },
  successScreen: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl * 2,
    justifyContent: 'space-between',
  },
  successContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.textPrimary,
    marginTop: Spacing.md,
  },
  successAmount: {
    fontSize: 32,
    fontWeight: '800',
    color: Colors.green,
  },
  cashSuccessSummary: {
    width: '100%',
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: 12,
    backgroundColor: Colors.greenLight,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  cashSuccessRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cashSuccessLabel: {
    fontSize: 16,
    color: Colors.textMuted,
    fontWeight: '500',
  },
  cashSuccessValue: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  cashSuccessChange: {
    color: Colors.green,
  },
  successActions: {
    gap: Spacing.md,
    width: '100%',
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    width: '100%',
  },
  primaryButtonText: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  secondaryButtonText: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenTitle: {
    flex: 1,
    textAlign: 'center',
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.lg,
    paddingBottom: 120,
  },
  topCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  tableLabel: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.textMuted,
    letterSpacing: 1,
  },
  tableNumber: {
    fontSize: 56,
    fontWeight: '800',
    color: Colors.green,
    marginVertical: Spacing.xs,
  },
  topCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  orderNumber: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  time: {
    ...Typography.small,
    color: Colors.textMuted,
  },
  sectionHeader: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    marginBottom: Spacing.sm,
  },
  summarySection: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.lg,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  itemName: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  itemPrice: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: Spacing.sm,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  totalLabel: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  totalValue: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.green,
  },
  /**
   * #346 — the past-the-ceiling state. Amber and card-shaped rather than a pill, because it is no
   * longer a status line: it carries an instruction and an action.
   */
  overCeilingCard: {
    backgroundColor: Colors.amberLight,
    borderWidth: 1,
    borderColor: Colors.amber,
    borderRadius: 12,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  overCeilingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  overCeilingTitle: {
    flex: 1,
    ...Typography.body,
    fontWeight: '700',
    color: Colors.textPrimary,
  },
  overCeilingBody: {
    ...Typography.small,
    color: Colors.textPrimary,
    lineHeight: 20,
  },
  /** The count keeps running past the ceiling — the wait is bounded, not over. */
  overCeilingElapsed: {
    ...Typography.small,
    color: Colors.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  overCeilingButton: {
    marginTop: Spacing.xs,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  overCeilingButtonText: {
    color: Colors.white,
    ...Typography.body,
    fontWeight: '700',
  },
  processingPill: {
    backgroundColor: Colors.blueLight,
    borderRadius: 24,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  processingText: {
    ...Typography.subheading,
    color: Colors.blue,
  },
  receiptCard: {
    width: '100%',
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  receiptActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  receiptActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  receiptActionText: {
    ...Typography.small,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  receiptActionComingSoon: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderStyle: 'dashed',
    backgroundColor: Colors.surface,
  },
  receiptActionComingSoonText: {
    ...Typography.small,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  receiptStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
  receiptStatusTextSuccess: {
    ...Typography.small,
    color: Colors.green,
    textAlign: 'center',
  },
  receiptStatusTextError: {
    ...Typography.small,
    color: Colors.red,
    textAlign: 'center',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  emailPromptCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: Colors.background,
    borderRadius: 16,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  emailPromptTitle: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  emailInput: {
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: Spacing.md,
    ...Typography.body,
    color: Colors.textPrimary,
  },
  emailPromptActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  emailPromptButtonFlex: {
    flex: 1,
    width: undefined,
  },
  failedCard: {
    backgroundColor: Colors.redLight,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.red,
    gap: Spacing.xs,
  },
  failedTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.red,
    letterSpacing: 1,
  },
  statusSubtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  failedError: {
    ...Typography.small,
    color: Colors.red,
    textAlign: 'center',
  },
  outlinedRedButton: {
    marginTop: Spacing.sm,
    borderWidth: 1.5,
    borderColor: Colors.red,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: Spacing.lg,
    minWidth: 120,
    alignItems: 'center',
  },
  outlinedRedText: {
    ...Typography.subheading,
    color: Colors.red,
  },

  /*
   * #327 — UNCONFIRMED. The visual hierarchy is the fix as much as the wording is: the instruction
   * is the largest text on the card, above the explanation and above both actions, and the CHECK
   * action is the filled button while retry is a plain text link.
   */
  unconfirmedCard: {
    backgroundColor: Colors.amberLight,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: Colors.amber,
    gap: Spacing.xs,
  },
  unconfirmedTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.amber,
    letterSpacing: 1,
  },
  /** The line that prevents the incident. Biggest, boldest, and first. */
  unconfirmedInstruction: {
    ...Typography.subheading,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  unconfirmedExplanation: {
    ...Typography.small,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  unconfirmedDetail: {
    ...Typography.tiny,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  unconfirmedPrimaryButton: {
    marginTop: Spacing.md,
    backgroundColor: Colors.amber,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    minWidth: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unconfirmedPrimaryText: {
    ...Typography.subheading,
    color: Colors.white,
  },
  /** Secondary by construction: no fill, no border, no button shape. */
  unconfirmedSecondaryButton: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
  },
  unconfirmedSecondaryText: {
    ...Typography.small,
    color: Colors.textSecondary,
    textDecorationLine: 'underline',
  },
  /** #326 — shown on the SUCCESS card when the order was already settled before this attempt. */
  alreadySettledNote: {
    ...Typography.small,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  processButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  processButtonTextWrap: {
    flex: 1,
  },
  processButtonTitle: {
    color: Colors.white,
    fontSize: 17,
    fontWeight: '700',
  },
  processButtonSubtitle: {
    color: '#D4D4D8',
    ...Typography.tiny,
    marginTop: 2,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
