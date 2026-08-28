'use client'

/**
 * Local visual QA only — the bar's half of what app/dev-kitchen-preview does, and it did not exist
 * before. That is not a coincidence: the bar screen was the one left behind when the kitchen was
 * rebuilt for distance, and nothing rendered it at volume for anyone to notice.
 *
 * No auth, no network, frozen clock — same terms as the kitchen preview, so the two screenshots in
 * docs/proof/ are comparable side by side.
 */
import { BarScreen } from '@/components/stations/bar-screen'
import { buildBarWallFixture } from '@/lib/stations/dev-fixture'

const NOW = Date.parse('2026-08-28T18:30:00.000Z')

export default function DevBarPreviewPage() {
  return (
    <BarScreen
      rounds={buildBarWallFixture(NOW)}
      now={NOW}
      connectionState="live"
      onBump={async (lineIds) => ({ ok: true, total: lineIds.length, failedLineIds: [] })}
    />
  )
}
