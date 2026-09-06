/**
 * THE MANAGER APPROVAL BLOCK, INSIDE THE AMEND SHEET.
 *
 * ================================================================================================
 * WHY IT LIVES HERE AND NOT ON ITS OWN SCREEN
 * ================================================================================================
 *
 * Same reason as WalkoutOverride: the waiter is at the table with the customer waiting and a
 * manager standing next to them. Sending them somewhere else to find the approval is how an item
 * that should have come off stays on the bill and gets argued about at settle.
 *
 * ================================================================================================
 * IT COLLECTS. IT DOES NOT SUBMIT.
 * ================================================================================================
 *
 * The PIN is exchanged for a single-use token at the moment of the amend, by the sheet, in one
 * action -- NOT here on a button of its own. Two confirm buttons on one sheet is how a waiter
 * approves and then walks away thinking the item came off. It also matters that the token is minted
 * and spent in the same press: it is single-use and short-lived, and one minted on a separate tap
 * can expire while somebody discusses the bill.
 *
 * NOTHING HERE IS AN AUTHORISATION. The server mints and consumes; this is a form.
 */
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  VOID_NEEDS_APPROVAL_BODY,
  VOID_NEEDS_APPROVAL_TITLE,
  VOID_NO_MANAGERS,
  VOID_PICK_MANAGER,
  VOID_PIN_PROMPT,
  VOID_REASON_PROMPT,
} from '../constants/voidCopy';
import {MAX_VOID_REASON_LENGTH, type VoidApprovalDraft} from '../lib/voidApproval';
import {getAuthorizedUsers, type AuthorizedUser} from '../lib/api';
import {getTerminalToken} from '../lib/storage';

export default function VoidApproval({
  draft,
  onChange,
  disabled,
}: {
  draft: VoidApprovalDraft | null;
  onChange: (next: VoidApprovalDraft | null) => void;
  disabled: boolean;
}) {
  const [managers, setManagers] = useState<AuthorizedUser[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getTerminalToken();
        if (!token) {
          if (!cancelled) {
            setManagers([]);
          }
          return;
        }
        const users = await getAuthorizedUsers('line_void', token);
        if (!cancelled) {
          setManagers(users);
        }
      } catch {
        // An empty list and a failed read look the same to a waiter, and both mean the same thing
        // to them: nobody here can approve it right now. Distinguishing them needs wording nobody
        // has signed.
        if (!cancelled) {
          setManagers([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (managers === null) {
    return (
      <View style={styles.block} testID="void-approval-loading">
        <ActivityIndicator color={Colors.primary} />
      </View>
    );
  }

  if (managers.length === 0) {
    return (
      <View style={styles.block} testID="void-approval-no-managers">
        <Text style={styles.title}>{VOID_NEEDS_APPROVAL_TITLE}</Text>
        <Text style={styles.noManagers}>{VOID_NO_MANAGERS}</Text>
      </View>
    );
  }

  const selectedId = draft?.staffUserId ?? null;

  return (
    <View style={styles.block} testID="void-approval">
      <Text style={styles.title}>{VOID_NEEDS_APPROVAL_TITLE}</Text>
      <Text style={styles.body}>{VOID_NEEDS_APPROVAL_BODY}</Text>

      <Text style={styles.label}>{VOID_PICK_MANAGER}</Text>
      <View style={styles.managerRow}>
        {managers.map(m => (
          <Pressable
            key={m.user_id}
            testID={`void-manager-${m.user_id}`}
            disabled={disabled}
            style={[styles.chip, selectedId === m.user_id && styles.chipOn]}
            onPress={() => {
              // Switching who is approving CLEARS THE PIN. Carrying it over would submit one
              // person's code against another person's name.
              onChange({
                staffUserId: m.user_id,
                name: m.name,
                pin: '',
                reason: draft?.reason ?? '',
              });
            }}>
            <Text style={[styles.chipText, selectedId === m.user_id && styles.chipTextOn]}>
              {m.name}
            </Text>
          </Pressable>
        ))}
      </View>

      {draft ? (
        <>
          <TextInput
            testID="void-pin"
            style={styles.input}
            value={draft.pin}
            onChangeText={pin => onChange({...draft, pin})}
            editable={!disabled}
            placeholder={VOID_PIN_PROMPT.replace('{name}', draft.name)}
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={12}
          />
          <TextInput
            testID="void-reason"
            style={styles.input}
            value={draft.reason}
            onChangeText={reason => onChange({...draft, reason})}
            editable={!disabled}
            placeholder={VOID_REASON_PROMPT}
            placeholderTextColor={Colors.textMuted}
            // Stops at the server's own limit, so VOID_REASON_TOO_LONG is a disagreement between
            // the two sides rather than something a waiter can type their way into.
            maxLength={MAX_VOID_REASON_LENGTH}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    marginTop: Spacing.sm,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: Spacing.sm,
  },
  title: {...Typography.subheading, color: Colors.textPrimary},
  body: {...Typography.small, color: Colors.textSecondary},
  label: {...Typography.small, color: Colors.textSecondary, marginTop: Spacing.xs},
  managerRow: {flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs},
  chip: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#F3F4F6',
  },
  chipOn: {backgroundColor: Colors.primary},
  chipText: {...Typography.small, color: Colors.textPrimary},
  chipTextOn: {color: '#FFFFFF', fontWeight: '700'},
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    ...Typography.body,
    color: Colors.textPrimary,
  },
  noManagers: {...Typography.small, color: Colors.textSecondary},
});
