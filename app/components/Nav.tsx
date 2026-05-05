'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

const sectionLinks = [
  { label: 'Problem', href: '/#problem' },
  { label: 'Features', href: '/#features' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'Payments', href: '/#payments' },
  { label: 'Pricing', href: '/#pricing' },
]

export function Nav() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const closeMobileMenu = () => setMobileOpen(false)

  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-[#E9E9E7] bg-[#F7F6F3]/90 backdrop-blur-md">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8" aria-label="Main navigation">
        <div className="flex h-16 items-center justify-between">
          <Link
            href="/"
            onClick={closeMobileMenu}
            className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F6F3]"
          >
            <span
              aria-hidden="true"
              className="inline-block h-6 w-6 rounded-md border border-[#E9E9E7] bg-white"
            />
            FlashTap
          </Link>

          <div className="hidden items-center gap-8 md:flex">
            {sectionLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-[#6B675F] transition-colors hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F6F3]"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/contact"
              className="text-sm text-[#6B675F] transition-colors hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F6F3]"
            >
              Contact
            </Link>
            <Button
              asChild
              variant="outline"
              className="rounded-lg border-[#D9D7D3] bg-white text-[#37352F] hover:bg-[#F1F0EC]"
            >
              <Link href="/signin">Sign In</Link>
            </Button>
          </div>

          <button
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMobileOpen((prev) => !prev)}
            className="inline-flex items-center justify-center rounded-lg border border-[#D9D7D3] p-2 text-[#37352F] transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F] md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {mobileOpen && (
        <div
          id="mobile-menu"
          className="border-t border-[#E9E9E7] bg-[#F7F6F3] px-4 pb-4 pt-2 md:hidden"
        >
          <div className="flex flex-col gap-2">
            {sectionLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={closeMobileMenu}
                className="rounded-lg px-3 py-2 text-sm text-[#6B675F] transition-colors hover:bg-white hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/contact"
              onClick={closeMobileMenu}
              className="rounded-lg px-3 py-2 text-sm text-[#6B675F] transition-colors hover:bg-white hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]"
            >
              Contact
            </Link>
            <Button
              asChild
              variant="outline"
              className="mt-2 w-full rounded-lg border-[#D9D7D3] bg-white text-[#37352F] hover:bg-[#F1F0EC]"
            >
              <Link href="/signin" onClick={closeMobileMenu}>
                Sign In
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  )
}

