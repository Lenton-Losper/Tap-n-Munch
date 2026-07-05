'use client'

import { useState } from 'react'
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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { PERMISSION_GROUPS } from '@/lib/restaurant-roles/permission-labels'
import type { Permission } from '@/lib/permissions'
import {
  createRestaurantRole,
  updateRestaurantRole,
  type RestaurantRole,
} from '@/components/staff/restaurant-roles-client'

export type RoleEditorMode = 'create' | 'edit' | 'view' | 'duplicate'

type RoleEditorDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: RoleEditorMode
  role?: RestaurantRole | null
  onSaved: () => void
}

function initialFormState(mode: RoleEditorMode, role?: RestaurantRole | null) {
  if (mode === 'create') {
    return { displayName: '', permissions: [] as Permission[], inviteEligible: false }
  }
  if (mode === 'duplicate' && role) {
    return {
      displayName: '',
      permissions: (role.permissions ?? []) as Permission[],
      inviteEligible: role.is_invite_eligible,
    }
  }
  if (role) {
    return {
      displayName: role.display_name,
      permissions: (role.permissions ?? []) as Permission[],
      inviteEligible: role.is_invite_eligible,
    }
  }
  return { displayName: '', permissions: [] as Permission[], inviteEligible: false }
}

function RoleEditorForm({
  mode,
  role,
  onOpenChange,
  onSaved,
}: {
  mode: RoleEditorMode
  role?: RestaurantRole | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const readOnly = mode === 'view'
  const initial = initialFormState(mode, role)
  const [displayName, setDisplayName] = useState(initial.displayName)
  const [permissions, setPermissions] = useState<Permission[]>(initial.permissions)
  const [inviteEligible, setInviteEligible] = useState(initial.inviteEligible)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const togglePermission = (key: Permission, enabled: boolean) => {
    if (readOnly) return
    setPermissions((prev) => {
      if (enabled) return prev.includes(key) ? prev : [...prev, key]
      return prev.filter((p) => p !== key)
    })
  }

  const handleSave = async () => {
    if (readOnly) return
    const trimmed = displayName.trim()
    if (!trimmed) {
      setError('Role name is required')
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (mode === 'edit' && role) {
        await updateRestaurantRole(role.role_slug, {
          display_name: trimmed,
          permissions,
          is_invite_eligible: inviteEligible,
        })
      } else {
        await createRestaurantRole({
          display_name: trimmed,
          permissions,
          is_invite_eligible: inviteEligible,
        })
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="space-y-5 py-2">
        <div className="space-y-2">
          <Label htmlFor="role-name">Role name</Label>
          <Input
            id="role-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={mode === 'duplicate' ? 'e.g. Head Chef' : 'e.g. Floor Manager'}
            disabled={readOnly || saving}
            readOnly={readOnly}
          />
          {role && mode !== 'create' && mode !== 'duplicate' && (
            <p className="text-xs text-muted-foreground">Slug: {role.role_slug}</p>
          )}
        </div>

        {!readOnly && (
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Invite eligible</p>
              <p className="text-xs text-muted-foreground">
                Allow inviting new staff directly into this role
              </p>
            </div>
            <Switch
              checked={inviteEligible}
              onCheckedChange={setInviteEligible}
              disabled={saving}
            />
          </div>
        )}

        {readOnly && (
          <div className="rounded-lg border p-3 text-sm">
            <span className="font-medium">Invite eligible: </span>
            {role?.is_invite_eligible ? 'Yes' : 'No'}
          </div>
        )}

        <div className="space-y-4">
          <p className="text-sm font-medium">Permissions</p>
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.domain} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.domain}
              </p>
              <div className="space-y-2">
                {group.permissions.map((perm) => {
                  const checked = permissions.includes(perm.key)
                  return (
                    <div
                      key={perm.key}
                      className="flex items-start justify-between gap-3 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{perm.label}</p>
                        <p className="text-xs text-muted-foreground">{perm.description}</p>
                      </div>
                      <Switch
                        checked={checked}
                        onCheckedChange={(on) => togglePermission(perm.key, on)}
                        disabled={readOnly || saving}
                        className="mt-0.5 shrink-0"
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : mode === 'edit' ? 'Save changes' : 'Create role'}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

export function RoleEditorDialog({
  open,
  onOpenChange,
  mode,
  role,
  onSaved,
}: RoleEditorDialogProps) {
  const formKey = `${mode}-${role?.id ?? 'new'}`

  const title =
    mode === 'create'
      ? 'Create Role'
      : mode === 'duplicate'
        ? `Duplicate ${role?.display_name ?? 'Role'}`
        : mode === 'edit'
          ? `Edit ${role?.display_name ?? 'Role'}`
          : role?.display_name ?? 'Role'

  const description =
    mode === 'view'
      ? 'System roles are read-only. Duplicate this role to create a customizable copy.'
      : mode === 'duplicate'
        ? 'Permissions are copied from the source role. Choose a new name for this custom role.'
        : 'Choose permissions and whether staff can be invited directly into this role.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {open ? (
          <RoleEditorForm
            key={formKey}
            mode={mode}
            role={role}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
