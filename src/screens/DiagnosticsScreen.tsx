import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  NativeModules,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
} from 'react-native';
import {APP_VERSION, FLASHTAP_API_URL} from '../constants';
import {
  getRestaurantId,
  getTerminalId,
  getTerminalToken,
} from '../lib/storage';

const {RuntimeConfig} = NativeModules;

interface RuntimeInfo {
  environment?: string;
  supabaseProject?: string;
  worker?: string;
  serviceRoleKeyPrefix?: string;
  error?: string;
}

export default function DiagnosticsScreen({onClose}: {onClose: () => void}) {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string | null>(null);
  const [tokenPresent, setTokenPresent] = useState(false);

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
  }, []);

  useEffect(() => {
    fetch(`${FLASHTAP_API_URL}/api/debug/runtime`)
      .then(r => r.json())
      .then(data => setRuntime(data))
      .catch(e => setRuntime({error: e.message}))
      .finally(() => setLoading(false));
  }, []);

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>FlashTap Diagnostics</Text>

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
  loader: {marginTop: 16},
  closeBtn: {
    marginTop: 32,
    padding: 16,
    backgroundColor: '#f0f0f0',
    borderRadius: 8,
    alignItems: 'center',
  },
  closeTxt: {fontSize: 16, color: '#333'},
});
