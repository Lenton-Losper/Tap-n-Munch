/**
 * @jest-environment node
 *
 * TWO INSTALLED APPLICATIONS, AND NEITHER ONE CARRIES A VENUE.
 *
 * Staff were typing flashtap.app/kitchen by hand. On 2026-09-02 that is how a screen standing in
 * Riviera came to be paired to a different venue, with nothing on the screen saying so.
 *
 * The assertions that carry the risk:
 *   - the two manifests must differ in `id`, or Chrome installs ONE app and both icons open the
 *     same board;
 *   - no start_url may contain a restaurant identifier, or the venue becomes something anyone can
 *     edit in a shortcut's properties.
 */
import { existsSync, statSync } from 'fs'
import { GET as manifestRoute } from '@/app/manifest/[station]/route'
import { STATION_PWA, stationPwaManifestUrl } from '@/lib/stations/pwa'

const read = async (station: string) => {
  const res = await manifestRoute(new Request(`https://flashtap.app/manifest/${station}`), {
    params: Promise.resolve({ station }),
  })
  return { status: res.status, body: await res.json() }
}

describe('the two station manifests', () => {
  it('serves a manifest for each station', async () => {
    for (const station of ['kitchen', 'bar']) {
      const { status } = await read(station)
      expect(status).toBe(200)
    }
  })

  it('gives each station a DISTINCT id, name and start_url', async () => {
    const k = (await read('kitchen')).body
    const b = (await read('bar')).body

    expect(k.name).toBe('FlashTap Kitchen')
    expect(b.name).toBe('FlashTap Bar')
    // The load-bearing one: same id => Chrome installs a single application.
    expect(k.id).not.toBe(b.id)
    expect(k.start_url).toBe('/kitchen')
    expect(b.start_url).toBe('/bar')
  })

  it('declares what Chrome needs to offer an install', async () => {
    for (const station of ['kitchen', 'bar']) {
      const { body } = await read(station)
      expect(body.display).toBe('standalone')
      expect(typeof body.short_name).toBe('string')
      expect(body.short_name.length).toBeGreaterThan(0)
      const sizes = body.icons.map((i: { sizes: string }) => i.sizes)
      expect(sizes).toContain('192x192')
      expect(sizes).toContain('512x512')
    }
  })

  it('never puts a restaurant identifier in the launch URL', async () => {
    for (const station of ['kitchen', 'bar']) {
      const { body } = await read(station)
      for (const field of [body.start_url, body.scope, body.id]) {
        expect(field).not.toMatch(/restaurant|venue|[0-9a-f]{8}-[0-9a-f]{4}/i)
      }
    }
  })

  it('refuses a station it does not recognise', async () => {
    expect((await read('pass')).status).toBe(404)
    expect((await read('../admin')).status).toBe(404)
  })
})

describe('the icon files actually exist at the declared sizes', () => {
  it('has a real file behind every icon entry', async () => {
    for (const station of ['kitchen', 'bar']) {
      const { body } = await read(station)
      for (const icon of body.icons as Array<{ src: string }>) {
        const path = `public${icon.src}`
        expect(existsSync(path)).toBe(true)
        // A zero-byte placeholder would satisfy existsSync and fail to install.
        expect(statSync(path).size).toBeGreaterThan(500)
      }
    }
  })
})

describe('the manifest url helper', () => {
  it('points each station at its own document', () => {
    expect(stationPwaManifestUrl('kitchen')).toBe('/manifest/kitchen')
    expect(stationPwaManifestUrl('bar')).toBe('/manifest/bar')
    expect(STATION_PWA.kitchen.startUrl).not.toBe(STATION_PWA.bar.startUrl)
  })
})
