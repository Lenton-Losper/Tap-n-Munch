import React, {createContext, useContext, useMemo, useState} from 'react';

export type StreamConnectionStatus = 'checking' | 'connected' | 'disconnected';

interface StreamContextValue {
  connectionStatus: StreamConnectionStatus;
  setConnectionStatus: (status: StreamConnectionStatus) => void;
}

const StreamContext = createContext<StreamContextValue | null>(null);

export function StreamProvider({children}: {children: React.ReactNode}) {
  const [connectionStatus, setConnectionStatus] =
    useState<StreamConnectionStatus>('checking');

  const value = useMemo(
    () => ({connectionStatus, setConnectionStatus}),
    [connectionStatus],
  );

  return (
    <StreamContext.Provider value={value}>{children}</StreamContext.Provider>
  );
}

export function useStreamConnection(): StreamContextValue {
  const context = useContext(StreamContext);
  if (!context) {
    throw new Error('useStreamConnection must be used within StreamProvider');
  }
  return context;
}
