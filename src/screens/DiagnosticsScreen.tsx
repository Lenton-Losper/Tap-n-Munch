import React, {useCallback, useEffect, useRef, useState} from 'react';
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
import {APP_VERSION, ENV_NAME, FLASHTAP_API_URL} from '../constants';
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
import {paperTypeFromWidthMm} from '../lib/paperWidth';
import {
  clearWiseCashierWiretap,
  readWiseCashierWiretap,
  WiretapEntry,
} from '../lib/payment';
import {
  getRestaurantId,
  getTerminalId,
  getTerminalToken,
} from '../lib/storage';
import {buildSdk6TestPrintLines, buildTestPrintPayload} from '../lib/testPrintPayload';
import {resolutionHint, resolutionVerdict} from '../lib/printerResolutionCopy';
import {
  getBuiltInPrinterStatus,
  printBuiltInJob,
  probeUsdkAidlService,
  enumeratePrinterRelatedServices,
  testRealInitPosSdk,
  UsdkAidlProbeResult,
  PrinterServiceEnumResult,
  RealInitPosSdkResult,
  probeUsdkService,
  UsdkServiceProbe,
  ACTIVE_PRINTER_TRANSPORT,
  getLastPrintSteps,
  PrintStepReport,
} from '../lib/wiseSdk6Printer';
import {
  listSystemPrintServices,
  printSystemTestReceipt,
  PrintServicesProbeResult,
  SystemPrintTestResult,
} from '../lib/printFramework';

const {RuntimeConfig} = NativeModules;

interface RuntimeInfo {
  environment?: string;
  supabaseProject?: string;
  worker?: string;
  serviceRoleKeyPrefix?: string;
  error?: string;
}

/** Local wall-clock, seconds precision — enough to line an entry up with a device test. */
function formatWiretapTime(at?: number): string {
  if (!at) {
    return 'unknown time';
  }
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const [printSteps, setPrintSteps] = useState<PrintStepReport | null>(null);
  const [lastPrint, setLastPrint] = useState('None');
  const [lastError, setLastError] = useState('None');
  const [testPrinting, setTestPrinting] = useState(false);
  /** Synchronous mirror of `testPrinting` — see handleDevTestPrint (#101). */
  const testPrintingRef = useRef(false);
  const [toggling, setToggling] = useState(false);
  const [aidlProbing, setAidlProbing] = useState(false);
  const [aidlProbe, setAidlProbe] = useState<UsdkAidlProbeResult | null>(null);
  const [aidlProbeError, setAidlProbeError] = useState<string | null>(null);
  const [enumRunning, setEnumRunning] = useState(false);
  const [enumResult, setEnumResult] = useState<PrinterServiceEnumResult | null>(
    null,
  );
  const [enumError, setEnumError] = useState<string | null>(null);
  const [realInitRunning, setRealInitRunning] = useState(false);
  const [realInitResult, setRealInitResult] =
    useState<RealInitPosSdkResult | null>(null);
  const [realInitError, setRealInitError] = useState<string | null>(null);
  const [printFwRunning, setPrintFwRunning] = useState(false);
  const [printFwResult, setPrintFwResult] =
    useState<PrintServicesProbeResult | null>(null);
  const [printFwError, setPrintFwError] = useState<string | null>(null);
  const [systemPrintRunning, setSystemPrintRunning] = useState(false);
  /** Synchronous mirror of `systemPrintRunning` — see handleSystemPrintTest (#101). */
  const systemPrintRunningRef = useRef(false);
  const [systemPrintResult, setSystemPrintResult] =
    useState<SystemPrintTestResult | null>(null);
  const [systemPrintError, setSystemPrintError] = useState<string | null>(null);
  const isStaging = ENV_NAME === 'staging';

  const [usdkProbe, setUsdkProbe] = useState<UsdkServiceProbe | null>(null);
  const [probing, setProbing] = useState(false);

  /**
   * INSTRUMENTATION (vc82). What WiseCashier actually hands back, recorded natively before
   * FlashTap classifies it. No ADB on these terminals, so this screen is the only readout.
   */
  const [wiretap, setWiretap] = useState<WiretapEntry[] | null>(null);
  const [wiretapError, setWiretapError] = useState<string | null>(null);

  const refreshWiretap = useCallback(async () => {
    try {
      setWiretap(await readWiseCashierWiretap());
      setWiretapError(null);
    } catch (err) {
      setWiretap(null);
      setWiretapError(err instanceof Error ? err.message : 'Wiretap read failed');
    }
  }, []);

  const handleClearWiretap = useCallback(async () => {
    try {
      await clearWiseCashierWiretap();
    } finally {
      await refreshWiretap();
    }
  }, [refreshWiretap]);

  useEffect(() => {
    refreshWiretap();
  }, [refreshWiretap]);

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
    // Per-step results of the last job. ADB is not reachable on these terminals, so this is
    // the only place a failing step is visible at the venue.
    setPrintSteps(await getLastPrintSteps());
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
    // #101: this had no re-entry guard at all — only `disabled={testPrinting}`, which is a
    // render behind, so a double-tap ran the handler twice and printed twice.
    if (testPrintingRef.current) {
      return;
    }
    testPrintingRef.current = true;
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
        const printResult = await printBuiltInJob(lines, {
          paperType: paperTypeFromWidthMm(config.paper_width_mm),
        });
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
      testPrintingRef.current = false;
      setTestPrinting(false);
    }
  };

  const handleAidlProbe = async () => {
    setAidlProbing(true);
    setAidlProbeError(null);
    try {
      const result = await probeUsdkAidlService();
      setAidlProbe(result);
    } catch (err) {
      setAidlProbe(null);
      setAidlProbeError(
        err instanceof Error ? err.message : 'AIDL probe failed',
      );
    } finally {
      setAidlProbing(false);
    }
  };

  const handleEnumerateServices = async () => {
    setEnumRunning(true);
    setEnumError(null);
    try {
      const result = await enumeratePrinterRelatedServices();
      setEnumResult(result);
    } catch (err) {
      setEnumResult(null);
      setEnumError(
        err instanceof Error ? err.message : 'Service enumeration failed',
      );
    } finally {
      setEnumRunning(false);
    }
  };

  const handleRealInitPosSdk = async () => {
    setRealInitRunning(true);
    setRealInitError(null);
    try {
      const result = await testRealInitPosSdk();
      setRealInitResult(result);
    } catch (err) {
      setRealInitResult(null);
      setRealInitError(
        err instanceof Error ? err.message : 'Real initPosSdk test failed',
      );
    } finally {
      setRealInitRunning(false);
    }
  };

  const handleListPrintServices = async () => {
    setPrintFwRunning(true);
    setPrintFwError(null);
    try {
      const result = await listSystemPrintServices();
      setPrintFwResult(result);
    } catch (err) {
      setPrintFwResult(null);
      setPrintFwError(
        err instanceof Error ? err.message : 'listPrintServices failed',
      );
    } finally {
      setPrintFwRunning(false);
    }
  };

  const handleSystemPrintTest = async () => {
    // #101: `disabled={systemPrintRunning}` is a render behind, so two taps in the same frame
    // both reached printSystemTestReceipt and the framework printed twice. The ref flips
    // synchronously. Same pattern as handleDevTestPrint and Reprint Receipt.
    if (systemPrintRunningRef.current) {
      return;
    }
    systemPrintRunningRef.current = true;
    setSystemPrintRunning(true);
    setSystemPrintError(null);
    try {
      const result = await printSystemTestReceipt();
      setSystemPrintResult(result);
    } catch (err) {
      setSystemPrintResult(null);
      setSystemPrintError(
        err instanceof Error ? err.message : 'System print test failed',
      );
    } finally {
      systemPrintRunningRef.current = false;
      setSystemPrintRunning(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>FlashTap Diagnostics</Text>

      <Text style={styles.sectionTitle}>Developer</Text>

      {/* INSTRUMENTATION (vc82). Verbatim WiseCashier returns, newest first, recorded before
          any FlashTap classification. Survives leaving the payment screen and restarting the
          app; reading it does not consume it. */}
      <Text style={styles.subSectionTitle}>WiseCashier wiretap</Text>
      <Text style={styles.hint}>
        Every return from WiseCashier exactly as Android delivered it — result code, its
        symbolic name, the intent action, and every extra. Newest first. Launch markers are
        recorded too, so an empty log means WiseCashier was never started.
      </Text>

      <View style={styles.wiretapBtnRow}>
        <Pressable style={styles.testBtn} onPress={refreshWiretap}>
          <Text style={styles.testBtnTxt}>Refresh wiretap</Text>
        </Pressable>
        <Pressable style={styles.testBtn} onPress={handleClearWiretap}>
          <Text style={styles.testBtnTxt}>Clear wiretap</Text>
        </Pressable>
      </View>

      {wiretapError ? (
        <Text style={[styles.value, styles.stepFailed]} selectable>
          Wiretap unavailable: {wiretapError}
        </Text>
      ) : null}

      {wiretap && wiretap.length === 0 ? (
        <Text style={styles.value}>
          No entries. Nothing has called launchPayment on this install since the log was last
          cleared.
        </Text>
      ) : null}

      {(wiretap ?? []).map((entry, i) => (
        <View key={`wiretap-${entry.at ?? i}-${i}`} style={styles.wiretapEntry}>
          <Text style={styles.wiretapHeader} selectable>
            {formatWiretapTime(entry.at)} — {entry.event ?? 'unknown event'}
          </Text>
          {entry.event === 'onActivityResult' ? (
            <>
              <Text style={styles.value} selectable>
                resultCode = {String(entry.resultCode)} ({entry.resultCodeName})
              </Text>
              <Text style={styles.value} selectable>
                requestCode = {String(entry.requestCode)} ({entry.requestCodeName})
              </Text>
              <Text style={styles.value} selectable>
                action = {entry.action ? entry.action : '(none)'}
              </Text>
              <Text style={styles.value} selectable>
                data = {entry.dataNull ? 'NULL' : 'present'}; extras ={' '}
                {entry.extrasNull ? 'NULL' : String(entry.extrasCount ?? 0)}; promise ={' '}
                {entry.promiseAlive ? 'alive' : 'GONE'}
              </Text>
              {entry.component ? (
                <Text style={styles.value} selectable>
                  component = {entry.component}
                </Text>
              ) : null}
              {(entry.extras ?? []).map((x, xi) => (
                <Text key={`x-${xi}`} style={styles.wiretapExtra} selectable>
                  • {x.key} ({x.type}) = {x.value}
                </Text>
              ))}
              {entry.pendingMerchantOrderNo ? (
                <Text style={styles.value} selectable>
                  pending merchantOrderNo = {entry.pendingMerchantOrderNo}
                </Text>
              ) : null}
            </>
          ) : (
            <>
              {entry.code ? (
                <Text style={[styles.value, styles.stepFailed]} selectable>
                  rejected: {entry.code}
                </Text>
              ) : null}
              {entry.error ? (
                <Text style={[styles.value, styles.stepFailed]} selectable>
                  error: {entry.error}
                </Text>
              ) : null}
              {entry.merchantOrderNo ? (
                <Text style={styles.value} selectable>
                  merchantOrderNo = {entry.merchantOrderNo}
                </Text>
              ) : null}
              {entry.amountMinor ? (
                <Text style={styles.value} selectable>
                  amount = {entry.amountMinor}
                </Text>
              ) : null}
            </>
          )}
        </View>
      ))}

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

      {/* Per-step results of the last print job (SDK4 transport only). ADB is not reachable
          on these terminals and TMS is the only deploy path, so logcat is not a diagnostic
          channel in practice — this is. Read it out or screenshot it. */}
      {printSteps && printSteps.count > 0 ? (
        <>
          <Text style={styles.label}>
            Last print steps ({printSteps.count}) — outcome: {printSteps.outcome}
          </Text>
          {printSteps.steps.map((s, i) => (
            <Text
              key={`${s.step}-${i}`}
              style={[styles.value, !s.ok && styles.stepFailed]}
              selectable>
              {s.ok ? '✓' : '✗'} {s.step}
              {s.code !== null ? ` (code ${s.code})` : ''}
              {s.detail ? ` — ${s.detail}` : ''}
            </Text>
          ))}
        </>
      ) : null}

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

      {isStaging ? (
        <>
          <Text style={styles.sectionTitle}>
            Staging — Android PrintManager (BIPS)
          </Text>
          <Text style={styles.hint}>
            Uses android.print.PrintManager — NOT WiseSdk AIDL. Lists print
            services Android itself reports (including BIPS /
            com.android.bips if enabled), then can open the system print UI
            with a test receipt PDF. Silent print is not available through
            this framework.
          </Text>
          <Pressable
            style={[styles.testBtn, printFwRunning && styles.btnDisabled]}
            disabled={printFwRunning}
            onPress={handleListPrintServices}>
            {printFwRunning ? (
              <ActivityIndicator color="#333" />
            ) : (
              <Text style={styles.testBtnTxt}>
                List PrintManager print services
              </Text>
            )}
          </Pressable>
          {printFwError ? (
            <Text style={styles.probeError}>{printFwError}</Text>
          ) : null}
          {printFwResult ? (
            <View style={styles.probeBox}>
              <Text style={styles.label}>Summary</Text>
              <Text style={styles.value}>{printFwResult.summary}</Text>
              <Text style={styles.label}>BIPS enabled?</Text>
              <Text style={styles.probeCount}>
                {printFwResult.bipsEnabled ? 'YES' : 'NO'}
              </Text>
              <Text style={styles.label}>BIPS in all services?</Text>
              <Text style={styles.value}>
                {printFwResult.bipsPresentInAll ? 'yes' : 'no'}
              </Text>
              <Text style={styles.label}>Silent print via framework?</Text>
              <Text style={styles.value}>
                {printFwResult.silentPrintSupportedByFramework}
              </Text>
              <Text style={styles.label}>
                Enabled services ({printFwResult.enabledCount})
              </Text>
              {printFwResult.enabledServices.length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                printFwResult.enabledServices.map((svc, i) => (
                  <Text
                    key={`en-${svc.packageName}-${svc.className}-${i}`}
                    style={styles.value}>
                    [{i + 1}] {svc.isBips ? 'BIPS ' : ''}
                    {svc.name || '(unnamed)'} — {svc.packageName}/
                    {svc.className} enabled={String(svc.isEnabled)}
                  </Text>
                ))
              )}
              <Text style={styles.label}>
                All services ({printFwResult.allCount})
              </Text>
              {printFwResult.allServices.length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                printFwResult.allServices.map((svc, i) => (
                  <Text
                    key={`all-${svc.packageName}-${svc.className}-${i}`}
                    style={styles.value}>
                    [{i + 1}] {svc.isBips ? 'BIPS ' : ''}
                    {svc.name || '(unnamed)'} — {svc.packageName}/
                    {svc.className} enabled={String(svc.isEnabled)}
                  </Text>
                ))
              )}
            </View>
          ) : null}

          <Pressable
            style={[styles.testBtn, systemPrintRunning && styles.btnDisabled]}
            disabled={systemPrintRunning}
            onPress={handleSystemPrintTest}>
            {systemPrintRunning ? (
              <ActivityIndicator color="#333" />
            ) : (
              <Text style={styles.testBtnTxt}>
                PrintManager test receipt (system UI)
              </Text>
            )}
          </Pressable>
          {systemPrintError ? (
            <Text style={styles.probeError}>{systemPrintError}</Text>
          ) : null}
          {systemPrintResult ? (
            <View style={styles.probeBox}>
              <Text style={styles.label}>Outcome</Text>
              <Text style={styles.probeCount}>{systemPrintResult.outcome}</Text>
              <Text style={styles.label}>Job</Text>
              <Text style={styles.value}>
                {systemPrintResult.jobName} ({systemPrintResult.jobId}) state=
                {systemPrintResult.jobState}
              </Text>
              <Text style={styles.label}>System print UI required</Text>
              <Text style={styles.value}>
                {systemPrintResult.systemPrintUiRequired ? 'yes' : 'no'}
              </Text>
              <Text style={styles.label}>Note</Text>
              <Text style={styles.value}>{systemPrintResult.note}</Text>
              <Text style={styles.label}>Started</Text>
              <Text style={styles.value}>{systemPrintResult.timestamp}</Text>
              <Text style={styles.hint}>
                Confirm physical output with a photo of the paper (same as
                SDKDemo). If nothing prints from the P5 head, this path does
                not reach the thermal printer.
              </Text>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Staging — WisePos SDK</Text>
          <Text style={styles.subSectionTitle}>Real SDK initPosSdk() test</Text>
          <Text style={styles.hint}>
            Calls the actual WisePosSdk.getInstance().initPosSdk(Activity,
            listener) — same entry point as SDKDemo MainActivity. On success
            also runs getPrinter().getPrinterStatus(). Not our hand-written
            PackageManager probe.
          </Text>
          <Pressable
            style={[styles.testBtn, realInitRunning && styles.btnDisabled]}
            disabled={realInitRunning}
            onPress={handleRealInitPosSdk}>
            {realInitRunning ? (
              <ActivityIndicator color="#333" />
            ) : (
              <Text style={styles.testBtnTxt}>Real SDK initPosSdk() test</Text>
            )}
          </Pressable>
          {realInitError ? (
            <Text style={styles.probeError}>{realInitError}</Text>
          ) : null}
          {realInitResult ? (
            <View style={styles.probeBox}>
              <Text style={styles.label}>Outcome</Text>
              <Text style={styles.probeCount}>{realInitResult.outcome}</Text>
              <Text style={styles.label}>errorCode (exact int)</Text>
              <Text style={styles.value}>
                {realInitResult.errorCode != null
                  ? String(realInitResult.errorCode)
                  : '(n/a)'}
              </Text>
              <Text style={styles.label}>WisePosErrorCode name</Text>
              <Text style={styles.value}>
                {realInitResult.errorName || '(unknown)'}
              </Text>
              <Text style={styles.label}>Fail branch (bytecode)</Text>
              <Text style={styles.value}>
                {realInitResult.failBranch || '(n/a)'}
              </Text>
              <Text style={styles.label}>
                preInit matchCount (flags=0, same as SDK)
              </Text>
              <Text style={styles.value}>
                {realInitResult.preInitMatchCount != null
                  ? String(realInitResult.preInitMatchCount)
                  : '(n/a)'}
              </Text>
              <Text style={styles.label}>Summary</Text>
              <Text style={styles.value}>{realInitResult.summary}</Text>
              <Text style={styles.label}>Context</Text>
              <Text style={styles.value}>
                {realInitResult.contextClass || '?'}
              </Text>
              <Text style={styles.label}>getPrinterStatus()</Text>
              <Text style={styles.value}>
                {realInitResult.printerStatusOk
                  ? `OK: ${
                      realInitResult.printerStatusRaw ||
                      JSON.stringify(realInitResult.printerStatus)
                    }`
                  : realInitResult.printerStatusError || '(n/a)'}
              </Text>
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Staging — WisePos AIDL probe</Text>
          <Text style={styles.hint}>
            Runs PackageManager.queryIntentServices(Intent
            (&quot;com.wisepos.aidl.service&quot;), 0) — the same flags the SDK uses
            to bind. Zero matches = no system component on this firmware.
            Staging builds only.
          </Text>
          <Pressable
            style={[styles.testBtn, aidlProbing && styles.btnDisabled]}
            disabled={aidlProbing}
            onPress={handleAidlProbe}>
            {aidlProbing ? (
              <ActivityIndicator color="#333" />
            ) : (
              <Text style={styles.testBtnTxt}>Probe com.wisepos.aidl.service</Text>
            )}
          </Pressable>
          {aidlProbeError ? (
            <Text style={styles.probeError}>{aidlProbeError}</Text>
          ) : null}
          {aidlProbe ? (
            <View style={styles.probeBox}>
              <Text style={styles.label}>Action</Text>
              <Text style={styles.value}>{aidlProbe.action}</Text>
              <Text style={styles.label}>matchCount (flags=0)</Text>
              <Text style={styles.probeCount}>{aidlProbe.matchCount}</Text>
              <Text style={styles.label}>Verdict</Text>
              <Text style={styles.value}>
                {aidlProbe.matchCount === 0
                  ? 'ABSENT — nothing registered for this action'
                  : aidlProbe.matchCount === 1
                    ? 'PRESENT — exactly one component (SDK can bind)'
                    : `AMBIGUOUS — ${aidlProbe.matchCount} components (SDK wants exactly 1)`}
              </Text>
              <Text style={styles.label}>Model / SDK / targetSdk</Text>
              <Text style={styles.value}>
                {aidlProbe.model} / sdkInt={aidlProbe.sdkInt} / targetSdk=
                {aidlProbe.targetSdk}
              </Text>
              <Text style={styles.label}>QUERY_ALL_PACKAGES granted</Text>
              <Text style={styles.value}>
                {aidlProbe.queryAllPackagesGranted ? 'yes' : 'no'}
              </Text>
              <Text style={styles.label}>Package visibility applies (targetSdk≥30)</Text>
              <Text style={styles.value}>
                {aidlProbe.packageVisibilityApplies
                  ? 'yes — filters can hide services'
                  : 'no — targetSdk < 30, visibility filter not the cause of 0 matches'}
              </Text>
              <Text style={styles.label}>MATCH_ALL count (secondary)</Text>
              <Text style={styles.value}>{aidlProbe.matchAllCount}</Text>
              <Text style={styles.label}>Components</Text>
              {aidlProbe.services.length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                aidlProbe.services.map((svc, i) => (
                  <View key={`${svc.packageName}/${svc.serviceName}/${i}`}>
                    <Text style={styles.value}>
                      [{i + 1}] packageName: {svc.packageName}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}serviceName: {svc.serviceName}
                    </Text>
                  </View>
                ))
              )}
              <Text style={styles.label}>Raw summary</Text>
              <Text style={styles.value}>{aidlProbe.summary}</Text>
            </View>
          ) : null}

          <Text style={styles.subSectionTitle}>Enumerate related services</Text>
          <Text style={styles.hint}>
            Scans all installed packages for exported services whose name
            contains print / wisepos / wiseasy / usdk / pos. Uses
            QUERY_ALL_PACKAGES (already in the staging manifest). Staging only.
          </Text>
          <Pressable
            style={[styles.testBtn, enumRunning && styles.btnDisabled]}
            disabled={enumRunning}
            onPress={handleEnumerateServices}>
            {enumRunning ? (
              <ActivityIndicator color="#333" />
            ) : (
              <Text style={styles.testBtnTxt}>
                Enumerate ALL services (+ focus pkgs / perms)
              </Text>
            )}
          </Pressable>
          {enumError ? <Text style={styles.probeError}>{enumError}</Text> : null}
          {enumResult ? (
            <View style={styles.probeBox}>
              <Text style={styles.label}>Scanned</Text>
              <Text style={styles.value}>
                {enumResult.packagesScanned} packages /{' '}
                {enumResult.servicesScanned} services (all=
                {enumResult.allServiceCount ?? enumResult.servicesScanned})
              </Text>
              <Text style={styles.label}>QUERY_ALL_PACKAGES</Text>
              <Text style={styles.value}>
                {enumResult.queryAllPackagesGranted ? 'granted' : 'NOT granted'}
              </Text>
              <Text style={styles.label}>
                Signature-gated services (
                {enumResult.signatureGatedServiceCount ?? 0})
              </Text>
              {(enumResult.signatureGatedServices ?? []).length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                (enumResult.signatureGatedServices ?? []).map((svc, i) => (
                  <Text
                    key={`sig-${svc.packageName}/${svc.serviceName}/${i}`}
                    style={styles.value}>
                    [{i + 1}] {svc.packageName}/{svc.serviceName} perm=
                    {svc.permission || '(none)'} prot=
                    {svc.protectionLabel || '?'}
                  </Text>
                ))
              )}
              <Text style={styles.label}>Focus packages (Wiseasy system)</Text>
              {(enumResult.focusPackageStatus ?? []).map(st => (
                <Text key={`focus-st-${st.packageName}`} style={styles.value}>
                  {st.packageName}:{' '}
                  {st.installed
                    ? `installed, ${st.serviceCount} services`
                    : 'NOT installed'}
                </Text>
              ))}
              <Text style={styles.label}>
                Focus package services ({enumResult.focusServiceCount ?? 0})
              </Text>
              {(enumResult.focusPackageServices ?? []).length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                (enumResult.focusPackageServices ?? []).map((svc, i) => (
                  <View
                    key={`focus-${svc.packageName}/${svc.serviceName}/${i}`}>
                    <Text style={styles.value}>
                      [{i + 1}] {svc.packageName}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}
                      {svc.serviceName}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}exported={String(svc.exported)} enabled=
                      {String(svc.enabled)}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}perm={svc.permission || '(none)'} prot=
                      {svc.protectionLabel || '(n/a)'} sig=
                      {String(!!svc.signatureGated)}
                    </Text>
                  </View>
                ))
              )}
              <Text style={styles.label}>Related package names</Text>
              {enumResult.relatedPackageNames.length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                enumResult.relatedPackageNames.map(name => (
                  <Text key={name} style={styles.value}>
                    {name}
                  </Text>
                ))
              )}
              <Text style={styles.label}>
                Keyword-matching services ({enumResult.matchingServiceCount})
              </Text>
              {enumResult.matchingServices.length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                enumResult.matchingServices.map((svc, i) => (
                  <View key={`${svc.packageName}/${svc.serviceName}/${i}`}>
                    <Text style={styles.value}>
                      [{i + 1}] {svc.packageName}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}
                      {svc.serviceName}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}exported={String(svc.exported)} enabled=
                      {String(svc.enabled)}
                    </Text>
                    <Text style={styles.value}>
                      {'     '}perm={svc.permission || '(none)'} prot=
                      {svc.protectionLabel || '(n/a)'}
                    </Text>
                  </View>
                ))
              )}
              <Text style={styles.label}>
                ALL services ({enumResult.allServiceCount ?? 0})
              </Text>
              {(enumResult.allServices ?? []).length === 0 ? (
                <Text style={styles.value}>(none)</Text>
              ) : (
                (enumResult.allServices ?? []).map((svc, i) => (
                  <Text
                    key={`all-${svc.packageName}/${svc.serviceName}/${i}`}
                    style={styles.value}>
                    [{i + 1}] {svc.packageName}/{svc.serviceName} exp=
                    {String(svc.exported)} perm={svc.permission || '-'} prot=
                    {svc.protectionLabel || '-'}
                  </Text>
                ))
              )}
            </View>
          ) : null}
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Printer service resolution</Text>
      {/* #164: this section was SDK6-era and named initPosSdk / the USDK action on every
          build. The copy now follows ACTIVE_PRINTER_TRANSPORT, so it names the entry point
          and action actually in use on the device in the technician's hand. */}
      <Text style={styles.hint}>{resolutionHint(ACTIVE_PRINTER_TRANSPORT)}</Text>

      <View style={styles.usdkProbeBox}>
        <Text style={styles.probeLabel}>MATCHES</Text>
        <Text
          selectable
          style={[
            styles.usdkProbeCount,
            usdkProbe?.matchCount === 1 && styles.probeOk,
            usdkProbe != null && usdkProbe.matchCount !== 1 && styles.probeBad,
          ]}>
          {probing ? '…' : usdkProbe == null ? '—' : String(usdkProbe.matchCount)}
        </Text>
        <Text style={styles.probeVerdict}>
          {resolutionVerdict(ACTIVE_PRINTER_TRANSPORT, usdkProbe, probing)}
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

      {/* Stamped at build time (#149): an installed APK must be able to name its own
          source commit. "-dirty" means it was built from an uncommitted tree. */}
      <Text style={styles.label}>Build commit</Text>
      <Text style={styles.value} selectable>
        {(RuntimeConfig as {GIT_SHA?: string} | undefined)?.GIT_SHA || 'unknown'}
      </Text>

      <Text style={styles.label}>Printer transport</Text>
      <Text style={styles.value} selectable>
        {ACTIVE_PRINTER_TRANSPORT}
      </Text>

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
  stepFailed: {
    color: '#B00020',
    fontWeight: '600',
  },
  wiretapBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  wiretapEntry: {
    marginTop: 10,
    padding: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#666',
    backgroundColor: '#f2f2f2',
  },
  wiretapHeader: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  wiretapExtra: {
    fontSize: 13,
    color: '#1a1a1a',
    fontFamily: 'monospace',
    marginTop: 3,
    marginLeft: 8,
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
  probeBox: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  probeCount: {
    fontSize: 28,
    fontWeight: '800',
    color: '#1a1a1a',
    fontFamily: 'monospace',
    marginTop: 4,
  },
  probeError: {
    marginTop: 12,
    fontSize: 14,
    color: '#c62828',
    fontFamily: 'monospace',
  },
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
  // Renamed during the wip <- feat/ui-ux reconciliation: both branches independently
  // added a probeBox/probeCount pair with different designs. Both panels are kept, so
  // the USDK match-count panel's styles carry a usdk prefix to avoid the collision.
  usdkProbeBox: {
    marginTop: 12,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fafafa',
    alignItems: 'center',
  },
  probeLabel: {fontSize: 12, letterSpacing: 1, color: '#666'},
  usdkProbeCount: {
    fontSize: 56,
    fontWeight: '700',
    color: '#333',
    lineHeight: 64,
  },
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
