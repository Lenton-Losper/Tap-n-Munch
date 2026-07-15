import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  getSaleRecordForOrder,
  recordRefundEvent,
  SaleLookupResult,
  SaleRecordNotFoundError,
} from '../lib/api';
import {processRefundIntent, RefundResult} from '../lib/payment';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'RefundConfirm'>;

type RefundReasonCode =
  | 'wrong_item'
  | 'quality_issue'
  | 'duplicate_charge'
  | 'customer_request'
  | 'other';

type ScreenPhase =
  | 'loading'
  | 'lookup_retry'
  | 'unrefundable'
  | 'form'
  | 'processing'
  | 'success'
  | 'failure'
  | 'record_error';

const REASON_OPTIONS: {code: RefundReasonCode; label: string}[] = [
  {code: 'wrong_item', label: 'Wrong item'},
  {code: 'quality_issue', label: 'Quality issue'},
  {code: 'duplicate_charge', label: 'Duplicate charge'},
  {code: 'customer_request', label: 'Customer request'},
  {code: 'other', label: 'Other'},
];

const CARD_INSTRUCTION =
  'Please ask the customer to tap the SAME card used for the original payment.';

function formatAmount(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${currency} ${safe.toFixed(2)}`;
}

export default function RefundConfirmScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {authTokenId, userId, orderId, tableNumber} = route.params;

  const [phase, setPhase] = useState<ScreenPhase>('loading');
  const [sale, setSale] = useState<SaleLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [unrefundableMessage, setUnrefundableMessage] = useState<string | null>(
    null,
  );
  const [selectedReason, setSelectedReason] = useState<RefundReasonCode | null>(
    null,
  );
  const [wrongCardMessage, setWrongCardMessage] = useState<string | null>(
    null,
  );
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState(0);

  const loadSaleRecord = useCallback(async () => {
    setPhase('loading');
    setLookupError(null);
    setUnrefundableMessage(null);

    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      const saleRecord = await getSaleRecordForOrder(orderId, token);

      if (saleRecord.remaining <= 0) {
        setUnrefundableMessage(
          'This order has no remaining balance to refund.',
        );
        setPhase('unrefundable');
        return;
      }

      setSale(saleRecord);
      setRefundAmount(saleRecord.remaining);
      setPhase('form');
    } catch (err) {
      if (err instanceof SaleRecordNotFoundError) {
        setUnrefundableMessage(
          'This order cannot be refunded through this flow. No card sale record was found — it may have been paid before sale tracking was enabled.',
        );
        setPhase('unrefundable');
        return;
      }

      setLookupError(
        err instanceof Error ? err.message : 'Failed to load sale record',
      );
      setPhase('lookup_retry');
    }
  }, [orderId]);

  useEffect(() => {
    loadSaleRecord();
  }, [loadSaleRecord]);

  const persistRefundEvent = async (
    gatewayResult: 'success' | 'failure',
    result: RefundResult,
    amount: number,
  ) => {
    const token = await getTerminalToken();
    if (!token) {
      throw new Error('Session expired');
    }

    const businessOrderNo =
      result.businessOrderNo?.trim() ||
      `R${orderId.replace(/-/g, '').slice(0, 12)}${Date.now()}`.slice(0, 32);

    await recordRefundEvent(
      {
        tokenId: authTokenId,
        userId,
        originBusinessOrderNo: sale!.business_order_no,
        orderIds: [orderId],
        businessOrderNo,
        amount,
        reasonCode: selectedReason!,
        gatewayResult,
        transactionId: result.transactionId,
        gatewayResultCode: result.gateway.code,
        gatewayResultMessage: result.gateway.message,
      },
      token,
    );
  };

  const handleProcessRefund = async () => {
    if (!sale || !selectedReason || phase === 'processing') {
      return;
    }

    const amount = refundAmount;
    setWrongCardMessage(null);
    setPhase('processing');

    const result = await processRefundIntent(amount, sale.business_order_no);

    if (result.status === 'APPROVED') {
      try {
        await persistRefundEvent('success', result, amount);
        setPhase('success');
      } catch (err) {
        setRecordError(
          err instanceof Error
            ? err.message
            : 'Failed to record refund — authorization may have expired. Start again from the table.',
        );
        setPhase('record_error');
      }
      return;
    }

    if (result.status === 'WRONG_CARD' && result.retryable) {
      setWrongCardMessage(
        'Wrong card — please ask for the correct card and try again',
      );
      setPhase('form');
      return;
    }

    try {
      await persistRefundEvent('failure', result, amount);
      setFailureDetail(result.gateway.message || 'Refund was not completed.');
      setPhase('failure');
    } catch (err) {
      setRecordError(
        err instanceof Error
          ? err.message
          : 'Failed to record refund outcome — authorization may have expired.',
      );
      setPhase('record_error');
    }
  };

  const goToTables = () => {
    navigation.navigate('MainTabs', {screen: 'Tables'});
  };

  const renderTopBar = (title: string) => (
    <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
      <Pressable
        style={styles.backButton}
        onPress={() => navigation.goBack()}
        disabled={phase === 'processing'}>
        <MaterialCommunityIcons
          name="arrow-left"
          size={26}
          color={Colors.primary}
        />
      </Pressable>
      <Text style={styles.screenTitle}>{title}</Text>
      <View style={styles.backButton} />
    </View>
  );

  if (phase === 'loading') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      </View>
    );
  }

  if (phase === 'lookup_retry') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <Text style={styles.errorText}>{lookupError}</Text>
          <Pressable style={styles.outlinedButton} onPress={loadSaleRecord}>
            <Text style={styles.outlinedButtonText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'unrefundable') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="alert-circle-outline"
            size={48}
            color={Colors.textMuted}
          />
          <Text style={styles.unrefundableText}>{unrefundableMessage}</Text>
          <Pressable style={styles.outlinedButton} onPress={() => navigation.goBack()}>
            <Text style={styles.outlinedButtonText}>Go Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'success') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="check-circle"
            size={64}
            color={Colors.green}
          />
          <Text style={styles.successTitle}>Refund Approved</Text>
          <Text style={styles.successSubtitle}>
            {formatAmount(refundAmount, sale?.currency ?? 'NAD')} has been
            refunded.
          </Text>
          <Pressable style={styles.primaryButton} onPress={goToTables}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'failure') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="close-circle"
            size={64}
            color={Colors.red}
          />
          <Text style={styles.failureTitle}>Refund Failed</Text>
          {failureDetail ? (
            <Text style={styles.failureSubtitle}>{failureDetail}</Text>
          ) : null}
          <Text style={styles.failureHint}>
            To try again, start a new refund from the table — manager PIN will
            be required.
          </Text>
          <Pressable style={styles.outlinedButton} onPress={goToTables}>
            <Text style={styles.outlinedButtonText}>Back to Tables</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'record_error') {
    return (
      <View style={styles.wrapper}>
        {renderTopBar('Refund')}
        <View style={styles.centered}>
          <MaterialCommunityIcons
            name="alert-circle"
            size={64}
            color={Colors.red}
          />
          <Text style={styles.failureTitle}>Could Not Save Refund</Text>
          <Text style={styles.failureSubtitle}>{recordError}</Text>
          <Text style={styles.failureHint}>
            If the card was charged, contact support with the transaction details.
            Otherwise, start a new refund from the table.
          </Text>
          <Pressable style={styles.outlinedButton} onPress={goToTables}>
            <Text style={styles.outlinedButtonText}>Back to Tables</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      {renderTopBar('Refund')}

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}>
        <View style={styles.topCard}>
          <Text style={styles.tableLabel}>TABLE</Text>
          <Text style={styles.tableNumber}>{tableNumber}</Text>
        </View>

        <Text style={styles.sectionHeader}>Refund Remaining Balance</Text>
        <View style={styles.summarySection}>
          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Remaining balance</Text>
            <Text style={styles.amountValue}>
              {formatAmount(refundAmount, sale?.currency ?? 'NAD')}
            </Text>
          </View>
          {sale && sale.refunded_so_far > 0 ? (
            <Text style={styles.refundedNote}>
              {formatAmount(sale.refunded_so_far, sale.currency)} already
              refunded of {formatAmount(sale.amount, sale.currency)} original
              sale
            </Text>
          ) : null}
        </View>

        <Text style={styles.sectionHeader}>Reason</Text>
        <View style={styles.reasonSection}>
          {REASON_OPTIONS.map(option => {
            const selected = selectedReason === option.code;
            return (
              <Pressable
                key={option.code}
                style={[
                  styles.reasonOption,
                  selected && styles.reasonOptionSelected,
                ]}
                disabled={phase === 'processing'}
                onPress={() => setSelectedReason(option.code)}>
                <Text
                  style={[
                    styles.reasonLabel,
                    selected && styles.reasonLabelSelected,
                  ]}>
                  {option.label}
                </Text>
                {selected ? (
                  <MaterialCommunityIcons
                    name="check-circle"
                    size={20}
                    color={Colors.primary}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {phase === 'processing' ? (
          <View style={styles.instructionCard}>
            <MaterialCommunityIcons
              name="contactless-payment"
              size={28}
              color={Colors.primary}
            />
            <Text style={styles.instructionText}>{CARD_INSTRUCTION}</Text>
            <ActivityIndicator
              color={Colors.primary}
              style={styles.processingSpinner}
            />
          </View>
        ) : wrongCardMessage ? (
          <View style={styles.wrongCardCard}>
            <MaterialCommunityIcons
              name="credit-card-off-outline"
              size={28}
              color={Colors.orange}
            />
            <Text style={styles.wrongCardText}>{wrongCardMessage}</Text>
          </View>
        ) : selectedReason ? (
          <View style={styles.instructionCardMuted}>
            <Text style={styles.instructionTextMuted}>{CARD_INSTRUCTION}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.bottomBar, {paddingBottom: insets.bottom + Spacing.md}]}>
        <Pressable
          style={[
            styles.processButton,
            (!selectedReason || phase === 'processing') && styles.buttonDisabled,
          ]}
          disabled={!selectedReason || phase === 'processing'}
          onPress={handleProcessRefund}>
          {phase === 'processing' ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <>
              <MaterialCommunityIcons
                name="cash-refund"
                size={22}
                color={Colors.white}
              />
              <View style={styles.processButtonTextWrap}>
                <Text style={styles.processButtonTitle}>
                  Refund Remaining Balance
                </Text>
                <Text style={styles.processButtonSubtitle}>
                  {formatAmount(refundAmount, sale?.currency ?? 'NAD')}
                </Text>
              </View>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.background,
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
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
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
  },
  amountValue: {
    fontSize: 26,
    fontWeight: '800',
    color: Colors.green,
  },
  refundedNote: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: Spacing.sm,
  },
  reasonSection: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.lg,
    overflow: 'hidden',
  },
  reasonOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  reasonOptionSelected: {
    backgroundColor: Colors.blueLight,
  },
  reasonLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
  },
  reasonLabelSelected: {
    fontWeight: '700',
    color: Colors.primary,
  },
  instructionCard: {
    backgroundColor: Colors.blueLight,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  instructionCardMuted: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.lg,
  },
  instructionText: {
    ...Typography.body,
    color: Colors.textPrimary,
    textAlign: 'center',
    fontWeight: '600',
  },
  instructionTextMuted: {
    ...Typography.small,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  processingSpinner: {
    marginTop: Spacing.sm,
  },
  wrongCardCard: {
    backgroundColor: Colors.orangeLight,
    borderRadius: 12,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.orange,
  },
  wrongCardText: {
    ...Typography.body,
    color: Colors.orange,
    textAlign: 'center',
    fontWeight: '600',
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
    ...Typography.subheading,
    fontWeight: '700',
  },
  processButtonSubtitle: {
    color: Colors.white,
    ...Typography.small,
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  errorText: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  unrefundableText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  successTitle: {
    ...Typography.heading,
    color: Colors.green,
    textAlign: 'center',
  },
  successSubtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  failureTitle: {
    ...Typography.heading,
    color: Colors.red,
    textAlign: 'center',
  },
  failureSubtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  failureHint: {
    ...Typography.small,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  primaryButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
  },
  primaryButtonText: {
    color: Colors.white,
    ...Typography.subheading,
    fontWeight: '700',
  },
  outlinedButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
    marginTop: Spacing.md,
  },
  outlinedButtonText: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
});
