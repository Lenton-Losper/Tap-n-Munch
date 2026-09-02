/**
 * @jest-environment jsdom
 *
 * The install surface a manager reads once, at the screen they are setting up. The route and
 * manifest assertions live in station-pwa-manifest.test.ts — that half needs the Node globals
 * a Next route handler expects, which jsdom does not provide.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { StationLaunchPanel } from '@/components/settings/station-launch-panel'

describe('StationLaunchPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<StationLaunchPanel />))
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers one link per station, each to its own station path', () => {
    const k = container.querySelector('[data-testid="launch-kitchen"]') as HTMLAnchorElement
    const b = container.querySelector('[data-testid="launch-bar"]') as HTMLAnchorElement
    expect(k.getAttribute('href')).toBe('/kitchen')
    expect(b.getAttribute('href')).toBe('/bar')
    expect(k.getAttribute('href')).not.toBe(b.getAttribute('href'))
  })

  it('says the thing installers get wrong: installing is not pairing', () => {
    expect(container.textContent).toMatch(/does not pair/i)
  })

  it('uses no developer vocabulary a manager would have to decode', () => {
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/manifest|service worker|JWT|terminal_id|station_kind|payload|PWA/i)
  })
})

