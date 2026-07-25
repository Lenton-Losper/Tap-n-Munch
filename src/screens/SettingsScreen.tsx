import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {useAuth} from '../context/AuthContext';
import {useStreamConnection} from '../context/StreamContext';
import {APP_VERSION} from '../constants';
import {Colors, Spacing, Typography} from '../constants/theme';
import {
  TerminalPrinterConfig,
  deletePrinterConfig,
  getPrinterConfig,
} from '../lib/api';
import {
  describePrinterError,
  getPrinterStatus,
  runBluetoothPrintJob,
  PrinterStatus,
} from '../lib/printer';
import {clearAllData, getRestaurantName, getTerminalId, getTerminalToken} from '../lib/storage';
import {buildTestPrintPayload, buildSdk6TestPrintLines} from '../lib/testPrintPayload';
import {
  getReceiptPrintingEnabled,
  recordLastPrintResult,
  setReceiptPrintingEnabled,
} from '../lib/receiptPrintSettings';
import {
  describeWiseSdk6PrinterError,
  getBuiltInPrinterStatus,
  printBuiltInJob,
  WiseSdk6Status,
} from '../lib/wiseSdk6Printer';
import DiagnosticsScreen from './DiagnosticsScreen';
import PrinterPickerScreen from './PrinterPickerScreen';

export default function SettingsScreen() {
  const {signOut} = useAuth();
  const {connectionStatus} = useStreamConnection();
  const [restaurantName, setRestaurantName] = useState('—');
  const [terminalId, setTerminalId] = useState('—');
  const [deactivating, setDeactivating] = useState(false);
  const [, setTapCount] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const tapResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [printerConfig, setPrinterConfig] = useState<TerminalPrinterConfig | null>(null);
  const [printerConfigLoading, setPrinterConfigLoading] = useState(true);
  const [printerConnectionStatus, setPrinterConnectionStatus] = useState<PrinterStatus>({
    connected: false,
    id: null,
  });
  const [builtInStatus, setBuiltInStatus] = useState<WiseSdk6Status>({
    connected: false,
    hasPaper: true,
    statusUnknown: true,
  });
  const [showPrinterPicker, setShowPrinterPicker] = useState(false);
  const [testPrinting, setTestPrinting] = useState(false);
  const [testPrintResult, setTestPrintResult] = useState<
    {success: boolean; message: string} | null
  >(null);
  const [forgettingPrinter, setForgettingPrinter] = useState(false);
  const [receiptPrintingEnabled, setReceiptPrintingEnabledState] = useState(false);
  const [togglingPrint, setTogglingPrint] = useState(false);

  useEffect(() => {
    return () => {
      if (tapResetRef.current) {
        clearTimeout(tapResetRef.current);
      }
    };
  }, []);

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

  const loadPrinterConfig = useCallback(async () => {
    setPrinterConfigLoading(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        return;
      }
      const [config, printingOn] = await Promise.all([
        getPrinterConfig(token),
        getReceiptPrintingEnabled(),
      ]);
      setPrinterConfig(config);
      setReceiptPrintingEnabledState(printingOn);
      if (config?.connection_type === 'BUILTIN') {
        setBuiltInStatus(await getBuiltInPrinterStatus());
      } else if (config) {
        setPrinterConnectionStatus(await getPrinterStatus());
      }
    } catch {
      // Leave as "not set up" -- staff can retry via Select/Change Printer.
    } finally {
      setPrinterConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrinterConfig();
  }, [loadPrinterConfig]);

  const handlePrinterPaired = (config: TerminalPrinterConfig) => {
    setPrinterConfig(config);
    setTestPrintResult(null);
    setShowPrinterPicker(false);
    if (config.connection_type === 'BUILTIN') {
      getBuiltInPrinterStatus().then(setBuiltInStatus);
    } else {
      setPrinterConnectionStatus({connected: true, id: config.printer_address});
    }
  };

  const handleTestPrint = async () => {
    if (!printerConfig || testPrinting) {
      return;
    }
    setTestPrinting(true);
    setTestPrintResult(null);
    try {
      if (printerConfig.connection_type === 'BUILTIN') {
        // Same native path as real receipts: printBuiltInJob → WiseSdk6PrinterModule.printJob.
        const lines = buildSdk6TestPrintLines(
          printerConfig.printer_name ?? 'Built-in Printer',
        );
        const printResult = await printBuiltInJob(lines);
        // Never block the spinner on status — getStatus can hang on a stuck SDK call.
        void getBuiltInPrinterStatus().then(setBuiltInStatus);
        await recordLastPrintResult({
          outcome: printResult.success ? 'success' : 'failed',
          source: 'test',
          errorCode: printResult.errorCode,
          errorMessage: printResult.success
            ? undefined
            : describeWiseSdk6PrinterError(
                printResult.errorCode,
                printResult.error,
              ),
          printerLabel: printerConfig.printer_name ?? 'Built-in printer',
        });
        if (printResult.success) {
          setTestPrintResult({
            success: true,
            message: 'Test print sent successfully.',
          });
        } else {
          // Prefer the native detail for 7101 — it includes the on-device service probe.
          const message =
            printResult.error &&
            (printResult.errorCode === 'SDK_INIT_FAILED' ||
              printResult.error.includes('matches=') ||
              printResult.error.includes('USDK') ||
              printResult.error.includes('7101'))
              ? printResult.error
              : (() => {
                  const friendly = describeWiseSdk6PrinterError(
                    printResult.errorCode,
                    printResult.error,
                  );
                  const detail =
                    printResult.error && printResult.error !== friendly
                      ? ` (${printResult.error})`
                      : printResult.errorCode
                        ? ` [${printResult.errorCode}]`
                        : '';
                  return `${friendly}${detail}`;
                })();
          setTestPrintResult({
            success: false,
            message,
          });
        }
        return;
      }

      if (!printerConfig.printer_address) {
        setTestPrintResult({
          success: false,
          message: 'No printer address configured',
        });
        return;
      }

      const payload = buildTestPrintPayload(
        printerConfig.printer_name ?? 'Receipt Printer',
      );
      const printResult = await runBluetoothPrintJob({
        printerAddress: printerConfig.printer_address,
        escposBase64: payload,
      });
      void getPrinterStatus().then(setPrinterConnectionStatus);
      await recordLastPrintResult({
        outcome: printResult.success ? 'success' : 'failed',
        source: 'test',
        errorCode: printResult.errorCode,
        errorMessage: printResult.error,
        printerLabel: printerConfig.printer_name ?? 'Bluetooth printer',
      });
      if (printResult.success) {
        setTestPrintResult({
          success: true,
          message: 'Test print sent successfully.',
        });
      } else {
        setTestPrintResult({
          success: false,
          message: describePrinterError(
            printResult.errorCode,
            printResult.error,
          ),
        });
      }
    } catch (err) {
      setTestPrintResult({
        success: false,
        message: err instanceof Error ? err.message : 'Test print failed',
      });
    } finally {
      setTestPrinting(false);
    }
  };

  const handleToggleReceiptPrinting = async (value: boolean) => {
    setTogglingPrint(true);
    try {
      await setReceiptPrintingEnabled(value);
      setReceiptPrintingEnabledState(value);
    } finally {
      setTogglingPrint(false);
    }
  };

  const builtInStatusLabel = (() => {
    if (builtInStatus.statusUnknown || !builtInStatus.connected) {
      return 'Status unknown — try Test Print';
    }
    if (!builtInStatus.hasPaper) {
      return 'Out of paper';
    }
    return 'Ready';
  })();

  const builtInStatusColor = (() => {
    if (builtInStatus.statusUnknown || !builtInStatus.connected) {
      return Colors.textMuted;
    }
    return builtInStatus.hasPaper ? Colors.green : Colors.red;
  })();

  const handleForgetPrinter = () => {
    Alert.alert(
      'Forget This Printer',
      `Remove ${printerConfig?.printer_name || 'this printer'} from this terminal? You'll need to select it again before you can print receipts.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => {
            setForgettingPrinter(true);
            try {
              const token = await getTerminalToken();
              if (token) {
                await deletePrinterConfig(token);
              }
              setPrinterConfig(null);
              setPrinterConnectionStatus({connected: false, id: null});
              setBuiltInStatus({
                connected: false,
                hasPaper: true,
                statusUnknown: true,
              });
              setTestPrintResult(null);
            } catch (err) {
              Alert.alert(
                'Error',
                err instanceof Error ? err.message : 'Failed to forget this printer',
              );
            } finally {
              setForgettingPrinter(false);
            }
          },
        },
      ],
    );
  };

  const handleVersionPress = () => {
    if (tapResetRef.current) {
      clearTimeout(tapResetRef.current);
      tapResetRef.current = null;
    }

    setTapCount(prev => {
      const next = prev + 1;
      if (next >= 5) {
        setShowDiagnostics(true);
        return 0;
      }

      tapResetRef.current = setTimeout(() => {
        setTapCount(0);
        tapResetRef.current = null;
      }, 2000);

      return next;
    });
  };

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
    <>
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
            <Pressable onPress={handleVersionPress}>
              <Text style={styles.rowValue}>{APP_VERSION}</Text>
            </Pressable>
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
          <Text style={styles.sectionTitle}>Receipt Printer</Text>

          {printerConfigLoading ? (
            <ActivityIndicator color={Colors.primary} />
          ) : printerConfig ? (
            <>
              <View style={styles.printerStatusRow}>
                <MaterialCommunityIcons
                  name="printer"
                  size={28}
                  color={Colors.primary}
                />
                <View style={styles.printerStatusText}>
                  <Text style={styles.printerNameText}>
                    {printerConfig.printer_name || 'Receipt Printer'}
                  </Text>
                  <View style={styles.statusRow}>
                    {printerConfig.connection_type === 'BUILTIN' ? (
                      <>
                        <View
                          style={[
                            styles.statusDot,
                            {backgroundColor: builtInStatusColor},
                          ]}
                        />
                        <Text
                          style={[
                            styles.hintText,
                            !builtInStatus.hasPaper &&
                            !builtInStatus.statusUnknown &&
                            builtInStatus.connected
                              ? styles.hintTextError
                              : null,
                          ]}>
                          {builtInStatusLabel}
                        </Text>
                      </>
                    ) : (
                      <>
                        <View
                          style={[
                            styles.statusDot,
                            {
                              backgroundColor: printerConnectionStatus.connected
                                ? Colors.green
                                : Colors.textMuted,
                            },
                          ]}
                        />
                        <Text style={styles.hintText}>
                          {printerConnectionStatus.connected
                            ? 'Connected'
                            : 'Ready — connects automatically when printing'}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
              </View>

              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.toggleLabel}>Enable receipt printing</Text>
                  <Text style={styles.toggleHint}>
                    Turns on auto-print after payment, Print on success, and
                    Reprint on completed orders.
                  </Text>
                </View>
                <Switch
                  value={receiptPrintingEnabled}
                  onValueChange={handleToggleReceiptPrinting}
                  disabled={togglingPrint}
                />
              </View>

              {testPrintResult ? (
                <View
                  style={[
                    styles.testPrintBanner,
                    testPrintResult.success
                      ? styles.testPrintSuccess
                      : styles.testPrintFailure,
                  ]}>
                  <MaterialCommunityIcons
                    name={
                      testPrintResult.success
                        ? 'check-circle-outline'
                        : 'alert-circle-outline'
                    }
                    size={18}
                    color={testPrintResult.success ? Colors.green : Colors.red}
                  />
                  <Text
                    style={[
                      styles.testPrintText,
                      {color: testPrintResult.success ? Colors.green : Colors.red},
                    ]}>
                    {testPrintResult.message}
                  </Text>
                </View>
              ) : null}

              <View style={styles.printerActions}>
                <Pressable
                  style={[
                    styles.printerActionButton,
                    testPrinting && styles.buttonDisabled,
                  ]}
                  disabled={testPrinting}
                  onPress={handleTestPrint}>
                  {testPrinting ? (
                    <ActivityIndicator color={Colors.primary} size="small" />
                  ) : (
                    <Text style={styles.printerActionText}>Test Print</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.printerActionButton}
                  onPress={() => setShowPrinterPicker(true)}>
                  <Text style={styles.printerActionText}>Change Printer</Text>
                </Pressable>
              </View>

              <Pressable
                disabled={forgettingPrinter}
                onPress={handleForgetPrinter}
                style={styles.deactivateRow}>
                {forgettingPrinter ? (
                  <ActivityIndicator color={Colors.red} />
                ) : (
                  <Text style={styles.deactivateText}>Forget This Printer</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <View style={styles.printerStatusRow}>
                <MaterialCommunityIcons
                  name="printer-off-outline"
                  size={28}
                  color={Colors.textMuted}
                />
                <Text style={styles.hintText}>No printer set up yet</Text>
              </View>
              <Pressable
                style={styles.primaryPrinterButton}
                onPress={() => setShowPrinterPicker(true)}>
                <Text style={styles.primaryPrinterButtonText}>Select Printer</Text>
              </Pressable>
            </>
          )}
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

      <Modal
        visible={showDiagnostics}
        animationType="slide"
        onRequestClose={() => setShowDiagnostics(false)}>
        <DiagnosticsScreen onClose={() => setShowDiagnostics(false)} />
      </Modal>

      <Modal
        visible={showPrinterPicker}
        animationType="slide"
        onRequestClose={() => setShowPrinterPicker(false)}>
        <PrinterPickerScreen
          onClose={() => setShowPrinterPicker(false)}
          onPaired={handlePrinterPaired}
        />
      </Modal>
    </>
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
  hintTextError: {
    color: Colors.red,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.md,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  toggleCopy: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  toggleHint: {
    ...Typography.tiny,
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
  buttonDisabled: {
    opacity: 0.6,
  },
  printerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  printerStatusText: {
    flex: 1,
    gap: 4,
  },
  printerNameText: {
    ...Typography.body,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  printerActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  printerActionButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  printerActionText: {
    ...Typography.small,
    fontWeight: '600',
    color: Colors.textPrimary,
  },
  primaryPrinterButton: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryPrinterButtonText: {
    ...Typography.small,
    fontWeight: '600',
    color: Colors.white,
  },
  testPrintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: 10,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  testPrintSuccess: {
    backgroundColor: Colors.greenLight,
  },
  testPrintFailure: {
    backgroundColor: Colors.redLight,
  },
  testPrintText: {
    ...Typography.small,
    flex: 1,
  },
});
