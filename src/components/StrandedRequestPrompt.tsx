import React, {useState} from 'react';
import {Alert, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import LoadingButton from './LoadingButton';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  RELEASE_STUCK_REQUEST_BODY,
  RELEASE_STUCK_REQUEST_LABEL,
} from '../constants/tableCopy';
import {
  isReleasableStrandedRequest,
  releaseStrandedRequest,
  type PendingOrderRequest,
} from '../lib/api';
import {getTerminalToken} from '../lib/storage';

/**
 * #120 residual — the escape hatch for a table that cannot be closed.
 *
 * THE STATE THIS EXISTS FOR. The accept route takes a transient `accepting` claim on an order
 * request. If the worker dies between taking the claim and releasing it, the row is stranded in
 * `accepting` forever: nothing clears it, there is no reaper, and per #215 there cannot be one
 * until the claim records a timestamp. The close route counts that row as pending and refuses, so
 * the table is stuck with no way out from the terminal — both close handlers previously answered
 * "Failed to close table. Please close from the dashboard.", and the dashboard was the wrong
 * escape hatch because it closed OVER the round instead of releasing it.
 *
 * WHY THIS IS SHARED RATHER THAN BUILT TWICE. Two screens close tables (TableDetailScreen and
 * PaymentScreen) and both hit the identical dead end. A second copy of a safety-critical
 * `status === 'accepting'` check is a second place to get it wrong.
 *
 * WHAT IT WILL NOT DO. It never offers the action for a `waiting_review` row. That is a real round
 * a customer placed, and releasing it is meaningless there — dismissing one is #120's own bug from
 * the other side. Rows that cannot be released are still LISTED, because "why can't I close this
 * table" needs an answer even when the answer is "go and review these".
 */
type Props = {
  visible: boolean;
  /** The rows the close route reported as blocking. */
  requests: PendingOrderRequest[];
  /** The close route's own explanation, already staff-facing. */
  message: string;
  onDismiss: () => void;
  /**
   * Called after at least one row was released, so the caller can retry the close. Not called when
   * nothing was released — there is nothing new to retry.
   */
  onReleased: () => void;
};

function describeRequest(row: PendingOrderRequest): string {
  const parts: string[] = [];
  if (row.value != null) {
    parts.push(`N$${row.value.toFixed(2)}`);
  }
  if (row.placedAt) {
    const at = new Date(row.placedAt);
    if (!Number.isNaN(at.getTime())) {
      parts.push(
        at.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}),
      );
    }
  }
  return parts.join(' · ');
}

export default function StrandedRequestPrompt({
  visible,
  requests,
  message,
  onDismiss,
  onReleased,
}: Props) {
  /** Ids currently being released, so one row's spinner cannot block the others. */
  const [releasing, setReleasing] = useState<string[]>([]);
  const [releasedAny, setReleasedAny] = useState(false);

  const handleRelease = async (row: PendingOrderRequest) => {
    if (releasing.includes(row.id)) {
      return;
    }
    setReleasing(prev => [...prev, row.id]);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }
      const result = await releaseStrandedRequest(row.id, token);
      // Both outcomes are success. `alreadyResolved` means the accept route finished its own
      // release while this one was in flight, which is a routine race on a shared floor and
      // leaves the row un-stranded either way.
      if (result.released || result.alreadyResolved) {
        setReleasedAny(true);
        onReleased();
      }
    } catch (err) {
      // Surfaces the server's own words. NOT_A_STRANDED_CLAIM lands here on purpose: it means
      // this screen offered an action for a row the server does not consider stranded, which is a
      // real disagreement and should not be swallowed.
      Alert.alert(
        'Could not release',
        err instanceof Error
          ? err.message
          : 'Could not release this request. Refresh the table and try again.',
      );
    } finally {
      setReleasing(prev => prev.filter(id => id !== row.id));
    }
  };

  const releasable = requests.filter(isReleasableStrandedRequest);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Table cannot be closed</Text>
          <Text style={styles.message}>{message}</Text>

          {/*
            Only the releasable rows get the explanation, because it describes an action that is
            not offered for the others. Showing it above a list where most rows have no button
            would read as if every row could be released.
          */}
          {releasable.length > 0 ? (
            <Text style={styles.body}>{RELEASE_STUCK_REQUEST_BODY}</Text>
          ) : null}

          <View style={styles.list}>
            {requests.map(row => {
              const canRelease = isReleasableStrandedRequest(row);
              const detail = describeRequest(row);
              return (
                <View key={row.id} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>
                      {canRelease ? 'Stuck mid-accept' : 'Waiting for review'}
                    </Text>
                    {detail ? (
                      <Text style={styles.rowDetail}>{detail}</Text>
                    ) : null}
                  </View>
                  {canRelease ? (
                    <LoadingButton
                      style={styles.releaseButton}
                      loading={releasing.includes(row.id)}
                      disabled={releasing.includes(row.id)}
                      onPress={() => handleRelease(row)}
                      spinnerColor={Colors.white}>
                      <Text style={styles.releaseButtonText}>
                        {RELEASE_STUCK_REQUEST_LABEL}
                      </Text>
                    </LoadingButton>
                  ) : null}
                </View>
              );
            })}
          </View>

          <Pressable style={styles.dismissButton} onPress={onDismiss}>
            <Text style={styles.dismissText}>
              {releasedAny ? 'Done' : 'Close'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: Spacing.lg,
  },
  card: {
    backgroundColor: Colors.background,
    borderRadius: 16,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  title: {
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  message: {
    ...Typography.small,
    color: Colors.textSecondary,
  },
  body: {
    ...Typography.small,
    color: Colors.textPrimary,
    marginTop: Spacing.xs,
  },
  list: {
    marginTop: Spacing.sm,
    gap: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  rowText: {
    flexShrink: 1,
  },
  rowLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
  },
  rowDetail: {
    ...Typography.tiny,
    color: Colors.textMuted,
  },
  releaseButton: {
    backgroundColor: Colors.amber,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  releaseButtonText: {
    ...Typography.small,
    color: Colors.white,
    fontWeight: '600',
  },
  dismissButton: {
    marginTop: Spacing.md,
    paddingVertical: Spacing.sm,
    alignItems: 'center',
  },
  dismissText: {
    ...Typography.subheading,
    color: Colors.textSecondary,
  },
});
