'use client'

import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Copy, Monitor, Plus, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'

type TerminalRow = {
  id: string
  label: string
  sn: string | null
  device_id: string | null
  is_active: boolean
  activated_at: string | null
  last_seen_at: string | null
  has_pending_code: boolean
}

async function getAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Session expired. Please sign in again.')
  return token
}

function formatLastSeen(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Never'
  return formatDistanceToNow(date, { addSuffix: true })
}

export function TerminalsSection() {
  const { toast } = useToast()
  const [terminals, setTerminals] = useState<TerminalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [activationCode, setActivationCode] = useState<string | null>(null)
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null)
  const [codeDialogOpen, setCodeDialogOpen] = useState(false)

  const loadTerminals = useCallback(async () => {
    try {
      setLoading(true)
      const token = await getAccessToken()
      const response = await fetch('/api/admin/terminals', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to load terminals')
      }
      setTerminals(payload.terminals || [])
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load terminals',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadTerminals()
  }, [loadTerminals])

  const handleGenerateCode = async () => {
    try {
      setGenerating(true)
      const token = await getAccessToken()
      const response = await fetch('/api/admin/terminals/generate-code', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to generate activation code')
      }
      setActivationCode(payload.activationCode)
      setCodeExpiresAt(payload.expiresAt)
      setCodeDialogOpen(true)
      await loadTerminals()
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate code',
        variant: 'destructive',
      })
    } finally {
      setGenerating(false)
    }
  }

  const handleCopyCode = async () => {
    if (!activationCode) return
    try {
      await navigator.clipboard.writeText(activationCode)
      toast({ title: 'Copied', description: 'Activation code copied to clipboard.' })
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Could not copy to clipboard.',
        variant: 'destructive',
      })
    }
  }

  const handleRemove = async (terminalId: string) => {
    try {
      setRemovingId(terminalId)
      const token = await getAccessToken()
      const response = await fetch(`/api/admin/terminals/${encodeURIComponent(terminalId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to remove terminal')
      }
      setTerminals((prev) => prev.filter((terminal) => terminal.id !== terminalId))
      toast({ title: 'Removed', description: 'Terminal removed successfully.' })
    } catch (error: unknown) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to remove terminal',
        variant: 'destructive',
      })
    } finally {
      setRemovingId(null)
    }
  }

  const registeredTerminals = terminals

  return (
    <>
      <div className="bg-card border rounded-lg p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
              <Monitor className="h-5 w-5" />
              Terminals
            </h2>
            <p className="text-sm text-muted-foreground">
              Register FlashTap POS devices for your restaurant. Generate an activation code and
              enter it on the terminal.
            </p>
          </div>
          <Button
            onClick={handleGenerateCode}
            disabled={generating}
            className="shrink-0 bg-[#FF6B35] hover:bg-[#e55a28]"
          >
            <Plus className="h-4 w-4 mr-2" />
            {generating ? 'Generating...' : 'Add Terminal'}
          </Button>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading terminals...</p>
        ) : registeredTerminals.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No terminals registered yet.
              <br />
              Generate an activation code to add your first terminal.
            </p>
            <Button
              onClick={handleGenerateCode}
              disabled={generating}
              variant="outline"
              className="mt-4"
            >
              Generate Activation Code
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {registeredTerminals.map((terminal) => (
              <div
                key={terminal.id}
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{terminal.label}</p>
                    <Badge variant={terminal.is_active ? 'default' : 'secondary'}>
                      {terminal.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                    {terminal.has_pending_code ? (
                      <Badge variant="outline">Pending activation</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Last seen: {formatLastSeen(terminal.last_seen_at)}
                  </p>
                  {terminal.sn ? (
                    <p className="text-xs text-muted-foreground">SN: {terminal.sn}</p>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRemove(terminal.id)}
                  disabled={removingId === terminal.id}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {removingId === terminal.id ? 'Removing...' : 'Remove'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Activation Code</DialogTitle>
            <DialogDescription>
              Enter this code in your FlashTap POS app. This code expires in 1 hour.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border bg-muted/40 px-4 py-6 text-center">
            <p className="font-mono text-3xl font-semibold tracking-widest">
              {activationCode}
            </p>
            {codeExpiresAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Expires {new Date(codeExpiresAt).toLocaleString()}
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={handleCopyCode}>
              <Copy className="h-4 w-4 mr-2" />
              Copy Code
            </Button>
            <Button onClick={() => setCodeDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
