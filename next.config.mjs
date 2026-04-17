import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** This repo’s root (avoids picking a parent `package-lock.json` on Desktop). */
const projectRoot = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: projectRoot,
  },
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
