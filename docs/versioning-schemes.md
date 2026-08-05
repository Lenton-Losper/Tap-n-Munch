# Versioning across web, terminal and TMS

Resolves #140, which recorded "three unreconciled version schemes" and could not map between
them. Established 2026-08-05 against the live repos.

**There are not three schemes. There are two, plus a display of one of them.**

## The mapping

| Artifact | Scheme | Current value |
|---|---|---|
| Terminal `android/app/build.gradle` | `versionCode` — integer, authoritative | `78` |
| Terminal `versionName` | derived label, `"1." + (versionCode - 1)` | `1.77` |
| Finatic TMS "FlashTap Terminal" | **displays the uploaded APK's `versionName`** | not independently verifiable, see below |
| Web `package.json` | never-bumped stub, rendered nowhere | `0.1.1` |
| Web deployed build | commit SHA | per deploy |

### `versionName` is derived from `versionCode`

    versionName = "1." + zeroPad(versionCode - 1, 2)

Verified against **every** commit that has touched `android/app/build.gradle` — 19 of them,
with no exceptions:

| vc | vn | | vc | vn | | vc | vn |
|---|---|---|---|---|---|---|---|
| 1 | 1.0 | | 35 | 1.34 | | 73 | 1.72 |
| 19 | 1.18 | | 36 | 1.35 | | 74 | 1.73 |
| 21 | 1.20 | | 37 | 1.36 | | 75 | 1.74 |
| 27 | 1.26 | | 38 | 1.37 | | 76 | 1.75 |
| 28 | 1.27 | | 45 | 1.44 | | 77 | 1.76 |
| 29 | 1.28 | | 60 | 1.59 | | 78 | 1.77 |
| | | | 61 | 1.60 | | | |

`vc=1 -> 1.0` is the only case not zero-padded to two digits.

### This explains the 2026-08-01 confusion

The audit saw the local checkout at `1.60` and TMS at `1.72`, and concluded that either the
checkout was not what was deployed or TMS numbered differently.

**TMS numbers the same way.** `1.72` is `versionCode 73` — which is precisely the
`wip/payment-backup-jul29` build that #149 independently identifies as `vc=73`. The local
checkout was simply 12 versionCodes behind what had been uploaded.

The rule also holds for the build whose source is still missing: #149 records that APK as
`vc=70 / 1.69`, and `"1." + (70 - 1)` is `1.69`. So a TMS version number can always be
converted to a versionCode, and vice versa, without needing the source.

## Web is versioned by commit SHA, not by `package.json`

`package.json` `version` is `0.1.1` and has never been bumped. It is **not** rendered anywhere
in `app/`, `lib/` or `components/` — searched, zero hits.

Web's real deployed identity is the commit SHA, injected as `NEXT_PUBLIC_COMMIT_SHA` /
`GIT_COMMIT_SHA` by both `staging.yml` and `production-worker.yml` and served by
`app/api/version/route.ts`:

    GET /api/version  ->  { "commit": "<sha>" }

This is the right mechanism for a continuously deployed web app, and there is no value in
reconciling it to the terminal's number — they ship independently. **Do not bump
`package.json` to "match" the terminal.** If the stub is ever a nuisance, remove the field
rather than maintain it.

## "What is actually running on live terminals"

#140 states this is the real question. It is already answered in-product, without reference to
any of the above.

Terminals report `APP_VERSION` on every heartbeat (`src/screens/OrdersScreen.tsx` ->
`sendHeartbeat`), which is stored on `terminals.app_version` and rendered at:

- `/admin/terminals` — a column per terminal
- `/admin/restaurants/[id]` — alongside each terminal's last-seen time

That value is the `versionName`, so apply the mapping above to get the versionCode. This is
authoritative for what is *installed and reporting*, which TMS is not — TMS shows what was
*uploaded*.

## Standing rule when building a terminal APK

Bump all of these in step, in the same commit:

1. `versionCode` in `android/app/build.gradle`
2. `versionName` in `android/app/build.gradle`, per the formula above
3. `APP_VERSION` in `src/constants/index.ts`
4. The Settings screen render (`src/screens/SettingsScreen.tsx`)

`APP_VERSION` is also read by `DiagnosticsScreen.tsx` and by the heartbeat, so a missed bump
silently misreports every terminal in the admin UI. As of `vc78` all four are consistent
at `1.77`.

## What is NOT verified here

- **What TMS currently displays.** No access to the Finatic portal from this environment. The
  last APK built for production and archived locally is
  `releases/production/flashtap-production-vc76-v1.75.apk` (2026-08-03); `vc77` and `vc78`
  exist in the terminal repo and in `releases/staging/`. Whether any of those were uploaded is
  a portal question.
- The mapping rule is derived from committed history. It is a convention, not enforced by any
  check. Nothing fails a build that breaks it.
