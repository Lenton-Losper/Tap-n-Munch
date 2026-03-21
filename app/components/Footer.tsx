import Link from 'next/link'

export function Footer() {
  return (
    <footer className="border-t border-[#E9E9E7] bg-[#F7F6F3]">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-12 text-sm text-[#6B675F] sm:px-6 lg:px-8 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="font-medium text-[#37352F]">FlashTap</p>
          <p className="mt-1">Table-side ordering made effortless.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link href="/#features" className="hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]">
            Features
          </Link>
          <Link href="/#how-it-works" className="hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]">
            How It Works
          </Link>
          <Link href="/#pricing" className="hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]">
            Pricing
          </Link>
          <Link href="/contact" className="hover:text-[#37352F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#37352F]">
            Contact
          </Link>
        </div>
      </div>
    </footer>
  )
}

