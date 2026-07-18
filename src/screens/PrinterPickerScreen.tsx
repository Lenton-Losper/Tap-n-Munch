import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {Colors, Spacing, Typography} from '../constants/theme';
import {TerminalPrinterConfig, savePrinterConfig} from '../lib/api';
import {
  PrinterInfo,
  connectToPrinter,
  describePrinterError,
  listPairedPrinters,
} from '../lib/printer';
import {getTerminalToken} from '../lib/storage';
import {isBuiltInPrinterAvailable} from '../lib/wiseSdk6Printer';

const BUILT_IN_PRINTER_NAME = "This device's built-in printer";

interface Props {
  onClose: () => void;
  onPaired: (config: TerminalPrinterConfig) => void;
}

export default function PrinterPickerScreen({onClose, onPaired}: Props) {
  const [loading, setLoading] = useState(true);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [builtInAvailable, setBuiltInAvailable] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const loadPrinters = useCallback(async () => {
    setLoading(true);
    setListError(null);
    const [result, builtIn] = await Promise.all([
      listPairedPrinters(),
      isBuiltInPrinterAvailable(),
    ]);
    setPrinters(result.printers);
    setBuiltInAvailable(builtIn);
    if (result.errorCode) {
      setListError(describePrinterError(result.errorCode, result.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPrinters();
  }, [loadPrinters]);

  const handleSelectPrinter = async (printer: PrinterInfo) => {
    setConnectingId(printer.id);
    setConnectError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setConnectError('Session expired. Please re-activate this terminal.');
        return;
      }

      const connectResult = await connectToPrinter(printer.id);
      if (!connectResult.success) {
        setConnectError(
          describePrinterError(connectResult.errorCode, connectResult.error),
        );
        return;
      }

      const config = await savePrinterConfig(
        {
          connectionType: 'BLUETOOTH',
          printerName: printer.name,
          printerAddress: printer.id,
          paperWidthMm: 80,
          characterWidth: 48,
        },
        token,
      );

      onPaired(config);
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Failed to save this printer',
      );
    } finally {
      setConnectingId(null);
    }
  };

  const handleSelectBuiltIn = async () => {
    setConnectingId('BUILTIN');
    setConnectError(null);
    try {
      const token = await getTerminalToken();
      if (!token) {
        setConnectError('Session expired. Please re-activate this terminal.');
        return;
      }

      // Nothing to pair -- it's the device itself, so there's no printerAddress.
      const config = await savePrinterConfig(
        {connectionType: 'BUILTIN', printerName: BUILT_IN_PRINTER_NAME},
        token,
      );

      onPaired(config);
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : 'Failed to save the built-in printer',
      );
    } finally {
      setConnectingId(null);
    }
  };

  const renderBuiltInRow = () => {
    const isConnecting = connectingId === 'BUILTIN';
    return (
      <Pressable
        style={({pressed}) => [
          styles.row,
          pressed && styles.rowPressed,
          isConnecting && styles.rowDisabled,
        ]}
        disabled={connectingId !== null}
        onPress={handleSelectBuiltIn}>
        <MaterialCommunityIcons name="printer-check-outline" size={24} color={Colors.primary} />
        <View style={styles.rowText}>
          <Text style={styles.printerName}>{BUILT_IN_PRINTER_NAME}</Text>
          <Text style={styles.printerAddress}>No pairing needed</Text>
        </View>
        {isConnecting ? (
          <ActivityIndicator color={Colors.primary} />
        ) : (
          <MaterialCommunityIcons name="chevron-right" size={22} color={Colors.textMuted} />
        )}
      </Pressable>
    );
  };

  const renderPrinterRow = ({item}: {item: PrinterInfo}) => {
    const isConnecting = connectingId === item.id;
    return (
      <Pressable
        style={({pressed}) => [
          styles.row,
          pressed && styles.rowPressed,
          isConnecting && styles.rowDisabled,
        ]}
        disabled={connectingId !== null}
        onPress={() => handleSelectPrinter(item)}>
        <MaterialCommunityIcons
          name="printer-outline"
          size={24}
          color={Colors.primary}
        />
        <View style={styles.rowText}>
          <Text style={styles.printerName}>{item.name}</Text>
          <Text style={styles.printerAddress}>{item.id}</Text>
        </View>
        {isConnecting ? (
          <ActivityIndicator color={Colors.primary} />
        ) : (
          <MaterialCommunityIcons
            name="chevron-right"
            size={22}
            color={Colors.textMuted}
          />
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.wrapper}>
      <View style={styles.topBar}>
        <Pressable style={styles.backButton} onPress={onClose}>
          <MaterialCommunityIcons
            name="arrow-left"
            size={26}
            color={Colors.primary}
          />
        </Pressable>
        <Text style={styles.screenTitle}>Select Printer</Text>
        <View style={styles.backButton} />
      </View>

      {connectError ? (
        <View style={styles.connectErrorBanner}>
          <MaterialCommunityIcons
            name="alert-circle-outline"
            size={20}
            color={Colors.red}
          />
          <Text style={styles.connectErrorText}>{connectError}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.hintText}>Looking for printers…</Text>
        </View>
      ) : listError ? (
        <>
          {builtInAvailable ? (
            <View style={styles.list}>
              {renderBuiltInRow()}
              <Text style={styles.sectionLabel}>Bluetooth</Text>
            </View>
          ) : null}
          <View style={styles.centered}>
            <MaterialCommunityIcons
              name="bluetooth-off"
              size={40}
              color={Colors.textMuted}
            />
            <Text style={styles.errorText}>{listError}</Text>
            <Pressable style={styles.retryButton} onPress={loadPrinters}>
              <Text style={styles.retryButtonText}>Try Again</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <FlatList
          data={printers}
          keyExtractor={item => item.id}
          renderItem={renderPrinterRow}
          contentContainerStyle={
            printers.length === 0 ? styles.emptyList : styles.list
          }
          ListHeaderComponent={
            builtInAvailable ? (
              <>
                {renderBuiltInRow()}
                <Text style={styles.sectionLabel}>Bluetooth</Text>
              </>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name="printer-search-outline"
                size={40}
                color={Colors.textMuted}
              />
              <Text style={styles.emptyText}>
                No paired printers found. Pair your printer in this device's
                Bluetooth settings first, then come back here.
              </Text>
              <Pressable style={styles.retryButton} onPress={loadPrinters}>
                <Text style={styles.retryButtonText}>Check Again</Text>
              </Pressable>
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
    paddingTop: Spacing.md,
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
    gap: Spacing.md,
  },
  hintText: {
    ...Typography.small,
    color: Colors.textMuted,
  },
  sectionLabel: {
    ...Typography.small,
    color: Colors.textMuted,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
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
  rowDisabled: {
    opacity: 0.6,
  },
  rowText: {
    flex: 1,
  },
  printerName: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  printerAddress: {
    ...Typography.tiny,
    color: Colors.textMuted,
    marginTop: 2,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  errorText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
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
  connectErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.redLight,
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.red,
  },
  connectErrorText: {
    ...Typography.small,
    color: Colors.red,
    flex: 1,
  },
});
