import type { Metadata } from 'next'
import Link from 'next/link'
import { MessageCircle, Phone, Mail } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { ContactForm } from '../components/ContactForm'

export const metadata: Metadata = {
  title: 'Contact FlashTap',
  description: 'Get in touch with FlashTap to request a demo for your venue.',
}

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="pt-20">
        <section className="border-b border-[#E9E9E7] px-4 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <h1 className="font-serif text-4xl font-semibold sm:text-5xl">Get in Touch</h1>
            <p className="mt-4 max-w-2xl text-[#6B675F]">
              Share a few details and our team will reach out with a tailored FlashTap demo for your venue.
            </p>
          </div>
        </section>

        <section id="contact" className="px-4 py-24 sm:px-6 lg:px-8">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
            <div className="rounded-2xl border border-[#E9E9E7] bg-white p-6 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-8">
              <h2 className="font-serif text-2xl font-semibold">Contact Us</h2>
              <p className="mt-2 text-sm text-[#6B675F]">We typically reply within one business day.</p>
              <div className="mt-6">
                <ContactForm submitLabel="Send Message" />
              </div>
            </div>

            <aside className="rounded-2xl border border-[#E9E9E7] bg-white p-6 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-8">
              <h2 className="font-serif text-2xl font-semibold">Contact Information</h2>
              <div className="mt-6 space-y-4 text-sm text-[#4F4A42]">
                <p className="flex items-center gap-3">
                  <Phone className="h-4 w-4" />
                  <span>Phone: +264817375744</span>
                </p>
                <p className="flex items-center gap-3">
                  <Mail className="h-4 w-4" />
                  <span>Email: llosperofficial@gmail.com</span>
                </p>
                <p className="flex items-center gap-3">
                  <MessageCircle className="h-4 w-4" />
                  <Link
                    href="https://wa.me/264817375744"
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-[#BFBAB0] underline-offset-4 hover:decoration-[#37352F]"
                  >
                    WhatsApp Chat
                  </Link>
                </p>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}

