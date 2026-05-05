'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'

const heroImages = [
  '/images/landing/sweet-side-interior.jpg',
  '/images/landing/sweet-side-table-orange.jpg',
  '/images/landing/sweet-side-table-round.jpg',
  '/images/landing/finatic-banner.jpg',
  '/images/landing/sweet-side-counter.jpg',
]

export function HeroSection() {
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrent((prev) => (prev + 1) % heroImages.length)
    }, 4000)

    return () => clearInterval(timer)
  }, [])

  return (
    <section className="relative flex min-h-screen items-center overflow-hidden pt-20">
      {heroImages.map((img, i) => (
        <Image
          key={img}
          src={img}
          alt="FlashTap hero background"
          fill
          priority={i === 0}
          className={`absolute inset-0 object-cover transition-opacity duration-1000 ${
            i === current ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ))}

      <div className="absolute inset-0 bg-black/55" />

      <div className="absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        {heroImages.map((_, i) => (
          <button
            key={heroImages[i]}
            type="button"
            onClick={() => setCurrent(i)}
            className={`h-2 w-2 rounded-full transition-all ${i === current ? 'w-6 bg-white' : 'bg-white/40'}`}
            aria-label={`Show hero image ${i + 1}`}
          />
        ))}
      </div>

      <div className="relative z-10 mx-auto w-full max-w-4xl px-6 py-16 text-white">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm backdrop-blur">
          Built for Namibia 🇳🇦
        </div>
        <h1 className="mb-6 text-5xl font-bold leading-tight md:text-7xl lg:text-8xl">
          Your restaurant,
          <br />
          digitised.
        </h1>
        <p className="mb-10 max-w-2xl text-lg text-white/80 md:text-2xl">
          Customers scan, order and pay from their phone. Orders go straight to your staff in real time. No app
          downloads. No complicated setup.
        </p>
        <div className="flex flex-wrap gap-4">
          <Link
            href="/contact"
            className="rounded-full bg-[#FF6B35] px-8 py-4 text-lg font-semibold text-white transition hover:bg-[#e55a24]"
          >
            Request a Demo →
          </Link>
          <Link
            href="/signin"
            className="rounded-full border border-white/30 bg-white/10 px-8 py-4 text-lg text-white backdrop-blur transition hover:bg-white/20"
          >
            Sign In
          </Link>
        </div>
      </div>
    </section>
  )
}
