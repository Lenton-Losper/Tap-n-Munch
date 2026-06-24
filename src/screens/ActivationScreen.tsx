import React, {useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {useAuth} from '../context/AuthContext';
import {Colors, Spacing, Typography} from '../constants/theme';
import {activateTerminal} from '../lib/api';

function formatActivationCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const withoutPrefix = cleaned.startsWith('FT') ? cleaned.slice(2) : cleaned;
  const chars = withoutPrefix.slice(0, 8);

  if (chars.length <= 4) {
    return chars.length > 0 ? `FT-${chars}` : '';
  }

  return `FT-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export default function ActivationScreen() {
  const {signIn} = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCodeChange = (text: string) => {
    setCode(formatActivationCode(text));
    setError(null);
  };

  const handleActivate = async () => {
    if (!/^FT-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
      setError('Enter a valid code in format FT-XXXX-XXXX');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await activateTerminal(code);
      signIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed');
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.content}>
        <View style={styles.brandRow}>
          <Text style={styles.logoFlash}>Flash</Text>
          <Text style={styles.logoTap}>Tap</Text>
        </View>

        <View style={styles.iconWrap}>
          <MaterialCommunityIcons
            name="point-of-sale"
            size={56}
            color={Colors.textSecondary}
          />
        </View>

        <Text style={styles.title}>Activate Terminal</Text>
        <Text style={styles.subtitle}>Enter your activation code</Text>

        <TextInput
          style={styles.input}
          value={code}
          onChangeText={handleCodeChange}
          placeholder="FT-XXXX-XXXX"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          editable={!loading}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleActivate}
          disabled={loading}>
          {loading ? (
            <ActivityIndicator color={Colors.white} />
          ) : (
            <Text style={styles.buttonText}>Activate</Text>
          )}
        </Pressable>
      </View>

      <Pressable
        style={styles.supportLink}
        onPress={() => Linking.openURL('mailto:support@flashtap.app')}>
        <Text style={styles.supportText}>Need help? Contact support</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  logoFlash: {
    fontSize: 40,
    fontWeight: '800',
    color: Colors.primary,
    letterSpacing: -1,
  },
  logoTap: {
    fontSize: 40,
    fontWeight: '800',
    color: Colors.green,
    letterSpacing: -1,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  title: {
    ...Typography.heading,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.sm,
  },
  subtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
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
    letterSpacing: 3,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  error: {
    color: Colors.red,
    ...Typography.small,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
  button: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: Spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: Colors.white,
    ...Typography.subheading,
  },
  supportLink: {
    paddingVertical: Spacing.lg,
    alignItems: 'center',
  },
  supportText: {
    ...Typography.small,
    color: Colors.textMuted,
  },
});
