import EncryptedStorage from 'react-native-encrypted-storage';
import {
  MERCHANT_NO_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
  RESTAURANT_ID_STORAGE_KEY,
  RESTAURANT_NAME_STORAGE_KEY,
  STORE_NO_STORAGE_KEY,
  TERMINAL_ID_STORAGE_KEY,
  TOKEN_STORAGE_KEY,
} from '../constants';

export async function saveTerminalToken(token: string): Promise<void> {
  await EncryptedStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export async function getTerminalToken(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function clearTerminalToken(): Promise<void> {
  try {
    await EncryptedStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Item may not exist
  }
}

export async function saveRefreshToken(token: string): Promise<void> {
  await EncryptedStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function clearRefreshToken(): Promise<void> {
  try {
    await EncryptedStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  } catch {
    // Item may not exist
  }
}

export async function clearAllTokens(): Promise<void> {
  await Promise.all([clearTerminalToken(), clearRefreshToken()]);
}

export async function saveRestaurantId(id: string): Promise<void> {
  await EncryptedStorage.setItem(RESTAURANT_ID_STORAGE_KEY, id);
}

export async function getRestaurantId(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(RESTAURANT_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveTerminalId(id: string): Promise<void> {
  await EncryptedStorage.setItem(TERMINAL_ID_STORAGE_KEY, id);
}

export async function getTerminalId(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(TERMINAL_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveRestaurantName(name: string): Promise<void> {
  await EncryptedStorage.setItem(RESTAURANT_NAME_STORAGE_KEY, name);
}

export async function getRestaurantName(): Promise<string | null> {
  try {
    return await EncryptedStorage.getItem(RESTAURANT_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function saveMerchantCredentials(
  merchantNo: string,
  storeNo: string,
): Promise<void> {
  await EncryptedStorage.setItem(MERCHANT_NO_STORAGE_KEY, merchantNo);
  await EncryptedStorage.setItem(STORE_NO_STORAGE_KEY, storeNo);
}

export async function getMerchantCredentials(): Promise<{
  merchantNo: string;
  storeNo: string;
} | null> {
  try {
    const [merchantNo, storeNo] = await Promise.all([
      EncryptedStorage.getItem(MERCHANT_NO_STORAGE_KEY),
      EncryptedStorage.getItem(STORE_NO_STORAGE_KEY),
    ]);
    if (!merchantNo || !storeNo) {
      return null;
    }
    return {merchantNo, storeNo};
  } catch {
    return null;
  }
}

export async function clearTerminalSession(): Promise<void> {
  const keys = [
    TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    RESTAURANT_ID_STORAGE_KEY,
    TERMINAL_ID_STORAGE_KEY,
    RESTAURANT_NAME_STORAGE_KEY,
  ];

  await Promise.all(
    keys.map(async key => {
      try {
        await EncryptedStorage.removeItem(key);
      } catch {
        // Item may not exist
      }
    }),
  );
}

export async function clearAllData(): Promise<void> {
  const keys = [
    TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    RESTAURANT_ID_STORAGE_KEY,
    TERMINAL_ID_STORAGE_KEY,
    RESTAURANT_NAME_STORAGE_KEY,
    MERCHANT_NO_STORAGE_KEY,
    STORE_NO_STORAGE_KEY,
  ];
  await Promise.all(
    keys.map(key =>
      EncryptedStorage.removeItem(key).catch(() => {}),
    ),
  );
}
