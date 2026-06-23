'use client'

import { useState } from 'react'
import { Bug } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { supabase } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

const BUG_AREAS = ['Orders', 'Payments', 'Menu', 'Tabs', 'Other'] as const

type BugReportButtonProps = {
  className?: string
}

export function BugReportButton({ className }: BugReportButtonProps) {
  const { restaurant, restaurantId } = useAuth()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [area, setArea] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const currentRestaurantId = String((restaurant as { id?: string } | null)?.id || restaurantId || '')

  const resetForm = () => {
    setDescription('')
    setArea('')
  }

  const handleOpenChange = (next: boolean) => {
    if (submitting) return
    setOpen(next)
    if (!next) resetForm()
  }

  const handleSubmit = async () => {
    const trimmed = description.trim()
    if (!trimmed) {
      toast({
        title: 'Description required',
        description: 'Please describe the issue before submitting.',
        variant: 'destructive',
      })
      return
    }

    if (!currentRestaurantId) {
      toast({
        title: 'Unable to submit',
        description: 'Restaurant information is not loaded. Please refresh and try again.',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      const { error } = await supabase.from('bug_reports').insert({
        restaurant_id: currentRestaurantId,
        description: trimmed,
        area: area || null,
      })

      if (error) throw error

      toast({
        title: 'Report submitted',
        description: 'Thank you — we will look into it.',
      })
      setOpen(false)
      resetForm()
    } catch (err) {
      toast({
        title: 'Failed to submit report',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(
          'h-9 gap-1.5 text-xs font-normal text-[#6B675F] hover:text-[#37352F] hover:bg-[#F1F0EC]',
          className
        )}
      >
        <Bug className="h-3.5 w-3.5" />
        Report a Bug
      </Button>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report a Bug</DialogTitle>
            <DialogDescription>
              Tell us what went wrong so we can fix it. Reports are sent to the FlashTap team.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="bug-description">Describe the issue</Label>
              <Textarea
                id="bug-description"
                placeholder="What went wrong? What were you doing when it happened?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                disabled={submitting}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bug-area">Area affected (optional)</Label>
              <Select
                value={area || undefined}
                onValueChange={setArea}
                disabled={submitting}
              >
                <SelectTrigger id="bug-area" className="w-full">
                  <SelectValue placeholder="Select an area" />
                </SelectTrigger>
                <SelectContent>
                  {BUG_AREAS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit Report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
