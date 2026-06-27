const RIVIERA_HOST = 'riviera.flashtap.app'
const RIVIERA_RESTAURANT_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const RIVIERA_MENU_PATH = `/menu/${RIVIERA_RESTAURANT_ID}/v2`

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: false,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: ['lucide-react', 'sonner', 'recharts'],
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/',
          has: [{ type: 'host', value: RIVIERA_HOST }],
          destination: RIVIERA_MENU_PATH,
        },
        {
          source: '/session-ended',
          has: [{ type: 'host', value: RIVIERA_HOST }],
          destination: `/menu/${RIVIERA_RESTAURANT_ID}/session-ended`,
        },
      ],
    }
  },
}

export default nextConfig
