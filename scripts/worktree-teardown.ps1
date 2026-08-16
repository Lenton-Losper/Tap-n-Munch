<#
.SYNOPSIS
  Remove a git worktree without destroying the shared node_modules it is junctioned to. (#267)

.DESCRIPTION
  On Windows, `git worktree remove` DESCENDS INTO an NTFS junction instead of unlinking it, and
  recursively deletes the contents of the target. Verified on this machine, git 2.51.2.windows.1:
  a junction target went from 7 entries to 0, `git worktree remove --force` exited 0, and nothing
  in its output mentioned node_modules.

  That matters more than the deletion, which is recoverable. Every agent sharing the checkout is
  running jest/tsc/eslint against a half-deleted toolchain for as long as nobody notices, and any
  BASELINE measured in that window is silently wrong -- which makes a real regression look like a
  wash, or a clean branch look broken.

  The junction itself is not the mistake and must not be removed as a practice: a worktree without
  node_modules makes `npx tsc --noEmit` silently download and run tsc@2.0.4, which exits 0 on
  essentially any input. That is a false green on the most load-bearing gate there is.

  So the ordering is the fix, and this script owns it:
    1. drop any node_modules junction LINK-ONLY (`cmd /c rmdir`, never a recursive delete)
    2. then `git worktree remove`
    3. then re-count the shared target and FAIL LOUDLY if it shrank

  Step 3 is the part that catches the case that will actually happen: somebody forgetting.

.PARAMETER Path
  The worktree to remove.

.PARAMETER Force
  Passed through to `git worktree remove` for a dirty worktree.

.PARAMETER SimulateUnsafeRemoval
  SELF-TEST ONLY. Skips step 1, reproducing the defect so anyone can confirm the hazard still
  exists on their git version rather than trusting this docblock. Step 3 then reports the damage
  instead of hiding it. Never use this to actually remove a worktree.

.EXAMPLE
  powershell -File scripts/worktree-teardown.ps1 -Path ../i220
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [switch]$Force,
  [switch]$SimulateUnsafeRemoval
)

$ErrorActionPreference = 'Stop'

function Get-EntryCount([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return -1 }
  return (Get-ChildItem -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue |
          Measure-Object).Count
}

function Test-IsJunction([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $item = Get-Item -LiteralPath $dir -Force
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

if (-not (Test-Path -LiteralPath $Path)) { throw "No such worktree: $Path" }
$worktree = (Resolve-Path -LiteralPath $Path).Path
$nm = Join-Path $worktree 'node_modules'

# The shared install we must protect. Resolved through the junction BEFORE anything is touched,
# because after the link is dropped there is nothing left to ask.
$sharedTarget = $null
$before = -1
if (Test-IsJunction $nm) {
  $sharedTarget = (Get-Item -LiteralPath $nm -Force).Target | Select-Object -First 1
  $before = Get-EntryCount $sharedTarget
  Write-Host "shared node_modules: $sharedTarget"
  Write-Host "entries before:      $before"
} elseif (Test-Path -LiteralPath $nm) {
  Write-Host "node_modules is a REAL directory in this worktree, not a junction."
  Write-Host "Nothing shared is at risk; git will delete it with the worktree."
} else {
  Write-Host "no node_modules in this worktree"
}

if ($SimulateUnsafeRemoval) {
  Write-Host ''
  Write-Host 'SELF-TEST: skipping the junction drop on purpose, to reproduce #267.'
} elseif ($sharedTarget) {
  # rmdir on a junction removes the LINK and leaves the target alone. Remove-Item -Recurse would
  # not; that is the whole defect, wearing PowerShell clothes.
  cmd /c rmdir "$nm" | Out-Null
  if (Test-Path -LiteralPath $nm) { throw "failed to drop the junction at $nm" }
  $afterUnlink = Get-EntryCount $sharedTarget
  if ($afterUnlink -lt $before) {
    throw "dropping the junction changed the target ($before -> $afterUnlink). Stopping."
  }
  Write-Host "junction dropped link-only; target still $afterUnlink entries"
}

$gitArgs = @('worktree', 'remove')
if ($Force) { $gitArgs += '--force' }
$gitArgs += $worktree
Write-Host ''
Write-Host "git $($gitArgs -join ' ')"
& git @gitArgs
$removeExit = $LASTEXITCODE
Write-Host "git worktree remove exit: $removeExit"

if ($sharedTarget) {
  $after = Get-EntryCount $sharedTarget
  Write-Host "entries after:       $after"
  if ($after -lt $before) {
    Write-Host ''
    Write-Host "TOOLCHAIN DAMAGED: $sharedTarget went from $before to $after entries."
    Write-Host 'Every gate result measured from now until this is repaired is UNRELIABLE.'
    Write-Host 'Repair: cmd /c rmdir any surviving junction links, git worktree prune, npm ci,'
    Write-Host 'then RE-RUN the whole gate. Do not trust a result from the damaged window.'
    exit 1
  }
  Write-Host 'shared node_modules intact.'
}

exit $removeExit
