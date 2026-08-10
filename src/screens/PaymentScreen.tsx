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
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  closeTable,
  completePayment,
  completePaymentReliably,
  getOrder,
  getTerminalInfo,
  recordSaleEvent,
  resolvePaymentMethodsAvailability,
} from '../lib/api';
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
    reset,
  } = usePaymentStateMachine(orderId);
  const [order, setOrder] = useState<Order | null>(null);
  const [loadingOrder, setLoadingOrder] = useState(true);
  const [closingTable, setClosingTable] = useState(false);
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
      const paymentResult = await completePayment(orderId, token, {
        status: 'success',
        reference: opts.reference,
        voucherNo: opts.voucherNo,
        businessOrderNo: opts.businessOrderNo,
        amount: total,
        paymentMethod: opts.paymentMethod,
      });

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
        paymentFailed(
          completed
            ? baseError
            : `${baseError} — could not notify the system. Contact support before retrying.`,
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Payment failed';
      let finalMessage = message;
      const NOT_REPORTED_SUFFIX =
        ' — could not notify the system. Contact support before retrying.';
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
          if (!completed) {
            finalMessage = `${message}${NOT_REPORTED_SUFFIX}`;
          }
        } else {
          recordWiretapEvent('payment.exit', {
            exit: 'outer_catch_no_token',
            reportsToServer: false,
            threwWith: message,
          });
          finalMessage = `${message}${NOT_REPORTED_SUFFIX}`;
        }
      } catch (reportErr) {
        console.warn(
          '[PaymentScreen] failed to report outer-catch payment outcome:',
          reportErr,
        );
        // Last exit, and the only one where the server genuinely never hears. Staff see the
        // "contact support" suffix; this makes it readable afterwards too.
        recordWiretapEvent('payment.exit', {
          exit: 'outer_catch_report_threw',
          reportsToServer: false,
          threwWith: message,
          reportError:
            reportErr instanceof Error ? reportErr.message : String(reportErr),
        });
        finalMessage = `${message}${NOT_REPORTED_SUFFIX}`;
      }
      paymentFailed(finalMessage);
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
    } catch {
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

            {state === 'PAYMENT_IN_PROGRESS' && (
              <View style={styles.processingPill}>
                <Text style={styles.processingText}>
                  ● PROCESSING / Please wait...
                </Text>
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
              (!canConfirmCash || state === 'PAYMENT_IN_PROGRESS') &&
                styles.buttonDisabled,
            ]}
            disabled={!canConfirmCash || state === 'PAYMENT_IN_PROGRESS'}
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
              (paymentMethod !== 'card' ||
                state === 'PAYMENT_IN_PROGRESS') &&
                styles.buttonDisabled,
            ]}
            disabled={
              paymentMethod !== 'card' || state === 'PAYMENT_IN_PROGRESS'
            }
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
