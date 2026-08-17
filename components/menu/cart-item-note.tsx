'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { MessageSquarePlus } from 'lucide-react'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'

interface CartItemNoteProps {
  /** Cart row position — only used to keep label/textarea ids unique on the page. */
  index: number
  /** What the customer sees this row called, so two identical drinks stay distinguishable. */
  itemLabel: string
  value: string
  onChange: (next: string) => void
  /**
   * Fired when the customer finishes with the field, not on every keystroke.
   *
   * The note is part of a cart line's identity, so a note edit can turn this row into a copy
   * of another one and the two have to be folded together (#133). That fold cannot run from
   * onChange: it removes a row, and removing the row being typed into unmounts this textarea
   * mid-word the moment the text happens to match. So the caller reconciles here instead.
   */
  onCommit?: (next: string) => void
}

/**
 * Per-item note on the cart row.
 *
 * The item modal is the only other place this field exists, and browse quick-adds every item
 * without addons straight past it (variant-group drinks included), hardcoding an empty note.
 * Sending the customer back through the modal is not an option either: it renders no
 * variant-group UI, so it would drop selected_variants and reprice the line.
 *
 * Collapsed by default so a long cart stays scannable; a row that already carries a note
 * opens straight into the textarea, since seeing and correcting it matters more than tidiness.
 */
export function CartItemNote({ index, itemLabel, value, onChange, onCommit }: CartItemNoteProps) {
  const [expanded, setExpanded] = useState(Boolean(value))

  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(true)}
        aria-label={`Add a note for ${itemLabel}`}
        className="mt-1 h-8 px-0 font-sans text-sm text-muted-foreground hover:bg-transparent hover:text-foreground"
      >
        <MessageSquarePlus className="mr-1 h-4 w-4 stroke-[1.5]" />
        Add a note
      </Button>
    )
  }

  return (
    <div className="mt-2">
      <Label
        htmlFor={`item-note-${index}`}
        className="mb-1 block font-sans text-sm text-muted-foreground"
      >
        Note for this item
      </Label>
      <Textarea
        id={`item-note-${index}`}
        aria-label={`Note for ${itemLabel}`}
        placeholder="e.g. no sugar"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={MAX_INSTRUCTIONS_LENGTH}
        onBlur={(e) => onCommit?.(e.target.value)}
        rows={2}
        className="w-full max-w-full font-sans border-border text-sm"
      />
    </div>
  )
}
