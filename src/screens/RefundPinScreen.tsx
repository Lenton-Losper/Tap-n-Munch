import React, {useRef, useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {AuthorizationDeniedError, authorizeAction} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'RefundPin'>;

const SYSTEM_ERROR_MESSAGE =
  'Unable to verify PIN — check your connection and try again';

export default function RefundPinScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {userId, userName, orderId, tableId, tableNumber, total} = route.params;
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [systemError, setSystemError] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handlePinChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 4);
    setPin(digits);
    setPinError(null);
  };

  const handleConfirm = async () => {
    if (pin.length !== 4 || loading) {
      return;
    }

    setLoading(true);
    setPinError(null);
    setSystemError(false);

    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired');
      }

      const result = await authorizeAction(
        {userId, pin, purpose: 'refund'},
        token,
      );

      navigation.navigate('RefundConfirm', {
        authTokenId: result.token_id,
        userId,
        orderId,
        tableId,
        tableNumber,
        total,
      });
    } catch (err) {
      if (err instanceof AuthorizationDeniedError) {
        setPin('');
        setPinError('Incorrect PIN. Please try again.');
        inputRef.current?.focus();
      } else {
        setSystemError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSystemRetry = () => {
    setSystemError(false);
    setPin('');
    setPinError(null);
    inputRef.current?.focus();
  };

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
        <Text style={styles.screenTitle}>Enter PIN</Text>
        <View style={styles.backButton} />
      </View>

      {systemError ? (
        <View style={styles.centered}>
          <Text style={styles.systemErrorText}>{SYSTEM_ERROR_MESSAGE}</Text>
          <Pressable style={styles.retryButton} onPress={handleSystemRetry}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <KeyboardAvoidingView
          style={styles.content}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Text style={styles.title}>Enter PIN for {userName}</Text>

          <TextInput
            ref={inputRef}
            style={styles.input}
            value={pin}
            onChangeText={handlePinChange}
            placeholder="••••"
            placeholderTextColor={Colors.textMuted}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            editable={!loading}
            autoFocus
          />

          {pinError ? <Text style={styles.pinError}>{pinError}</Text> : null}

          <Pressable
            style={[
              styles.confirmButton,
              (pin.length !== 4 || loading) && styles.buttonDisabled,
            ]}
            onPress={handleConfirm}
            disabled={pin.length !== 4 || loading}>
            {loading ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <Text style={styles.confirmButtonText}>Confirm</Text>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      )}
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
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  title: {
    ...Typography.heading,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  input: {
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
  confirmButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: Spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    color: Colors.white,
    ...Typography.subheading,
  },
  systemErrorText: {
    ...Typography.body,
    color: Colors.red,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  retryButton: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  retryButtonText: {
    color: Colors.textPrimary,
    fontSize: 17,
    fontWeight: '600',
  },
});
