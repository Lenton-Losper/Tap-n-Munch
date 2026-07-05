'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Copy, Lock, Pencil, Plus, Trash2, Users } from 'lucide-react'
import {
  RoleEditorDialog,
  type RoleEditorMode,
} from '@/components/staff/role-editor-dialog'
import {
  deleteRestaurantRole,
  fetchRestaurantRoles,
  type RestaurantRole,
} from '@/components/staff/restaurant-roles-client'

export function RolesPageContent() {
  const { toast } = useToast()
  const [roles, setRoles] = useState<RestaurantRole[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<RoleEditorMode>('create')
  const [editorRole, setEditorRole] = useState<RestaurantRole | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RestaurantRole | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchRestaurantRoles()
      setRoles(data)
    } catch {
      toast({ title: 'Failed to load roles', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional deps-triggered data fetch
    void load()
  }, [load])

  const openEditor = (mode: RoleEditorMode, role?: RestaurantRole) => {
    setEditorMode(mode)
    setEditorRole(role ?? null)
    setEditorOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteRestaurantRole(deleteTarget.role_slug)
      toast({ title: `Deleted role "${deleteTarget.display_name}"` })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast({
        title: 'Cannot delete role',
        description: err instanceof Error ? err.message : 'Delete failed',
        variant: 'destructive',
      })
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/staff" className="hover:underline">
              Staff
            </Link>
            <span>/</span>
            <span>Roles</span>
          </div>
          <h1 className="text-2xl font-bold">Roles & Permissions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage custom roles and control what each role can access.
          </p>
        </div>
        <Button onClick={() => openEditor('create')}>
          <Plus className="mr-2 h-4 w-4" />
          Create Role
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>Role</span>
          <span className="w-24 text-center">Assigned</span>
          <span className="w-44 text-right">Actions</span>
        </div>
        {roles.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">No roles found.</p>
        )}
        {roles.map((role) => {
          const assigned = role.assigned_count ?? 0
          const canDelete = !role.is_system && assigned === 0
          const deleteDisabledReason = role.is_system
            ? 'System roles cannot be deleted'
            : assigned > 0
              ? `${assigned} staff member${assigned === 1 ? '' : 's'} assigned — reassign first`
              : null

          return (
            <div
              key={role.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{role.display_name}</p>
                  {role.is_system && (
                    <Badge variant="secondary" className="gap-1">
                      <Lock className="h-3 w-3" />
                      System
                    </Badge>
                  )}
                  {role.is_invite_eligible && !role.is_system && (
                    <Badge variant="outline">Invite eligible</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{role.role_slug}</p>
              </div>
              <div className="flex w-24 items-center justify-center gap-1 text-sm text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {assigned}
              </div>
              <div className="flex w-44 justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditor(role.is_system ? 'view' : 'edit', role)}
                  title={role.is_system ? 'View system role' : 'Edit role'}
                >
                  <Pencil className="mr-1 h-3.5 w-3.5" />
                  {role.is_system ? 'View' : 'Edit'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditor('duplicate', role)}
                  title="Duplicate role"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                {!role.is_system && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={!canDelete}
                    title={deleteDisabledReason ?? 'Delete role'}
                    onClick={() => canDelete && setDeleteTarget(role)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <RoleEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        mode={editorMode}
        role={editorRole}
        onSaved={async () => {
          await load()
          toast({ title: 'Role saved' })
        }}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete role?</DialogTitle>
            <DialogDescription>
              Permanently delete &quot;{deleteTarget?.display_name}&quot;. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
