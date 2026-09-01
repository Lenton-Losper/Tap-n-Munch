'use client'

import { useSearchParams } from 'next/navigation'

/**
 * Local visual QA only — the bar's half of what app/dev-kitchen-preview does, and it did not exist
 * before. That is not a coincidence: the bar screen was the one left behind when the kitchen was
 * rebuilt for distance, and nothing rendered it at volume for anyone to notice.
 *
 * No auth, no network, frozen clock — same terms as the kitchen preview, so the two screenshots in
 * docs/proof/ are comparable side by side.
 */
import { BarScreen } from '@/components/stations/bar-screen'
import { buildBarWallFixture, buildBarQuietScenario, buildBarBusyScenario, buildBarVolumeScenario } from '@/lib/stations/dev-fixture'

const NOW = Date.parse('2026-08-28T18:30:00.000Z')

/**
 * `?scenario=quiet` / `?scenario=busy` select the KDS-redesign scenarios; anything else keeps the
 * original twenty-table wall fixture so the existing proof images stay reproducible.
 */
function pickFixture(scenario: string | null, now: number) {
  if (scenario === 'quiet') return buildBarQuietScenario(now)
  if (scenario === 'busy') return buildBarBusyScenario(now)
  if (scenario === 'v20') return buildBarVolumeScenario(now, 20)
  if (scenario === 'v40') return buildBarVolumeScenario(now, 40)
  return buildBarWallFixture(now)
}

export default function DevBarPreviewPage() {
  const scenario = useSearchParams().get('scenario')
  return (
    <BarScreen
      rounds={pickFixture(scenario, NOW)}
      now={NOW}
      connectionState="live"
      onBump={async (lineIds) => ({ ok: true, total: lineIds.length, failedLineIds: [] })}
    />
  )
}
