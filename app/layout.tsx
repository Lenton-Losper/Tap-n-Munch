import type { Metadata } from 'next'
import { Inter, Playfair_Display } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${playfairDisplay.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
        <Analytics />
      </body>
    </html>
  )
}
