import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getTerminalInfo,
  refreshAccessToken,
  TerminalAuthError,
} from '../lib/api';
import {
  clearAllTokens,
  getRefreshToken,
  getTerminalToken,
} from '../lib/storage';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: () => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({children}: {children: React.ReactNode}) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      try {
        let accessToken = await getTerminalToken();

        if (!accessToken) {
          const refreshToken = await getRefreshToken();
          if (refreshToken) {
            accessToken = await refreshAccessToken();
          }
          if (!accessToken) {
            setIsAuthenticated(false);
            return;
          }
          setIsAuthenticated(true);
          return;
        }

        try {
          await getTerminalInfo(accessToken);
          setIsAuthenticated(true);
        } catch (err) {
          if (err instanceof TerminalAuthError) {
            const newToken = await refreshAccessToken();
            if (newToken) {
              setIsAuthenticated(true);
              return;
            }
            await clearAllTokens();
            setIsAuthenticated(false);
            return;
          }
          setIsAuthenticated(false);
        }
      } finally {
        setIsLoading(false);
      }
    }

    checkAuth();
  }, []);

  const signIn = useCallback(() => {
    setIsAuthenticated(true);
  }, []);

  const signOut = useCallback(() => {
    setIsAuthenticated(false);
  }, []);

  const value = useMemo(
    () => ({isAuthenticated, isLoading, signIn, signOut}),
    [isAuthenticated, isLoading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
