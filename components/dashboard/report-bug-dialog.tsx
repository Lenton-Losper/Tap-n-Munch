'use client'

import { useState } from 'react'
import { Bug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { getAccessToken } from '@/lib/onboarding/api-client'
import { useToast } from '@/hooks/use-toast'

export function ReportBugButton({ className }: { className?: string }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [bugDescription, setBugDescription] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const closeModal = () => {
    if (submitting) return
    setOpen(false)
    setBugDescription('')
    setName('')
  }

  const submitBug = async () => {
    const description = bugDescription.trim()
    if (!description || submitting) return
    setSubmitting(true)
    try {
      const token = await getAccessToken()
      const res = await fetch('/api/bug-reports', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description,
          reporterName: name.trim() || undefined,
          pageUrl: typeof window !== 'undefined' ? window.location.href : undefined,
          area: 'Other',
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(payload.error || 'Failed to submit')
      }
      toast({
        title: 'Bug report submitted',
        description: 'FlashTap ops will review it in the platform console.',
      })
      setOpen(false)
      setBugDescription('')
      setName('')
    } catch (err) {
      toast({
        title: 'Could not submit report',
        description: err instanceof Error ? err.message : 'Try again',
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
        onClick={() => setOpen(true)}
        className={`h-auto w-full justify-start gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-[#6B675F] hover:bg-[#F1F0EC] hover:text-[#37352F] ${className || ''}`}
      >
        <Bug className="h-4 w-4 shrink-0" />
        Report a Bug
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : closeModal())}>
        <DialogContent className="border-[#E9E9E7] bg-white sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="font-serif text-xl text-[#37352F]">Report a Bug</DialogTitle>
            <DialogDescription className="text-[#6B675F]">
              Describe what happened and we&apos;ll look into it in the ops console.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Textarea
              placeholder="What went wrong? What were you doing when it happened?"
              rows={4}
              value={bugDescription}
              onChange={(e) => setBugDescription(e.target.value)}
              className="resize-none border-[#E9E9E7]"
            />
            <Input
              type="text"
              placeholder="Your name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="border-[#E9E9E7]"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={closeModal}
              disabled={submitting}
              className="border-[#E9E9E7]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitBug}
              disabled={!bugDescription.trim() || submitting}
              className="bg-[#37352F] text-white hover:bg-[#2a2824]"
            >
              {submitting ? 'Sending…' : 'Send Report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
