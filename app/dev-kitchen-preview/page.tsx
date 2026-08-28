'use client'

/**
 * Local visual QA only — renders KitchenScreen against the dev fixture, no auth, no network.
 * lib/stations/dev-fixture.ts's own docblock: "safe to import from a page for local visual
 * checking." Not linked from anywhere in the real app; not a route a terminal or a manager ever
 * reaches.
 */
import { KitchenScreen } from '@/components/stations/kitchen-screen'
import { buildKitchenFixture } from '@/lib/stations/dev-fixture'

const NOW = Date.parse('2026-08-28T04:00:00.000Z')

export default function DevKitchenPreviewPage() {
  return (
    <KitchenScreen
      lines={buildKitchenFixture(NOW)}
      now={NOW}
      connectionState="live"
      onMarkCooked={() => {}}
      onMarkReadyToRun={() => {}}
    />
  )
}
