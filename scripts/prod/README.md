# Production scripts — run by the owner, with production credentials

Nothing in this directory has been run. This worktree has no production credentials, so every script
here is **prepared and unverified against production**. Each was smoke-tested against staging where
that was possible without changing anything; where it was not, the script says so and refuses rather
than guessing.

## The contract every script in here keeps

1. **It says what it is about to do, and against which database, before doing it.**
2. **It refuses rather than guesses.** Any precondition that cannot be established is a refusal, not
   a default.
3. **Read-only unless its name begins `apply-` or `delete-`.** The two that write say so in their
   first line of output and require an explicit `--confirm`.
4. **It prints the production project ref it connected to**, so a misconfigured env is visible in the
   first two lines rather than in the results.

## Credentials

Every script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment, and **refuses
unless the URL contains the production ref `ihlmmpmolnpchzgwyhgh`.** That guard is inverted from the
staging scripts on purpose: a staging script refusing to touch production and a production script
refusing to touch staging are different mistakes, and both are worth preventing.

```bash
# PowerShell
$env:SUPABASE_URL = "https://ihlmmpmolnpchzgwyhgh.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<production service role key>"

# bash
export SUPABASE_URL="https://ihlmmpmolnpchzgwyhgh.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<production service role key>"
```

Run every command from the repository root.

## The five, in the order worth running them

| # | script | writes? | what it answers |
|---|---|---|---|
| 5 | `probe-duplicate-charges.ts` | no | has a double charge already happened |
| 4 | `probe-terminal-versions.ts` | no | the production APK spread |
| 1 | `probe-324-orphan-orders.ts` | no | #324's three abort conditions |
| 2 | `delete-324-orphan-orders.ts` | **YES** | the delete, refused if any condition trips |
| 3 | `probe-333-abandoned-tabs.ts` | no | #333's production backlog |
| 6 | `apply-is-counter-service.ts` | **YES** | the two counter-service venues |

**5 and 4 first**, because they bear on the terminal decision and neither changes anything.
