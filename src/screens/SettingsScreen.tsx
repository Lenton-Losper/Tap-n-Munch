import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useAuth} from '../context/AuthContext';
import {useStreamConnection} from '../context/StreamContext';
import {APP_VERSION} from '../constants';
import {Colors, Spacing, Typography} from '../constants/theme';
import {clearAllData, getRestaurantName, getTerminalId} from '../lib/storage';

export default function SettingsScreen() {
  const {signOut} = useAuth();
  const {connectionStatus} = useStreamConnection();
  const [restaurantName, setRestaurantName] = useState('—');
  const [terminalId, setTerminalId] = useState('—');
  const [deactivating, setDeactivating] = useState(false);

  useEffect(() => {
    async function loadInfo() {
      const [name, id] = await Promise.all([
        getRestaurantName(),
        getTerminalId(),
      ]);
      if (name) {
        setRestaurantName(name);
      }
      if (id) {
        setTerminalId(id);
      }
    }

    loadInfo();
  }, []);

  const handleDeactivate = () => {
    Alert.alert(
      'Deactivate Terminal',
      'This will remove the terminal token from this device. You will need to activate again.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: async () => {
            setDeactivating(true);
            await clearAllData();
            signOut();
            setDeactivating(false);
          },
        },
      ],
    );
  };

  const statusColor =
    connectionStatus === 'connected'
      ? Colors.green
      : connectionStatus === 'disconnected'
        ? Colors.red
        : Colors.textMuted;

  const statusLabel =
    connectionStatus === 'connected'
      ? 'Connected'
      : connectionStatus === 'disconnected'
        ? 'Disconnected'
        : 'Checking…';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Terminal Info</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Restaurant</Text>
          <Text style={styles.rowValue}>{restaurantName}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Terminal ID</Text>
          <Text style={styles.rowValue}>{terminalId}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>App version</Text>
          <Text style={styles.rowValue}>{APP_VERSION}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, {backgroundColor: statusColor}]} />
          <Text style={styles.rowValue}>FlashTap — {statusLabel}</Text>
        </View>
        <Text style={styles.hintText}>
          Live order stream status. Polling continues every 30s as backup.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        <Pressable
          disabled={deactivating}
          onPress={handleDeactivate}
          style={styles.deactivateRow}>
          {deactivating ? (
            <ActivityIndicator color={Colors.red} />
          ) : (
            <Text style={styles.deactivateText}>Deactivate Terminal</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  content: {
    padding: Spacing.lg,
    paddingBottom: 40,
  },
  title: {
    ...Typography.heading,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },
  section: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    ...Typography.tiny,
    fontWeight: '700',
    color: Colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowLabel: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  rowValue: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: Spacing.md,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  hintText: {
    ...Typography.small,
    color: Colors.textMuted,
  },
  deactivateRow: {
    paddingVertical: Spacing.sm,
  },
  deactivateText: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.red,
  },
});
