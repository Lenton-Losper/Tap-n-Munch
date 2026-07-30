import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {APP_VERSION, FLASHTAP_API_URL} from '../constants';
import {getPrinterConfig} from '../lib/api';
import {getPrinterStatus, runBluetoothPrintJob} from '../lib/printer';
import {
  describeReceiptPrintError,
  getLastPrintResult,
  getReceiptPrintingEnabled,
  LastPrintResult,
  recordLastPrintResult,
  setReceiptPrintingEnabled,
} from '../lib/receiptPrintSettings';
import {
  getRestaurantId,
  getTerminalId,
  getTerminalToken,
} from '../lib/storage';
import {buildSdk6TestPrintLines, buildTestPrintPayload} from '../lib/testPrintPayload';
import {
  getBuiltInPrinterStatus,
  printBuiltInJob,
  probeUsdkService,
  UsdkServiceProbe,
} from '../lib/wiseSdk6Printer';

const {RuntimeConfig} = NativeModules;

interface RuntimeInfo {
  environment?: string;
  supabaseProject?: string;
  worker?: string;
  serviceRoleKeyPrefix?: string;
  error?: string;
}

function formatLastPrint(result: LastPrintResult | null): {
  lastPrint: string;
  lastError: string;
} {
  if (!result || result.outcome === 'none') {
    return {lastPrint: 'None', lastError: 'None'};
  }
  if (result.outcome === 'success') {
    return {
      lastPrint: `Successful (${result.source})`,
      lastError: 'None',
    };
  }
  return {
    lastPrint: `Failed (${result.source})`,
    lastError: describeReceiptPrintError(result.errorCode),
  };
}

export default function DiagnosticsScreen({onClose}: {onClose: () => void}) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [tokenPresent, setTokenPresent] = useState(false);

  const [receiptPrintingOn, setReceiptPrintingOn] = useState(false);
  const [printerLabel, setPrinterLabel] = useState<string>('Not configured');
  const [lastPrint, setLastPrint] = useState('None');
  const [lastError, setLastError] = useState('None');
  const [testPrinting, setTestPrinting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [usdkProbe, setUsdkProbe] = useState<UsdkServiceProbe | null>(null);
  const [probing, setProbing] = useState(false);

  const runUsdkProbe = useCallback(async () => {
    setProbing(true);
    try {
      setUsdkProbe(await probeUsdkService());
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    runUsdkProbe();
  }, [runUsdkProbe]);

  const refreshPrintDiagnostics = useCallback(async () => {
    const [enabled, last, token] = await Promise.all([
      getReceiptPrintingEnabled(),
      getLastPrintResult(),
      getTerminalToken(),
    ]);
    setReceiptPrintingOn(enabled);
    const formatted = formatLastPrint(last);
    setLastPrint(formatted.lastPrint);
    setLastError(formatted.lastError);

    if (token) {
      try {
        const config = await getPrinterConfig(token);
        if (!config) {
          setPrinterLabel('Not configured');
        } else if (config.connection_type === 'BUILTIN') {
          setPrinterLabel(config.printer_name || 'Built-in P5');
        } else {
          setPrinterLabel(config.printer_name || 'Bluetooth printer');
        }
      } catch {
        setPrinterLabel('Unable to load');
      }
    } else {
      setPrinterLabel('Not configured');
    }
  }, []);

  useEffect(() => {
    Promise.all([
      getTerminalId(),
      getRestaurantId(),
      getTerminalToken(),
    ]).then(([tid, rid, token]) => {
      setTerminalId(tid);
      setRestaurantId(rid);
      setTokenPresent(!!token);
    });
    refreshPrintDiagnostics();
  }, [refreshPrintDiagnostics]);

  useEffect(() => {
    fetch(`${FLASHTAP_API_URL}/api/debug/runtime`)
      .then(r => r.json())
      .then(data => setRuntime(data))
      .catch(e => setRuntime({error: e.message}))
      .finally(() => setLoading(false));
  }, []);

  const handleTogglePrinting = async (value: boolean) => {
    setToggling(true);
    try {
      await setReceiptPrintingEnabled(value);
      setReceiptPrintingOn(value);
    } finally {
      setToggling(false);
    }
  };

  const handleDevTestPrint = async () => {
    setTestPrinting(true);
    try {
      const token = await getTerminalToken();
      if (!token) {
        await recordLastPrintResult({
          outcome: 'failed',
          source: 'test',
          errorMessage: 'Session expired',
        });
        await refreshPrintDiagnostics();
        return;
      }
      const config = await getPrinterConfig(token);
      if (!config) {
        await recordLastPrintResult({
          outcome: 'failed',
          source: 'test',
          errorCode: 'NO_PRINTER_CONFIGURED',
          errorMessage: describeReceiptPrintError('NO_PRINTER_CONFIGURED'),
        });
        await refreshPrintDiagnostics();
        return;
      }

      if (config.connection_type === 'BUILTIN') {
        const lines = buildSdk6TestPrintLines(
          config.printer_name ?? 'Built-in Printer',
        );
        const printResult = await printBuiltInJob(lines);
        void getBuiltInPrinterStatus();
        await recordLastPrintResult({
          outcome: printResult.success ? 'success' : 'failed',
          source: 'test',
          errorCode: printResult.errorCode,
          errorMessage: printResult.success
            ? undefined
            : describeReceiptPrintError(printResult.errorCode),
          printerLabel: config.printer_name || 'Built-in P5',
        });
      } else if (config.printer_address) {
        const payload = buildTestPrintPayload(
          config.printer_name ?? 'Receipt Printer',
        );
        const printResult = await runBluetoothPrintJob({
          printerAddress: config.printer_address,
          escposBase64: payload,
        });
        void getPrinterStatus();
        await recordLastPrintResult({
          outcome: printResult.success ? 'success' : 'failed',
          source: 'test',
          errorCode: printResult.errorCode,
          errorMessage: printResult.success
            ? undefined
            : describeReceiptPrintError(printResult.errorCode),
          printerLabel: config.printer_name || 'Bluetooth printer',
        });
      }
      await refreshPrintDiagnostics();
    } finally {
      setTestPrinting(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>FlashTap Diagnostics</Text>

      <Text style={styles.sectionTitle}>Developer</Text>
      <Text style={styles.subSectionTitle}>Receipt Printing</Text>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Enable Receipt Printing</Text>
        <Switch
          value={receiptPrintingOn}
          onValueChange={handleTogglePrinting}
          disabled={toggling}
        />
      </View>
      <Text style={styles.hint}>
        When on: auto-print after payment, Print on success, and Reprint on
        completed orders. When off: no staff print actions (default). Test Print
        below always works. Hidden from normal staff — open via 5 taps on the
        Settings version.
      </Text>

      <Text style={styles.label}>Printer</Text>
      <Text style={styles.value}>{printerLabel}</Text>

      <Text style={styles.label}>Last Print</Text>
      <Text style={styles.value}>{lastPrint}</Text>

      <Text style={styles.label}>Last Error</Text>
      <Text style={styles.value}>{lastError}</Text>

      <Pressable
        style={[styles.testBtn, testPrinting && styles.btnDisabled]}
        disabled={testPrinting}
        onPress={handleDevTestPrint}>
        {testPrinting ? (
          <ActivityIndicator color="#333" />
        ) : (
          <Text style={styles.testBtnTxt}>Test Print</Text>
        )}
      </Pressable>

      <Text style={styles.sectionTitle}>Printer service resolution</Text>
      <Text style={styles.hint}>
        WisePosSdk.initPosSdk needs EXACTLY ONE service to answer the USDK action.
        On 0 or 2+ it binds a null Intent and fails with 7101. This is that count.
      </Text>

      <View style={styles.probeBox}>
        <Text style={styles.probeLabel}>MATCHES</Text>
        <Text
          selectable
          style={[
            styles.probeCount,
            usdkProbe?.matchCount === 1 && styles.probeOk,
            usdkProbe != null && usdkProbe.matchCount !== 1 && styles.probeBad,
          ]}>
          {probing ? '…' : usdkProbe == null ? '—' : String(usdkProbe.matchCount)}
        </Text>
        <Text style={styles.probeVerdict}>
          {probing
            ? 'probing…'
            : usdkProbe == null
            ? ''
            : usdkProbe.matchCount === 1
            ? 'OK — resolution is fine, fault is elsewhere'
            : usdkProbe.matchCount === 0
            ? 'ZERO — nothing answers the action for this app'
            : usdkProbe.matchCount < 0
            ? 'probe unavailable on this build'
            : 'AMBIGUOUS — 2+ services, fixable in code'}
        </Text>
      </View>

      <Text style={styles.label}>Summary (read this out / screenshot it)</Text>
      <Text selectable style={styles.probeMono}>
        {usdkProbe?.summary ?? '—'}
      </Text>

      <Text style={styles.label}>Resolved components</Text>
      <Text selectable style={styles.probeMono}>
        {usdkProbe == null
          ? '—'
          : usdkProbe.components.length === 0
          ? 'none'
          : usdkProbe.components.join('\n')}
      </Text>

      {usdkProbe?.error ? (
        <>
          <Text style={styles.label}>Probe error</Text>
          <Text selectable style={styles.probeMono}>
            {usdkProbe.error}
          </Text>
        </>
      ) : null}

      <Pressable
        style={[styles.testBtn, probing && styles.btnDisabled]}
        disabled={probing}
        onPress={runUsdkProbe}>
        {probing ? (
          <ActivityIndicator color="#333" />
        ) : (
          <Text style={styles.testBtnTxt}>Re-run probe</Text>
        )}
      </Pressable>

      <Text style={styles.sectionTitle}>Device / session</Text>

      <Text style={styles.label}>App version</Text>
      <Text style={styles.value}>{APP_VERSION}</Text>

      <Text style={styles.label}>API Base URL (RuntimeConfig)</Text>
      <Text style={styles.value}>
        {RuntimeConfig?.API_BASE_URL || 'NOT SET'}
      </Text>

      <Text style={styles.label}>Token present</Text>
      <Text style={styles.value}>{tokenPresent ? 'yes' : 'no'}</Text>

      <Text style={styles.label}>Terminal ID (storage)</Text>
      <Text style={styles.value}>
        [{terminalId === null ? 'NULL' : terminalId}]
      </Text>

      <Text style={styles.label}>Restaurant ID (storage)</Text>
      <Text style={styles.value}>
        [{restaurantId === null ? 'NULL' : restaurantId}]
      </Text>

      <Text style={styles.sectionTitle}>Runtime config</Text>

      <Text style={styles.label}>ENV_NAME (RuntimeConfig)</Text>
      <Text style={styles.value}>{RuntimeConfig.ENV_NAME || 'NOT SET'}</Text>

      <Text style={styles.label}>API_BASE_URL (RuntimeConfig)</Text>
      <Text style={styles.value}>{RuntimeConfig.API_BASE_URL}</Text>

      <Text style={styles.label}>FLASHTAP_API_URL (runtime constant)</Text>
      <Text style={styles.value}>{FLASHTAP_API_URL}</Text>

      <Text style={styles.label}>
        Calling: {FLASHTAP_API_URL}/api/debug/runtime
      </Text>

      {loading && <ActivityIndicator style={styles.loader} />}

      {runtime && !loading && (
        <>
          <Text style={styles.label}>Server environment</Text>
          <Text style={styles.value}>
            {runtime.environment || runtime.error || 'unknown'}
          </Text>

          <Text style={styles.label}>Supabase project</Text>
          <Text style={styles.value}>{runtime.supabaseProject || 'unknown'}</Text>

          <Text style={styles.label}>Worker</Text>
          <Text style={styles.value}>{runtime.worker || 'unknown'}</Text>
        </>
      )}

      <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
        <Text style={styles.closeTxt}>Close</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 24, backgroundColor: '#fff'},
  title: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 24,
    color: '#1a1a1a',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#333',
    marginTop: 8,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  subSectionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
    marginTop: 8,
    marginBottom: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  toggleLabel: {
    fontSize: 16,
    color: '#1a1a1a',
    flex: 1,
    marginRight: 12,
  },
  hint: {
    fontSize: 12,
    color: '#888',
    marginTop: 8,
    lineHeight: 16,
  },
  label: {
    fontSize: 11,
    color: '#888',
    marginTop: 16,
    textTransform: 'uppercase',
  },
  value: {
    fontSize: 14,
    color: '#1a1a1a',
    fontFamily: 'monospace',
    marginTop: 4,
  },
  testBtn: {
    marginTop: 16,
    padding: 14,
    backgroundColor: '#e8f0fe',
    borderRadius: 8,
    alignItems: 'center',
  },
  testBtnTxt: {fontSize: 15, fontWeight: '600', color: '#1a73e8'},
  btnDisabled: {opacity: 0.6},
  loader: {marginTop: 16},
  closeBtn: {
    marginTop: 32,
    marginBottom: 40,
    padding: 16,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    alignItems: 'center',
  },
  closeTxt: {fontSize: 16, color: '#333'},
  probeBox: {
    marginTop: 12,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
    alignItems: 'center',
  },
  probeLabel: {fontSize: 12, letterSpacing: 1, color: '#666'},
  probeCount: {fontSize: 56, fontWeight: '700', color: '#333', lineHeight: 64},
  probeOk: {color: '#1e8e3e'},
  probeBad: {color: '#d93025'},
  probeVerdict: {
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
    marginTop: 4,
  },
  probeMono: {
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 12,
    color: '#333',
    marginTop: 2,
  },
});
