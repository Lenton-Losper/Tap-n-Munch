/**
 * Load STAGING_TEST_PASSWORD from the environment with a runtime guard.
 * Return type is `string` so callers (including nested functions) stay type-safe.
 */
export function requireStagingTestPassword(
  envVar = 'STAGING_TEST_PASSWORD',
  hint = '.env.test',
): string {
  const password = process.env[envVar]?.trim()
  if (!password) {
    throw new Error(`Refusing: ${envVar} is not set (${hint})`)
  }
  return password
}
