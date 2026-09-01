'use client'

import { useSearchParams } from 'next/navigation'

/**
 * Local visual QA only — renders KitchenScreen against the dev fixture, no auth, no network.
 * lib/stations/dev-fixture.ts's own docblock: "safe to import from a page for local visual
 * checking." Not linked from anywhere in the real app; not a route a terminal or a manager ever
 * reaches.
 *
 * NOW THE TWENTY-TABLE FIXTURE, not the six-line one. Four cards fit any layout, so a preview built
 * on four cards could not have shown the defect the owner reported (two cards across a 1920x1080
 * wall, a busy board scrolling off the bottom of a screen nobody can touch). The volume case is the
 * one worth previewing; the small fixture stays for the unit render test, where a readable failure
 * matters more than a realistic one.
 *
 * The clock is frozen so a screenshot taken today and one taken next week are comparable — the
 * proof images in docs/proof/ are rendered from exactly this.
 */
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { buildKitchenWallFixture, buildKitchenQuietScenario, buildKitchenBusyScenario, buildKitchenVolumeScenario } from '@/lib/stations/dev-fixture'

const NOW = Date.parse('2026-08-28T18:30:00.000Z')

/**
 * `?scenario=quiet` / `?scenario=busy` select the KDS-redesign scenarios; anything else keeps the
 * original twenty-table wall fixture so the existing proof images stay reproducible.
 */
function pickFixture(scenario: string | null, now: number) {
  if (scenario === 'quiet') return buildKitchenQuietScenario(now)
  if (scenario === 'busy') return buildKitchenBusyScenario(now)
  if (scenario === 'v20') return buildKitchenVolumeScenario(now, 20)
  if (scenario === 'v40') return buildKitchenVolumeScenario(now, 40)
  return buildKitchenWallFixture(now)
}

export default function DevKitchenPreviewPage() {
  const scenario = useSearchParams().get('scenario')
  return (
    <KitchenScreen
      lines={pickFixture(scenario, NOW)}
      now={NOW}
      connectionState="live"
      onBump={async (lineIds) => ({ ok: true, total: lineIds.length, failedLineIds: [] })}
    />
  )
}
