import Link from 'next/link'

export function Footer() {
  return (
    <footer className="bg-[#111111] text-white">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-12 text-sm text-white/70 sm:px-6 lg:px-8 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-medium text-white">FlashTap</p>
          <p className="mt-1">Built for Namibia 🇳🇦</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/#problem" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Problem
          </Link>
          <Link href="/#features" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Features
          </Link>
          <Link href="/#how-it-works" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            How It Works
          </Link>
          <Link href="/#payments" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Payments
          </Link>
          <Link href="/#pricing" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Pricing
          </Link>
          <Link href="/contact" className="hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Contact
          </Link>
        </div>
      </div>
    </footer>
  )
}

