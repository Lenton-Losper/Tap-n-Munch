'use client'

/**
 * The Kitchen / Bar / Both chooser, with the consequence stated where the choice is made.
 *
 * Three surfaces used to render a bare three-word dropdown (create category, edit category, bulk
 * routing). "Both" reads as "show it on both screens"; it actually means the line is NOT Ready
 * until both stations have each bumped it. See lib/menu/category-routing.ts for the incident and
 * the production numbers.
 *
 * So: every option carries its meaning and its effect on Ready, and 'both' additionally requires
 * an explicit tick before the caller may save. The tick is not decoration — the API refuses an
 * unacknowledged 'both' write regardless of what this component does.
 */
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  BOTH_ROUTE_ACKNOWLEDGEMENT,
  CATEGORY_ROUTE_OPTIONS,
  categoryRouteNeedsAcknowledgement,
  categoryRouteOption,
  type CategoryRoute,
} from '@/lib/menu/category-routing'

/**
 * What happens when the destination changes: the new value is reported, and any previous
 * acknowledgement is RETRACTED.
 *
 * An acknowledgement belongs to the value it was given for. Without the retraction, a merchant who
 * ticks 'both', reconsiders, picks 'bar', then returns to 'both' would save a still-ticked box
 * they last read two decisions ago — which is the accidental 'both' this whole guard exists to
 * stop, arrived at by a longer route.
 *
 * Exported so it can be tested directly: Radix renders its option list in a portal, and a test
 * that cannot open the list would otherwise have to assert this by pretending.
 */
export function applyRouteChange(
  next: CategoryRoute,
  handlers: {
    onChange: (value: CategoryRoute) => void
    onAcknowledgedChange: (acknowledged: boolean) => void
  },
): void {
  handlers.onChange(next)
  handlers.onAcknowledgedChange(false)
}

export type CategoryRouteChoiceProps = {
  value: CategoryRoute
  onChange: (value: CategoryRoute) => void
  acknowledged: boolean
  onAcknowledgedChange: (acknowledged: boolean) => void
  /** Distinguishes the three instances so their checkbox ids and test ids do not collide. */
  idPrefix: string
  label?: string
}

export function CategoryRouteChoice({
  value,
  onChange,
  acknowledged,
  onAcknowledgedChange,
  idPrefix,
  label = 'Order goes to',
}: CategoryRouteChoiceProps) {
  const option = categoryRouteOption(value)
  const needsAck = categoryRouteNeedsAcknowledgement(value)

  return (
    <div className="space-y-2" data-testid={`${idPrefix}-route-choice`} data-route={value}>
      <Label htmlFor={`${idPrefix}-route`}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next: CategoryRoute) =>
          applyRouteChange(next, { onChange, onAcknowledgedChange })
        }
      >
        <SelectTrigger id={`${idPrefix}-route`}>
          <SelectValue placeholder="Select destination" />
        </SelectTrigger>
        <SelectContent>
          {CATEGORY_ROUTE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p
        className={`text-sm ${needsAck ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
        data-testid={`${idPrefix}-route-consequence`}
      >
        <span className="font-medium">{option.meaning}</span> {option.consequence}
      </p>

      {needsAck && (
        <label
          className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
          data-testid={`${idPrefix}-route-ack`}
        >
          <input
            type="checkbox"
            id={`${idPrefix}-route-ack-input`}
            className="mt-0.5 h-4 w-4 shrink-0"
            checked={acknowledged}
            onChange={(e) => onAcknowledgedChange(e.target.checked)}
          />
          <span>{BOTH_ROUTE_ACKNOWLEDGEMENT}</span>
        </label>
      )}
    </div>
  )
}

/**
 * Whether a save may proceed. Kept next to the component so all three call sites share one rule
 * rather than each re-deriving "is it both, and did they tick it".
 */
export function categoryRouteChoiceIsComplete(value: CategoryRoute, acknowledged: boolean): boolean {
  return !categoryRouteNeedsAcknowledgement(value) || acknowledged
}
