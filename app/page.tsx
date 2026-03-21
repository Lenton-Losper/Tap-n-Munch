import type { Metadata } from 'next'
import { existsSync } from 'fs'
import path from 'path'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, CheckCircle2, Sparkles } from 'lucide-react'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { ContactForm } from './components/ContactForm'
import { Button } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'FlashTap | QR Ordering for Restaurants',
  description:
    'FlashTap helps restaurants launch seamless table-side QR ordering with fast setup and clear analytics.',
}

export default function HomePage() {
  const heroMockupSrc = existsSync(path.join(process.cwd(), 'public', 'image_ccac55.jpg'))
    ? '/image_ccac55.jpg'
    : existsSync(path.join(process.cwd(), 'public', 'image_ce10fc.jpg'))
      ? '/image_ce10fc.jpg'
      : '/placeholder.jpg'

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="pt-20">
        <section className="relative overflow-visible border-b border-[#E9E9E7] px-4 py-32 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-14 lg:grid-cols-12 lg:items-center">
            <div className="max-w-3xl space-y-8 lg:col-span-5 lg:self-center lg:pr-12 xl:pr-16">
              <p className="inline-flex items-center gap-2 rounded-lg border border-[#E9E9E7] bg-white px-3 py-1 text-xs uppercase tracking-[0.2em] text-[#6B675F] shadow-sm">
                <Sparkles className="h-3.5 w-3.5" />
                Built for modern venues
              </p>
              <h1 className="font-serif text-balance text-4xl font-semibold leading-tight text-[#37352F] sm:text-5xl lg:text-6xl">
                Speed up service with elegant QR ordering.
              </h1>
              <p className="max-w-2xl text-base text-[#6B675F] sm:text-lg">
                FlashTap turns every table into a fast digital ordering station. No app downloads, no clutter,
                just a clean flow from scan to payment.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]">
                  <Link href="#contact">
                    Request Demo <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="rounded-lg border-[#D9D7D3] bg-white text-[#37352F] hover:bg-[#EFEDE8]"
                >
                  <Link href="#contact">Start Free Trial</Link>
                </Button>
              </div>
            </div>

            <div className="mx-auto w-full max-w-2xl overflow-visible lg:col-span-7 lg:mx-0 lg:justify-self-end">
              <div className="animate-hero-float overflow-visible rounded-[28px] border border-[#E9E9E7] bg-white p-3 shadow-[0_24px_60px_rgba(55,53,47,0.12)]">
                <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-[#EFEDE8]">
                  <Image
                    src={heroMockupSrc}
                    alt="FlashTap mobile ordering screens"
                    fill
                    priority
                    className="h-full w-full object-contain"
                    sizes="(min-width: 1280px) 52vw, (min-width: 1024px) 46vw, 92vw"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="border-b border-[#E9E9E7] px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">Features in a glance</h2>
            <p className="mt-4 max-w-2xl text-[#6B675F]">
              A focused toolkit designed to improve speed, service quality, and revenue.
            </p>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {[
                'Mobile-first menu with instant load times',
                'Real-time kitchen and floor updates',
                'Built-in upsells and smart recommendations',
                'Live order timeline for each table',
                'Simple analytics and revenue snapshots',
              ].map((item, index) => (
                <article
                  key={item}
                  className={`${index === 0 || index === 3 ? 'md:col-span-2' : ''} rounded-2xl border border-[#E9E9E7] bg-white p-7 shadow-[0_8px_30px_rgba(55,53,47,0.04)]`}
                >
                  <div className="flex items-start gap-2 text-sm leading-7 text-[#4F4A42]">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#37352F]" />
                    {item}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[#E9E9E7] px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">The problem with traditional table service.</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                'Long wait times frustrate guests and reduce repeat visits.',
                'Missed orders and manual entry lead to costly mistakes.',
                'No visibility into what is selling in real time.',
              ].map((item) => (
                <div key={item} className="rounded-xl border border-[#E9E9E7] bg-white p-6 shadow-[0_8px_30px_rgba(55,53,47,0.03)]">
                  <p className="text-sm leading-7 text-[#4F4A42]">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="border-b border-[#E9E9E7] px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">How It Works</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                { title: '1. Guests Scan', description: 'Customers scan a table QR code to open your live menu.' },
                { title: '2. Orders Flow', description: 'Orders route instantly to your kitchen and service staff.' },
                { title: '3. You Grow', description: 'Track performance and optimize menus with built-in analytics.' },
              ].map((step) => (
                <article key={step.title} className="rounded-xl border border-[#E9E9E7] bg-white p-7 shadow-[0_8px_30px_rgba(55,53,47,0.03)]">
                  <h3 className="text-lg font-medium">{step.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-[#6B675F]">{step.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[#E9E9E7] px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">Why FlashTap</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                'Serve more tables with the same team size.',
                'Reduce ordering errors and payment friction.',
                'Increase average order value with smart prompts.',
                'Keep full brand control with a clean white-label look.',
              ].map((benefit, index) => (
                <div
                  key={benefit}
                  className={`${index === 1 ? 'md:col-span-2' : ''} rounded-2xl border border-[#E9E9E7] bg-white p-6 shadow-[0_8px_30px_rgba(55,53,47,0.04)]`}
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-[#37352F]" />
                    <p className="text-sm leading-7 text-[#4F4A42]">{benefit}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="border-b border-[#E9E9E7] px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">Simple pricing for growing restaurants.</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {[
                { tier: 'Starter', price: '$49/mo', note: 'Perfect for cafes and small venues.' },
                { tier: 'Growth', price: '$99/mo', note: 'Advanced tools for busy multi-shift teams.' },
                { tier: 'Scale', price: 'Custom', note: 'Enterprise support for multi-location brands.' },
              ].map((plan) => (
                <article
                  key={plan.tier}
                  className={`${plan.tier === 'Growth' ? 'border-[#DCCEF8] bg-[#F8F4FF]' : 'border-[#E9E9E7] bg-white'} rounded-2xl border p-7 shadow-[0_10px_35px_rgba(55,53,47,0.06)]`}
                >
                  <h3 className="text-lg font-medium">{plan.tier}</h3>
                  <p className="mt-4 text-3xl font-semibold">{plan.price}</p>
                  <p className="mt-3 text-sm text-[#6B675F]">{plan.note}</p>
                  <Button
                    asChild
                    className={`${plan.tier === 'Growth' ? 'bg-[#7C5CC4] hover:bg-[#6C4DB4]' : 'bg-[#37352F] hover:bg-[#2f2d27]'} mt-6 w-full rounded-lg text-white`}
                  >
                    <Link href="#contact">Request Demo</Link>
                  </Button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className="px-4 py-28 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="font-serif text-3xl font-semibold sm:text-4xl">Ready to launch FlashTap?</h2>
            <p className="mx-auto mt-4 max-w-xl text-[#6B675F]">
                Tell us about your venue and we will set up a tailored demo. No pressure, no lengthy setup call.
            </p>
            <div className="mt-10 rounded-2xl border border-[#E9E9E7] bg-white p-6 text-left shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-8">
              <ContactForm submitLabel="Request Demo" />
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
