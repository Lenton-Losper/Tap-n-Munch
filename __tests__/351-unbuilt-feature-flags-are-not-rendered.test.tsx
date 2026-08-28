/**
 * @jest-environment jsdom
 *
 * #351 — A SWITCH IS A PROMISE, AND `kitchen_enabled` PROMISED A PRODUCT THAT DOES NOT EXIST.
 *
 * `kitchen_enabled` was declared, persisted by two platform routes, typed in `feature-context`
 * with default `false`, labelled "Kitchen Display System" in the admin panel — and read by nothing.
 * Switching it on changed nothing observable. On production it was already `true` at one venue.
 *
 * The ruling was to hide it rather than write copy for it, so this test pins both halves of the
 * fix, because either half alone is a different defect:
 *
 *   HIDDEN   — the panel must not render a switch or a label for it. If it renders again, an
 *              operator is being promised a kitchen display again.
 *   RETAINED — it must stay in `FEATURE_FLAG_KEYS`. That list is what builds the column select in
 *              the admin page and the PATCH allowlist in the platform route, so dropping the key
 *              to "clean up" would quietly stop the column being read and written. Hiding a switch
 *              and deleting a column are not the same change.
 *
 * It MOUNTS the real panel rather than asserting over the constant, because the constant being
 * right is not the thing that matters — a panel that ignores it and maps `FEATURE_FLAG_KEYS`
 * directly would satisfy a constants-only test while rendering the switch. That is the exact
 * mutation this test was checked against.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/lib/onboarding/api-client', () => ({
  getAccessToken: jest.fn(async () => 'test-token'),
}))

import { FeatureFlagsPanel, FEATURE_FLAG_LABELS } from '@/app/admin/restaurants/[id]/feature-flags-panel'
import {
  FEATURE_FLAG_KEYS,
  OPERATOR_FEATURE_FLAG_KEYS,
  UNBUILT_FEATURE_FLAG_KEYS,
  type FeatureFlagsState,
} from '@/app/admin/restaurants/[id]/constants'

let container: HTMLDivElement
let root: Root

/** Every flag on, so a rendered switch cannot be missed for being in its default state. */
const allEnabled = FEATURE_FLAG_KEYS.reduce(
  (state, key) => ({ ...state, [key]: true }),
  {} as FeatureFlagsState,
)

function mountPanel() {
  act(() => {
    root.render(
      <FeatureFlagsPanel restaurantId="11111111-1111-1111-1111-111111111111" initialFeatures={allEnabled} />,
    )
  })
}

const switchIds = () =>
  Array.from(container.querySelectorAll('[role="switch"]')).map((el) => el.getAttribute('id'))

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('#351 the admin feature-flag panel renders only flags something reads', () => {
  test('kitchen_enabled — the flag #351 is about — renders no switch', () => {
    // NAMED LITERALLY, on purpose. Every other assertion in this file derives its expectation
    // from `UNBUILT_FEATURE_FLAG_KEYS`, so emptying that array re-renders the switch and leaves
    // them all vacuously green — the exact "checker that agrees with itself" failure. This one
    // and the next cannot be satisfied that way.
    mountPanel()
    expect(switchIds()).not.toContain('kitchen_enabled')
  })

  test('kitchen_enabled is still declared unbuilt', () => {
    expect(UNBUILT_FEATURE_FLAG_KEYS as readonly string[]).toContain('kitchen_enabled')
  })

  test('no switch is rendered for an unbuilt flag', () => {
    mountPanel()
    for (const key of UNBUILT_FEATURE_FLAG_KEYS) {
      expect(switchIds()).not.toContain(key)
    }
  })

  test('the "Kitchen Display System" label is gone from the rendered panel', () => {
    mountPanel()
    expect(container.textContent).not.toMatch(/kitchen/i)
  })

  test('every flag that is NOT unbuilt still renders exactly one switch', () => {
    mountPanel()
    const ids = switchIds()
    expect(ids.sort()).toEqual([...OPERATOR_FEATURE_FLAG_KEYS].sort())
    expect(ids).toHaveLength(FEATURE_FLAG_KEYS.length - UNBUILT_FEATURE_FLAG_KEYS.length)
  })

  test('hiding the switch did NOT drop the key from FEATURE_FLAG_KEYS', () => {
    // FEATURE_FLAG_KEYS drives the column select in app/admin/restaurants/[id]/page.tsx and the
    // PATCH allowlist in app/api/platform/restaurants/[id]/features/route.ts. The flag stays
    // readable and writable; only its operator-facing switch is withdrawn.
    for (const key of UNBUILT_FEATURE_FLAG_KEYS) {
      expect(FEATURE_FLAG_KEYS as readonly string[]).toContain(key)
    }
    expect(FEATURE_FLAG_KEYS).toHaveLength(12)
  })

  test('an unbuilt flag carries no label, so no copy promises it', () => {
    for (const key of UNBUILT_FEATURE_FLAG_KEYS) {
      expect(Object.keys(FEATURE_FLAG_LABELS)).not.toContain(key)
    }
    // and every switch that IS rendered has one
    for (const key of OPERATOR_FEATURE_FLAG_KEYS) {
      expect(FEATURE_FLAG_LABELS[key]).toBeTruthy()
    }
  })
})
