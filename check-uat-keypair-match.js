import { getDerivedPublicKeyFingerprintFromPrivateKey, getPublicKeyFingerprint } from './payments/signature.js'

// Provided in your UAT test parameters (base64 body, no PEM headers)
const UAT_APP_RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqmGBa23VxYTr98xKOH5jkVJmCrGnRP0DCYQ+ZBs7YbH8LzKKiR8zeNa6xljqeJYy+uHpbHdmpoJxJFovCJrVfYUuCCi37fy6tKD+TgVL26pXWhuil+cI6u0NdVuxHOf7Ul9CHQLVfvlGjvyCcsnZ9iTWY7KXksW1LhPnMphrPbF7TubOcEUJniVr91YQ80DI/DdKbQ9nVb6BZCme5W56TaPVC8AJ9qFUIC65hL/0fkxGT4gHAiIXHs+HopmPYurnE3I+CPZYlHk4MnQJzQHrEGQwrd6kMn5fBGb31rQlFVW4p+LomLMW83BUlt6tKtu3y7K7j0Rn/lx5420eON/DKQIDAQAB'

const derived = getDerivedPublicKeyFingerprintFromPrivateKey()
const configured = getPublicKeyFingerprint(UAT_APP_RSA_PUBLIC_KEY)

console.log(JSON.stringify({ derivedFingerprintSha256: derived, providedPublicFingerprintSha256: configured, match: derived === configured }, null, 2))

