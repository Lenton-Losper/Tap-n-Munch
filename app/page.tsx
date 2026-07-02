import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { Nav } from './components/Nav'
import { Footer } from './components/Footer'
import { HeroSection } from './components/HeroSection'

export const metadata: Metadata = {
  title: 'FlashTap | QR Ordering for Restaurants',
  description:
    'FlashTap helps restaurants launch seamless table-side QR ordering with fast setup and clear analytics.',
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-[#1a1a1a]">
      <Nav />

      <main className="scroll-smooth">
        <HeroSection />

        <section className="border-b border-gray-100 bg-white py-6">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-3 px-6">
            {[
              { icon: '📍', text: 'Live at Sweet Side of Thingz, Windhoek' },
              { icon: '🏦', text: 'Bank of Namibia licensed via Finatic' },
              { icon: '📱', text: 'No app download required' },
              { icon: '💳', text: 'Cash, card & online payments' },
            ].map((item) => (
              <div
                key={item.text}
                className="flex items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-600"
              >
                <span>{item.icon}</span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </section>

        <section id="problem" className="bg-[#1a1a1a] px-6 py-20 text-white md:py-24">
          <div className="mx-auto max-w-5xl">
            <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">The problem</p>
            <h2 className="mb-12 text-4xl font-bold md:mb-16 md:text-6xl">
              Traditional table service
              <br />
              is costing you.
            </h2>
            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  num: '01',
                  title: 'Long wait times',
                  desc: 'Customers leave before ordering during rush hour. Every table that walks is revenue lost.',
                },
                {
                  num: '02',
                  title: 'Missed orders',
                  desc: 'Manual order taking leads to errors, reprints, unhappy customers and wasted food.',
                },
                {
                  num: '03',
                  title: 'No visibility',
                  desc: "You have no idea what's selling, which tables are slow, or how much revenue you're making in real time.",
                },
              ].map((item) => (
                <div key={item.num} className="rounded-2xl border border-white/10 p-8">
                  <div className="mb-4 text-5xl font-bold text-[#FF6B35]">{item.num}</div>
                  <h3 className="mb-3 text-xl font-bold">{item.title}</h3>
                  <p className="leading-relaxed text-white/60">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="bg-white px-6 py-20 md:py-24">
          <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-2 md:items-center md:gap-16">
            <div>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">How it works</p>
              <h2 className="mb-12 text-4xl font-bold md:text-5xl">
                Scan. Order. Pay.
                <br />
                That simple.
              </h2>
              {[
                { step: '1', title: 'QR code on every table', desc: 'We set up a unique QR code for each table in your restaurant.' },
                { step: '2', title: 'Customer scans and orders', desc: 'They browse your menu, add items and place their order — no app needed.' },
                { step: '3', title: 'Order appears instantly', desc: 'Your staff see the order in real time on the FlashTap dashboard.' },
                { step: '4', title: 'Customer pays their way', desc: 'Cash, card machine or online — payment goes directly to your bank account.' },
              ].map((item) => (
                <div key={item.step} className="mb-8 flex gap-6">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FF6B35] font-bold text-white">
                    {item.step}
                  </div>
                  <div>
                    <h3 className="mb-1 text-lg font-bold">{item.title}</h3>
                    <p className="text-gray-500">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="overflow-hidden rounded-3xl shadow-2xl">
              <div className="relative aspect-[4/5] w-full sm:aspect-[16/14]">
                <Image
                  src="/images/landing/sweet-side-table-orange.jpg"
                  alt="Sweet Side table with orange decor"
                  fill
                  className="object-cover"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="relative px-6 py-24 md:py-32">
          <Image
            src="/images/landing/sweet-side-table-round.jpg"
            alt="Sweet Side round table setup"
            fill
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10 mx-auto max-w-4xl text-center text-white">
            <p className="mb-6 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">
              Live pilot — Windhoek, Namibia
            </p>
            <blockquote className="mb-8 text-3xl font-bold leading-tight md:text-5xl">
              &ldquo;FlashTap changed how we handle orders during our busiest hours.&rdquo;
            </blockquote>
            <p className="text-lg text-white/70">Sweet Side of Thingz — Windhoek</p>
          </div>
        </section>

        <section id="features" className="bg-[#f8f8f8] px-6 py-20 md:py-24">
          <div className="mx-auto max-w-5xl">
            <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">Features</p>
            <h2 className="mb-16 text-4xl font-bold md:text-5xl">Everything your restaurant needs.</h2>
            <div className="grid gap-6 md:grid-cols-3">
              {[
                { icon: '📱', title: 'QR Menu Ordering', desc: 'Mobile-first menus that load instantly. No app download needed.' },
                { icon: '⚡', title: 'Real-time Dashboard', desc: 'Orders appear instantly. Accept, prepare and complete with one tap.' },
                { icon: '💳', title: 'Multiple Payments', desc: 'Cash, card terminal or online — all payments go directly to your bank.' },
                { icon: '🏦', title: 'Bank of Namibia Licensed', desc: 'Payments processed by Finatic — a BoN licensed payment processor.' },
                { icon: '🍽️', title: 'Table Management', desc: 'Track every table, open tabs and close them when customers leave.' },
                { icon: '📊', title: 'Sales Analytics', desc: "See what's selling, track revenue and understand your busiest hours." },
              ].map((feature) => (
                <div key={feature.title} className="rounded-2xl bg-white p-8 shadow-sm">
                  <div className="mb-4 text-4xl">{feature.icon}</div>
                  <h3 className="mb-2 text-lg font-bold">{feature.title}</h3>
                  <p className="text-sm leading-relaxed text-gray-500">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="payments" className="bg-white px-6 py-20 md:py-24">
          <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-2 md:items-center md:gap-16">
            <div className="overflow-hidden rounded-3xl shadow-2xl">
              <div className="relative aspect-[4/5] w-full sm:aspect-[16/14]">
                <Image
                  src="/images/landing/finatic-banner.jpg"
                  alt="Finatic payment partner banner"
                  fill
                  className="object-cover"
                />
              </div>
            </div>
            <div>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">Payments</p>
              <h2 className="mb-6 text-4xl font-bold md:text-5xl">
                Money goes straight
                <br />
                to your account.
              </h2>
              <p className="mb-8 text-lg leading-relaxed text-gray-500">
                FlashTap uses Finatic — a Bank of Namibia licensed payment processor. Every card payment goes directly
                into your restaurant&apos;s own bank account. FlashTap never holds your money.
              </p>
              <div className="space-y-4">
                {[
                  'Card payments via Finatic P5 terminal',
                  'Online card payments via hosted checkout',
                  'Cash payment tracking',
                  'Per-restaurant merchant accounts',
                  'Bank of Namibia licensed and compliant',
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#FF6B35] text-xs text-white">✓</div>
                    <span className="text-gray-700">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="bg-[#1a1a1a] px-6 py-20 text-white md:py-24">
          <div className="mx-auto max-w-5xl">
            <p className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#FF6B35]">Pricing</p>
            <h2 className="mb-4 text-4xl font-bold md:text-5xl">Simple pricing.</h2>
            <p className="mb-16 text-lg text-white/60">No hidden fees. Pay only a small percentage on card transactions.</p>
            <div className="grid gap-6 md:grid-cols-3">
              {[
                {
                  name: 'Starter',
                  price: 'N$499',
                  period: '/month',
                  desc: 'Perfect for cafes and small restaurants',
                  features: ['Up to 20 tables', 'QR ordering', 'Real-time dashboard', 'Cash & online payments', 'Email support'],
                  cta: 'Request Demo',
                  highlight: false,
                },
                {
                  name: 'Growth',
                  price: 'N$999',
                  period: '/month',
                  desc: 'For busy restaurants with high volume',
                  features: ['Unlimited tables', 'Card terminal integration', 'Analytics dashboard', 'Priority support', 'Menu management', '4% transaction fee on card'],
                  cta: 'Request Demo',
                  highlight: true,
                },
                {
                  name: 'Enterprise',
                  price: 'Custom',
                  period: '',
                  desc: 'Multi-location and food court support',
                  features: ['Multiple locations', 'Multi-vendor support', 'Custom integrations', 'Dedicated account manager', 'SLA support'],
                  cta: 'Contact Us',
                  highlight: false,
                },
              ].map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-2xl p-8 ${plan.highlight ? 'bg-[#FF6B35]' : 'border border-white/10 bg-white/5'}`}
                >
                  <h3 className="mb-2 text-xl font-bold">{plan.name}</h3>
                  <div className="mb-2 flex items-end gap-1">
                    <span className="text-4xl font-bold">{plan.price}</span>
                    <span className="mb-1 text-sm opacity-70">{plan.period}</span>
                  </div>
                  <p className={`mb-8 text-sm ${plan.highlight ? 'text-white/80' : 'text-white/50'}`}>{plan.desc}</p>
                  <ul className="mb-8 space-y-3">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-sm">
                        <span>✓</span> {feature}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/contact"
                    className={`block rounded-full py-3 text-center font-semibold ${plan.highlight ? 'bg-white text-[#FF6B35]' : 'bg-[#FF6B35] text-white'}`}
                  >
                    {plan.cta}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className="relative px-6 py-24 md:py-32">
          <Image
            src="/images/landing/sweet-side-counter.jpg"
            alt="Sweet Side counter area"
            fill
            className="object-cover"
          />
          <div className="absolute inset-0 bg-black/65" />
          <div className="relative z-10 mx-auto max-w-3xl text-center text-white">
            <h2 className="mb-6 text-4xl font-bold md:text-6xl">
              Ready to modernise
              <br />
              your restaurant?
            </h2>
            <p className="mb-10 text-xl text-white/70">
              Join the restaurants in Namibia already using FlashTap. Setup takes less than a day.
            </p>
            <Link
              href="/contact"
              className="inline-block rounded-full bg-[#FF6B35] px-10 py-5 text-xl font-semibold text-white transition hover:bg-[#e55a24]"
            >
              Get Started Today →
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
