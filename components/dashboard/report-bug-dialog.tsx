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

export function ReportBugButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [bugDescription, setBugDescription] = useState('')
  const [name, setName] = useState('')

  const closeModal = () => {
    setOpen(false)
    setBugDescription('')
    setName('')
  }

  const submitBug = () => {
    const description = bugDescription.trim()
    if (!description) return

    const subject = encodeURIComponent('FlashTap Bug Report')
    const body = encodeURIComponent(
      `Bug description:\n${description}\n\nReported by: ${name.trim() || 'Anonymous'}\n\nDashboard URL: ${window.location.href}\nTime: ${new Date().toISOString()}`,
    )
    window.open(`mailto:llosperofficial@gmail.com?subject=${subject}&body=${body}`)
    closeModal()
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
              Describe what happened and we&apos;ll look into it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Textarea
              placeholder="What went wrong? What were you doing when it happened?"
              rows={4}
              value={bugDescription}
              onChange={(e) => setBugDescription(e.target.value)}
              className="border-[#E9E9E7] resize-none"
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
              className="border-[#E9E9E7]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitBug}
              disabled={!bugDescription.trim()}
              className="bg-[#37352F] text-white hover:bg-[#2a2824]"
            >
              Send Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
