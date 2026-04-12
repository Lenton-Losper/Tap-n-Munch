/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Ensure selected dependencies are transpiled to match older browsers from browserslist.
  transpilePackages: ['lucide-react', 'sonner', 'recharts'],
}

export default nextConfig
