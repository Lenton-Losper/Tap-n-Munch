import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {AppState} from 'react-native';
import {getTerminalInfo} from '../lib/api';
import {resolveServiceModel, ServiceModel} from '../lib/serviceModel';
import {getTerminalToken} from '../lib/storage';

/**
 * Which ordering flow this venue uses, kept fresh from `GET /api/terminal/me`.
 *
 * IT STARTS AT 'unknown' AND THAT IS THE POINT. Until a /me call has actually come back saying
 * otherwise, the device renders exactly what today's build renders — Tables, Orders, Sale. A
 * terminal that cannot reach the server, or reaches an older deploy that does not send the field,
 * therefore behaves like the build the staff already know rather than losing its till.
 *
 * Re-checked on a slow interval and on return to the foreground rather than on every screen, since
 * the answer changes roughly never — it changes when somebody flips a venue's model in the
 * dashboard, and picking that up within a few minutes is ample.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000;

interface ServiceModelValue {
  model: ServiceModel;
  /** False until the first /me call has settled either way. */
  resolved: boolean;
  refresh: () => void;
}

const ServiceModelContext = createContext<ServiceModelValue | undefined>(
  undefined,
);

export function ServiceModelProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [model, setModel] = useState<ServiceModel>('unknown');
  const [resolved, setResolved] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const token = await getTerminalToken();
      if (!token) {
        return;
      }
      const info = await getTerminalInfo(token);
      if (!mountedRef.current) {
        return;
      }
      setModel(resolveServiceModel(info));
      setResolved(true);
    } catch {
      // Deliberately silent, and deliberately NOT a state change.
      //
      // A failed /me leaves `model` exactly as it was. Resetting to 'unknown' on an error would
      // make the Sale tab reappear on a table-service venue every time the wifi dipped, and a
      // navigation bar that changes shape under a waiter mid-service is worse than a stale one.
      // The next successful poll corrects it.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        load();
      }
    });
    return () => {
      mountedRef.current = false;
      clearInterval(id);
      sub.remove();
    };
  }, [load]);

  const value = useMemo(
    () => ({model, resolved, refresh: load}),
    [model, resolved, load],
  );

  return (
    <ServiceModelContext.Provider value={value}>
      {children}
    </ServiceModelContext.Provider>
  );
}

export function useServiceModel(): ServiceModelValue {
  const ctx = useContext(ServiceModelContext);
  if (!ctx) {
    throw new Error(
      'useServiceModel must be used within a ServiceModelProvider',
    );
  }
  return ctx;
}
