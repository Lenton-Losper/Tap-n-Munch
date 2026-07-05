import rolePermissionsConfigFile from './role-permissions.config.json'

export type RolePermissionsConfigFile = typeof rolePermissionsConfigFile
export type RoleSlugFromConfig = Exclude<keyof RolePermissionsConfigFile, '$comment'>

const { $comment: ROLE_PERMISSIONS_CONFIG_COMMENT, ...roleEntries } = rolePermissionsConfigFile

export { ROLE_PERMISSIONS_CONFIG_COMMENT }

/** Role slug → default permission list (excludes JSON `$comment`). */
export const ROLE_PERMISSIONS_BY_ROLE: Record<RoleSlugFromConfig, readonly string[]> = roleEntries

export function rolePermissionConfigEntries(): Array<[RoleSlugFromConfig, readonly string[]]> {
  return Object.entries(ROLE_PERMISSIONS_BY_ROLE) as Array<[RoleSlugFromConfig, readonly string[]]>
}

export function getRolePermissionsFromConfig(slug: string): readonly string[] | undefined {
  if (slug in ROLE_PERMISSIONS_BY_ROLE) {
    return ROLE_PERMISSIONS_BY_ROLE[slug as RoleSlugFromConfig]
  }
  return undefined
}
