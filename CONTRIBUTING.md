# Contributing — database safety

## Linked Supabase CLI commands (mandatory guard)

**Never run these directly** (by hand, in scripts, or via agents):

```bash
supabase db query --linked ...
supabase migration repair --linked ...
```

These commands target whatever project is in `supabase/.temp/linked-project.json`, which is **independent** of `.env.test` / `.env.production.local`. A staging env check in a script does **not** protect `--linked` commands.

### Always use the guarded wrapper

```bash
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked ...
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> migration repair --linked ...
```

Or on Unix:

```bash
./scripts/safe-db.sh <expected-project-ref> db query --linked ...
```

### Project refs

| Environment | Ref |
|-------------|-----|
| Staging | `mdqjpxwczrhkxkbqatqa` |
| Production | `ihlmmpmolnpchzgwyhgh` |

### What the guard does

1. Requires an explicit `expected-project-ref` argument (no default).
2. Reads `supabase/.temp/linked-project.json` **immediately before** running the CLI command.
3. **Aborts** (non-zero exit, clear error) if `ref` ≠ `expected-project-ref`.
4. Only allows `db query --linked` and `migration repair --linked`.
5. Appends an audit line to `supabase/.temp/safe-supabase-linked-audit.log` on success.

### Before any linked DDL

```bash
npx supabase link --project-ref <expected-project-ref>
# optional: cat supabase/.temp/linked-project.json
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked -f ...
```

### TypeScript scripts

Import and call `runSafeSupabaseLinked` from `scripts/lib/safe-supabase-linked.ts` instead of shelling out to raw `supabase db query --linked`.
