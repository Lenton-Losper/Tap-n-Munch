import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {AuthorizedUser, getAuthorizedUsers} from '../lib/api';
import {getTerminalToken} from '../lib/storage';
import {MainStackParamList} from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<MainStackParamList, 'RefundAuth'>;

export default function RefundAuthScreen({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const {orderId, tableId, tableNumber, total} = route.params;
  const [users, setUsers] = useState<AuthorizedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        throw new Error('Session expired. Please re-activate.');
      }
      const fetched = await getAuthorizedUsers('refund', token);
      setUsers(fetched);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load authorized staff',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSelectUser = (user: AuthorizedUser) => {
    navigation.navigate('RefundPin', {
      userId: user.user_id,
      userName: user.name,
      orderId,
      tableId,
      tableNumber,
      total,
    });
  };

  const renderUserRow = ({item}: {item: AuthorizedUser}) => (
    <Pressable
      style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => handleSelectUser(item)}>
      <MaterialCommunityIcons
        name="account-outline"
        size={24}
        color={Colors.primary}
      />
      <Text style={styles.userName}>{item.name}</Text>
      <MaterialCommunityIcons
        name="chevron-right"
        size={22}
        color={Colors.textMuted}
      />
    </Pressable>
  );

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
        <Text style={styles.screenTitle}>Select Manager</Text>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={loadUsers}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={item => item.user_id}
          renderItem={renderUserRow}
          contentContainerStyle={
            users.length === 0 ? styles.emptyList : styles.list
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                No staff are authorized to approve refunds. A manager needs to
                set up a PIN in the dashboard first.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
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
  screenTitle: {
    flex: 1,
    textAlign: 'center',
    ...Typography.subheading,
    color: Colors.textPrimary,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.lg,
  },
  list: {
    padding: Spacing.md,
  },
  emptyList: {
    flexGrow: 1,
    padding: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  rowPressed: {
    opacity: 0.92,
    backgroundColor: Colors.surface,
  },
  userName: {
    flex: 1,
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: Spacing.md,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  errorText: {
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
