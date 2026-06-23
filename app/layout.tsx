import type { Metadata } from 'next'
import { Inter, Playfair_Display } from 'next/font/google'
import { headers } from 'next/headers'
import { Analytics } from '@vercel/analytics/next'
import { isRivieraHost } from '@/lib/riviera-subdomain'
import { AppProviders } from './providers'
import './globals.css'

// Typography: Inter for body/UI, Playfair Display for headings/brand
const inter = Inter({ 
  subsets: ["latin"], 
  variable: '--font-sans',
  display: 'swap',
});

const playfairDisplay = Playfair_Display({ 
  subsets: ["latin"], 
  weight: ['400', '500', '600', '700'],
  variable: '--font-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'FlashTap',
  description: 'FlashTap - Restaurant Ordering System',
  generator: 'v0.app',
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const host = (await headers()).get('host')
  const isRivieraSubdomain = isRivieraHost(host)

  return (
    <html lang="en" className={`${inter.variable} ${playfairDisplay.variable}`}>
      <body>
        <AppProviders isRivieraSubdomain={isRivieraSubdomain}>{children}</AppProviders>
        <Analytics />
      </body>
    </html>
  )
}
