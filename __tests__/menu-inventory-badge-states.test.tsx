/**
 * Runs in the default node environment: renderToStaticMarkup is a server render and needs
 * MessageChannel, which jsdom does not provide.
 *
 * The Menu Management inventory badge must distinguish four states, and must never render
 * nothing for an item whose stock is quietly being deducted.
 *
 * Background: a merchant reported "Redbull" showing 🟢 Inventory Ready while its stock item
 * showed "Not tracked", and read that as a failed link. The link was fine — the two screens
 * meant different things by "tracked". Separately, an item with tracking switched OFF but a
 * live recipe rendered NO badge at all while still deducting on every sale.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { MenuItemInventoryBadge } from '@/components/menu/menu-item-inventory-badge'
import type { InventorySetupData } from '@/lib/recipes/queries'

function setup(over: Partial<InventorySetupData> = {}): InventorySetupData {
  return {
    total: 0,
    configured: 0,
    missing: 0,
    missingItems: [],
    readyMenuItemIds: [],
    linkedButUntrackedIds: [],
    ...over,
  }
}

const item = (id: string, track: boolean | undefined) =>
  ({ id, name: `item-${id}`, track_inventory: track }) as never

function render(node: React.ReactElement) {
  return renderToStaticMarkup(node)
}

describe('MenuItemInventoryBadge', () => {
  it('shows Inventory Ready when tracking is on and ingredients are configured', () => {
    // This is Redbull's real state: track_inventory true, active recipe, one ingredient.
    // The badge was always correct here — the confusion came from the Stock screen.
    const html = render(
      <MenuItemInventoryBadge item={item('a', true)} setup={setup({ readyMenuItemIds: ['a'] })} />,
    )
    expect(html).toContain('Inventory Ready')
  })

  it('shows Inventory Missing when tracking is on but nothing is configured', () => {
    const html = render(<MenuItemInventoryBadge item={item('b', true)} setup={setup()} />)
    expect(html).toContain('Inventory Missing')
  })

  it('warns when tracking is OFF but the item is still linked and still deducting', () => {
    const html = render(
      <MenuItemInventoryBadge
        item={item('c', false)}
        setup={setup({ linkedButUntrackedIds: ['c'] })}
      />,
    )
    expect(html).toContain('Linked')
    expect(html).toContain('not tracked')
    // The part that actually costs money must be stated somewhere the merchant can find it.
    expect(html).toMatch(/continue to deduct|still.*deduct/i)
  })

  it('never claims readiness for an untracked item', () => {
    const html = render(
      <MenuItemInventoryBadge
        item={item('c', false)}
        setup={setup({ linkedButUntrackedIds: ['c'] })}
      />,
    )
    expect(html).not.toContain('Inventory Ready')
  })

  it('renders nothing for an item that is genuinely not linked at all', () => {
    // No badge is correct here: tracking off, no recipe, nothing is happening to stock.
    expect(render(<MenuItemInventoryBadge item={item('d', false)} setup={setup()} />)).toBe('')
    expect(render(<MenuItemInventoryBadge item={item('d', undefined)} setup={setup()} />)).toBe('')
  })

  it('renders nothing when setup has not loaded, rather than guessing', () => {
    expect(render(<MenuItemInventoryBadge item={item('a', true)} setup={null} />)).toBe('')
  })

  it('keeps the four states mutually exclusive', () => {
    const ready = render(
      <MenuItemInventoryBadge item={item('a', true)} setup={setup({ readyMenuItemIds: ['a'] })} />,
    )
    const untracked = render(
      <MenuItemInventoryBadge item={item('a', false)} setup={setup({ linkedButUntrackedIds: ['a'] })} />,
    )
    expect(ready).not.toContain('not tracked')
    expect(untracked).not.toContain('Inventory Ready')
    expect(untracked).not.toContain('Inventory Missing')
  })
})
