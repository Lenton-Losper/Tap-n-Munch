import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import * as Copy from '../constants/menuAvailabilityCopy';
import {
  ApiRequestError,
  AuthorizationDeniedError,
  AuthorizedUser,
  authorizeAction,
  getAuthorizedUsers,
  getMenuItems,
  isPinLockedError,
  MenuItem,
  setMenuItemAvailability,
  staffMessageForPinLock,
} from '../lib/api';
import {
  applyAvailabilityOverrides,
  recordAvailabilityChange,
} from '../lib/menuAvailabilityOverrides';
import {getRestaurantId, getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'MenuItemDetail'>;

/**
 * The purpose string is part of the contract, not a label. GET /authorized-users filters on it and
 * POST /authorize scopes the issued token to it — a `service_session` token will not change menu
 * availability, and a `menu_availability` one will not open a table.
 */
const PURPOSE = 'menu_availability';

/** Which way the sheet is pointing. Null means the sheet is closed. */
type Direction = 'hide' | 'restore';

function formatMoney(amount: number): string {
  return `N$${amount.toFixed(2)}`;
}

/**
 * What to show for a refusal.
 *
 * THE SERVER'S `message` WINS WHENEVER THERE IS ONE. The signed strings are the fallback for a
 * refusal that arrives without one. See the refusal section of constants/menuAvailabilityCopy.ts
 * for why it is this way round and what to change to reverse it — this function is the one line.
 */
function refusalMessage(refusal: string, message: string): string {
  if (message) {
    return message;
  }
  if (refusal === 'already_in_that_state') {
    return Copy.REFUSAL_ALREADY_IN_THAT_STATE;
  }
  if (refusal === 'item_not_found') {
    return Copy.REFUSAL_ITEM_NOT_FOUND;
  }
  if (refusal === 'authorization_failed') {
    return Copy.REFUSAL_AUTHORIZATION_FAILED;
  }
  return Copy.REFUSAL_WITHOUT_MESSAGE;
}

/**
 * THE ITEM DETAIL VIEW, and the only place on the terminal a dish can be taken off the menu.
 *
 * The risk this screen is shaped by, in the owner's words: "a waiter marking a dish unavailable
 * mid-service is one tap away from a waiter marking the wrong dish unavailable mid-service." Four
 * decisions follow from that, and each is load-bearing rather than stylistic:
 *
 * 1. THE DISH NAME IS THE CONFIRMATION. The sheet is dominated by the name, rendered large, and
 *    that name comes from THE RECORD THIS SCREEN FETCHED — never from the tile the waiter tapped.
 *    If the wrong dish was hit, the wrong name is the biggest thing on screen and is read before
 *    any button is reachable. `route.params.tappedName` exists and is deliberately NEVER RENDERED;
 *    see its docblock in AppNavigator and the test that holds it to that.
 *
 * 2. THE PIN KEYPAD IS THE SHEET. There is no separate "Are you sure?" step and none may be added.
 *    A second confirm is trained away by the third service; four digits cannot be muscle-memoried
 *    through, and they are already mandatory because the server demands them.
 *
 * 3. PLACEMENT. The control sits below the fold, and this screen carries NOTHING used to build an
 *    order — no add-to-round, no quantity. It is not reachable by swipe or by long-press anywhere:
 *    a mis-swipe while scrolling a menu must never arrive here.
 *
 * 4. UNDO IN THE TOAST IS THE REAL SAFETY NET. After a hide, the toast carries a restore action
 *    for UNDO_WINDOW_MS. Mis-hiding a dish is a five-second recovery, and that is worth more than
 *    any confirm.
 *
 * AND ONE PROHIBITION: NO OPTIMISTIC UI. Nothing about this dish's state changes anywhere — not
 * here, not in the menu grid — until the 200 has resolved. The whole value of the call is the
 * server-side menu-cache invalidation having completed; showing the dish greyed before the write
 * lands teaches waiters to trust a state that is not real.
 */
export default function MenuItemDetailScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {itemId, categoryId} = route.params;

  const [item, setItem] = useState<MenuItem | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * A BOOLEAN, NOT A MESSAGE. The underlying failure is a token read, a network error or an HTTP
   * status, and none of those carry wording anybody signed off. The cause goes to the console for
   * diagnosis; the screen shows the one string that was written for this.
   */
  const [loadFailed, setLoadFailed] = useState(false);

  const [direction, setDirection] = useState<Direction | null>(null);

  const [users, setUsers] = useState<AuthorizedUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [selected, setSelected] = useState<AuthorizedUser | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pinInputRef = useRef<TextInput>(null);

  /** `restorable` is set only after a HIDE — a restore needs no undo, the screen offers it again. */
  const [toast, setToast] = useState<{text: string; restorable: boolean} | null>(
    null,
  );
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToastTimer = useCallback(() => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
  }, []);

  // A timer that outlives the screen would call setState on an unmounted tree, and this one is ten
  // seconds long — comfortably long enough for a waiter to leave first.
  useEffect(() => clearToastTimer, [clearToastTimer]);

  const showToast = useCallback(
    (text: string, restorable: boolean) => {
      clearToastTimer();
      setToast({text, restorable});
      toastTimer.current = setTimeout(
        () => setToast(null),
        Copy.UNDO_WINDOW_MS,
      );
    },
    [clearToastTimer],
  );

  /**
   * FETCHES THE ITEM RECORD. This is the whole of decision 1 above.
   *
   * There is no per-item route and none is being invented: the category listing is the existing
   * way to read a menu item, and the record for `itemId` is picked out of it. A miss is NOT an
   * error — the dish was deleted or moved category — and it disables the control, because with no
   * fetched name there is nothing to confirm against.
   */
  const loadItem = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const token = await getTerminalToken();
      const restaurantId = await getRestaurantId();
      if (!token || !restaurantId) {
        setLoadFailed(true);
        return;
      }
      const items = await getMenuItems(token, restaurantId, categoryId);
      const found = items.find(row => row.id === itemId) ?? null;
      // Anything this device has already changed outranks a listing fetched afterwards only in the
      // sense that it is the same server's answer, recorded at the moment it was given.
      setItem(found ? applyAvailabilityOverrides([found])[0] : null);
    } catch (err) {
      console.warn('[menu-availability] item load failed', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [categoryId, itemId]);

  useEffect(() => {
    loadItem();
  }, [loadItem]);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setUsers([]);
        return;
      }
      const found = await getAuthorizedUsers(PURPOSE, token);
      setUsers(found);
      // ONE authorised person is not a choice, it is a step. Decision 2 says the PIN keypad IS the
      // sheet; making a waiter tap the only name on the list first is the ceremony that decision
      // exists to remove.
      if (found.length === 1) {
        setSelected(found[0]);
      }
    } catch (err) {
      console.warn('[menu-availability] staff list failed', err);
      setUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const openSheet = useCallback(
    (next: Direction) => {
      setDirection(next);
      setSelected(null);
      setPin('');
      setPinError(null);
      setRefusal(null);
      setLocked(false);
      setToast(null);
      clearToastTimer();
      loadUsers();
    },
    [clearToastTimer, loadUsers],
  );

  const closeSheet = useCallback(() => {
    setDirection(null);
    setSelected(null);
    setPin('');
    setPinError(null);
    setRefusal(null);
    setLocked(false);
  }, []);

  const submit = useCallback(async () => {
    if (!item || !selected || !direction || pin.length !== 4 || busy || locked) {
      return;
    }
    setBusy(true);
    setPinError(null);
    setRefusal(null);

    try {
      const token = await getTerminalToken();
      if (!token) {
        setPinError(Copy.REFUSAL_AUTHORIZATION_FAILED);
        return;
      }

      // Step 1. authorizeAction deliberately bypasses terminalFetch: a 401 HERE is a wrong PIN, and
      // refreshing the terminal token in answer to it is the loop that produced #327.
      const auth = await authorizeAction(
        {userId: selected.user_id, pin, purpose: PURPOSE},
        token,
      );

      // Step 2, IMMEDIATELY. The token is single-use and lives 90 seconds. Nothing goes between
      // these two calls — no confirmation, no navigation, no caching of token_id. This is exactly
      // the shape ServiceOpenTableScreen uses for opening a table, and for the same reason.
      const outcome = await setMenuItemAvailability(
        {
          itemId: item.id,
          userId: selected.user_id,
          authorizationTokenId: auth.token_id,
          available: direction === 'restore',
        },
        token,
      );

      if (!outcome.ok) {
        // A REFUSAL IS NOT AN ERROR. `already_in_that_state` in particular is a normal outcome
        // during service: somebody else reached the same empty tray first. It is shown in the
        // neutral style, the PIN is cleared because it has been spent, and the record is re-read so
        // the screen ends up showing the server's truth rather than the state it walked in with.
        setRefusal(refusalMessage(outcome.refusal, outcome.message));
        setPin('');
        loadItem();
        return;
      }

      // ─── AND ONLY HERE DOES ANYTHING CHANGE. ───
      // Every line below this point runs after the 200 has resolved. Nothing above it touches
      // `item`, the overrides store, or the toast.
      const nowHidden = outcome.hidden || outcome.item.status === 'hidden';
      const nowAvailable = !nowHidden;

      setItem(prev =>
        prev
          ? {
              ...prev,
              is_available: nowAvailable,
              // The server's name, not the device's — it is the record that was just written.
              name: outcome.item.name || prev.name,
            }
          : prev,
      );
      recordAvailabilityChange(item.id, nowAvailable);
      closeSheet();
      showToast(
        nowAvailable ? Copy.SUCCESS_RESTORED : Copy.SUCCESS_HIDDEN,
        !nowAvailable,
      );
    } catch (err) {
      setPin('');

      // Rate limiting comes back as an ApiRequestError with staff copy already written for it in
      // lib/staffApiErrors.ts. Reused rather than re-worded.
      if (err instanceof ApiRequestError && isPinLockedError(err)) {
        setLocked(true);
        setPinError(staffMessageForPinLock(err));
        return;
      }

      // 401 PIN_MISMATCH and a bare 403 both come back here from POST /authorize. The server's own
      // message is shown; the signed refusal string is the fallback when it sends none.
      if (err instanceof AuthorizationDeniedError) {
        setPinError(err.message || Copy.REFUSAL_AUTHORIZATION_FAILED);
        if (err.status !== 403) {
          pinInputRef.current?.focus();
        }
        return;
      }

      if (err instanceof ApiRequestError) {
        setPinError(err.message || Copy.REFUSAL_AUTHORIZATION_FAILED);
        return;
      }

      setPinError(
        err instanceof Error && err.message
          ? err.message
          : Copy.REFUSAL_WITHOUT_MESSAGE,
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    closeSheet,
    direction,
    item,
    loadItem,
    locked,
    pin,
    selected,
    showToast,
  ]);

  const sheetTitle =
    direction === 'restore' ? Copy.SHEET_TITLE_RESTORE : Copy.SHEET_TITLE_HIDE;
  const sheetBody =
    direction === 'restore' ? Copy.SHEET_BODY_RESTORE : Copy.SHEET_BODY_HIDE;
  const acceptLabel =
    direction === 'restore' ? Copy.RESTORE_BUTTON : Copy.SHEET_ACCEPT_LABEL;

  const pinPrompt = useMemo(
    () =>
      selected ? Copy.SHEET_PIN_PROMPT.replace('{name}', selected.name) : '',
    [selected],
  );

  const canSubmit = Boolean(selected) && pin.length === 4 && !busy && !locked;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.topBar, {paddingTop: insets.top + Spacing.sm}]}>
        <Pressable
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button">
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : loadFailed || !item ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>
            {loadFailed ? Copy.DETAIL_LOAD_FAILED : Copy.DETAIL_ITEM_MISSING}
          </Text>
          <Pressable style={styles.secondaryButton} onPress={loadItem}>
            <Text style={styles.secondaryButtonText}>{Copy.RETRY_BUTTON}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}>
          {/* The dish, as the fetched record describes it. */}
          <Text style={styles.itemName}>{item.name}</Text>
          <Text style={styles.itemPrice}>{formatMoney(item.base_price)}</Text>
          {item.description ? (
            <Text style={styles.itemDescription}>{item.description}</Text>
          ) : null}

          <View
            style={[
              styles.statusChip,
              item.is_available ? styles.statusChipOn : styles.statusChipOff,
            ]}>
            <Text
              style={[
                styles.statusChipText,
                item.is_available
                  ? styles.statusChipTextOn
                  : styles.statusChipTextOff,
              ]}>
              {item.is_available ? Copy.STATUS_AVAILABLE : Copy.STATUS_HIDDEN}
            </Text>
          </View>

          {/*
            BELOW THE FOLD, ON PURPOSE, AND THIS SPACER IS THE MECHANISM.
            The control must be reached by a deliberate scroll, never landed on while reading the
            dish. Removing this spacer to "tidy up the layout" removes the separation the design
            asked for, so it is not a stylistic value.
          */}
          <View style={styles.foldSpacer} />

          <View style={styles.controlBlock}>
            <Pressable
              style={styles.destructiveButton}
              onPress={() => openSheet(item.is_available ? 'hide' : 'restore')}>
              <Text style={styles.destructiveButtonText}>
                {item.is_available
                  ? Copy.CONTROL_BUTTON_HIDE
                  : Copy.RESTORE_BUTTON}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/*
        THE SAFETY NET. A restore action for UNDO_WINDOW_MS after a hide. It re-opens the sheet in
        the restore direction rather than restoring straight away: the server requires a PIN in
        both directions, so there is no cheaper path, and the sheet is where a PIN is entered.
      */}
      {toast ? (
        <View style={[styles.toast, {paddingBottom: insets.bottom + Spacing.md}]}>
          <Text style={styles.toastText}>{toast.text}</Text>
          {toast.restorable ? (
            <Pressable
              style={styles.toastAction}
              onPress={() => openSheet('restore')}>
              <Text style={styles.toastActionText}>{Copy.RESTORE_BUTTON}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Modal
        visible={direction !== null}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}>
        <View style={styles.sheetBackdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.sheetWrapper}>
            <View
              style={[
                styles.sheet,
                {paddingBottom: insets.bottom + Spacing.lg},
              ]}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>{sheetTitle}</Text>
                <Pressable onPress={closeSheet} hitSlop={10} disabled={busy}>
                  <MaterialCommunityIcons
                    name="close"
                    size={24}
                    color={Colors.textSecondary}
                  />
                </Pressable>
              </View>

              {/*
                THE CONFIRMATION ITSELF. The biggest thing on the sheet, and it is `item.name` —
                the FETCHED record. Never route.params.tappedName. If the waiter hit the wrong
                tile, this is what they read before any button below is reachable.
              */}
              <Text style={styles.sheetItemName}>{item?.name ?? ''}</Text>

              <Text style={styles.sheetBody}>{sheetBody}</Text>

              {refusal ? (
                <View style={styles.refusalBox}>
                  <Text style={styles.refusalText}>{refusal}</Text>
                </View>
              ) : null}

              {/*
                The PIN flow, unchanged from the one that opens a table: pick the person, enter
                four digits. There is NO "are you sure?" between this and the write — the four
                digits are the confirmation, and a second one would be trained away by the third
                service.
              */}
              {loadingUsers ? (
                <View style={styles.sheetLoading}>
                  <ActivityIndicator color={Colors.primary} />
                </View>
              ) : selected ? (
                <View>
                  <Text style={styles.pinPrompt}>{pinPrompt}</Text>
                  <TextInput
                    ref={pinInputRef}
                    style={styles.pinInput}
                    value={pin}
                    onChangeText={text => {
                      // Client-side first: the route rejects anything that is not exactly four
                      // digits with a 400, and burning a round-trip to learn that helps nobody.
                      setPin(text.replace(/\D/g, '').slice(0, 4));
                      setPinError(null);
                    }}
                    placeholder="••••"
                    placeholderTextColor={Colors.textMuted}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={4}
                    editable={!busy && !locked}
                    autoFocus
                  />
                  {pinError ? (
                    <Text style={styles.pinError}>{pinError}</Text>
                  ) : null}

                  <Pressable
                    style={[
                      styles.acceptButton,
                      !canSubmit && styles.buttonDisabled,
                    ]}
                    onPress={submit}
                    disabled={!canSubmit}>
                    {busy ? (
                      <ActivityIndicator color={Colors.white} />
                    ) : (
                      <Text style={styles.acceptButtonText}>{acceptLabel}</Text>
                    )}
                  </Pressable>
                </View>
              ) : users.length === 0 ? (
                <Text style={styles.sheetEmpty}>{Copy.SHEET_STAFF_EMPTY}</Text>
              ) : (
                <View>
                  <Text style={styles.sheetStaffHeading}>
                    {Copy.SHEET_STAFF_HEADING}
                  </Text>
                  <FlatList
                    data={users}
                    keyExtractor={row => row.user_id}
                    style={styles.staffList}
                    keyboardShouldPersistTaps="handled"
                    renderItem={({item: row}) => (
                      <Pressable
                        style={styles.staffRow}
                        onPress={() => {
                          setSelected(row);
                          setPin('');
                          setPinError(null);
                        }}>
                        <MaterialCommunityIcons
                          name="account-outline"
                          size={22}
                          color={Colors.primary}
                        />
                        <Text style={styles.staffName}>{row.name}</Text>
                      </Pressable>
                    )}
                  />
                </View>
              )}
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: Colors.background},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  scroll: {flex: 1},
  scrollContent: {padding: Spacing.lg, paddingBottom: Spacing.xl},
  itemName: {...Typography.heading, color: Colors.textPrimary},
  itemPrice: {
    ...Typography.subheading,
    color: Colors.textSecondary,
    marginTop: Spacing.xs,
  },
  itemDescription: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
    lineHeight: 22,
  },
  statusChip: {
    alignSelf: 'flex-start',
    marginTop: Spacing.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 999,
  },
  statusChipOn: {backgroundColor: Colors.greenLight},
  statusChipOff: {backgroundColor: Colors.redLight},
  statusChipText: {...Typography.small, fontWeight: '600'},
  statusChipTextOn: {color: Colors.green},
  statusChipTextOff: {color: Colors.red},
  /** See the comment at the call site: this is the fold, not decoration. */
  foldSpacer: {height: 320},
  controlBlock: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: Spacing.lg,
  },
  destructiveButton: {
    borderWidth: 1.5,
    borderColor: Colors.red,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  destructiveButtonText: {color: Colors.red, ...Typography.subheading},
  secondaryButton: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  secondaryButtonText: {color: Colors.textPrimary, fontSize: 17, fontWeight: '600'},
  errorText: {...Typography.body, color: Colors.red, textAlign: 'center'},

  toast: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.primary,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  toastText: {flex: 1, color: Colors.white, ...Typography.body},
  toastAction: {paddingVertical: Spacing.sm, paddingHorizontal: Spacing.sm},
  toastActionText: {
    color: Colors.white,
    ...Typography.body,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },

  sheetBackdrop: {flex: 1, backgroundColor: 'rgba(17,24,39,0.55)'},
  sheetWrapper: {flex: 1, justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: Spacing.lg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {flex: 1, ...Typography.subheading, color: Colors.textPrimary},
  /** Decision 1: the name is the confirmation, so it is the largest thing on the sheet. */
  sheetItemName: {
    ...Typography.heading,
    fontSize: 32,
    color: Colors.textPrimary,
    marginTop: Spacing.md,
  },
  sheetBody: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginTop: Spacing.md,
    lineHeight: 22,
  },
  refusalBox: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  refusalText: {...Typography.body, color: Colors.textPrimary},
  sheetLoading: {paddingVertical: Spacing.xl, alignItems: 'center'},
  sheetStaffHeading: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  staffList: {maxHeight: 240},
  staffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  staffName: {flex: 1, ...Typography.body, fontWeight: '600', color: Colors.textPrimary},
  sheetEmpty: {
    ...Typography.body,
    color: Colors.textSecondary,
    marginTop: Spacing.lg,
  },
  pinPrompt: {
    ...Typography.small,
    color: Colors.textSecondary,
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  pinInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 16,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 8,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  pinError: {
    color: Colors.red,
    ...Typography.small,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  acceptButton: {
    backgroundColor: Colors.red,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: Spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: {opacity: 0.6},
  acceptButtonText: {color: Colors.white, ...Typography.subheading},
});
