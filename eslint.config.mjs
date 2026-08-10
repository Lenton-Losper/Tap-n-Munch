import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: [
      '.next/**',
      '.open-next/**',
      '.tmp-wise-postman/**',
      '.wrangler/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'scripts/archive/**',
      'workers/**',
    ],
  },
]

export default eslintConfig
