#!/usr/bin/env node
/**
 * `git worktree remove` FOLLOWS A JUNCTIONED node_modules AND DELETES THE SHARED INSTALL. (#267)
 *
 * On 2026-08-11 this destroyed ~530 packages in `restaurant-menu-screen/node_modules` — jest,
 * next, eslint, react, @babel/*, @types/* — while other agents were running tests against it.
 *
 * ============================================================================================
 * WHY THE JUNCTION EXISTS, AND WHY REMOVING THE PRACTICE IS NOT THE ANSWER
 * ============================================================================================
 *
 * A git worktree has no `node_modules`. Without one, `npx tsc --noEmit` does NOT fail — npx
 * silently downloads and runs `tsc@2.0.4`, which exits 0 on essentially any input. That is a
 * false green on the most load-bearing gate in the repo, so the practice is to junction the
 * shared install into each worktree and confirm `npx tsc --version` prints 5.9.3 first.
 *
 * The junction is the fix for a worse problem. So this guards the REMOVAL instead.
 *
 * ============================================================================================
 * WHAT THIS DOES
 * ============================================================================================
 *
 *   node scripts/safe-worktree-remove.mjs <worktree-path> [--force]
 *
 * 1. Refuses outright if the path is not a registered git worktree.
 * 2. If `node_modules` inside it is a junction / symlink / reparse point, UNLINKS the link first
 *    — never recursing into it — and reports the target it was pointing at.
 * 3. Only then runs `git worktree remove`.
 *
 * The unlink is the whole safety property: once the link is gone, `git worktree remove` has
 * nothing to follow.
 *
 * FAILS CLOSED. Any uncertainty about whether node_modules is a link is treated as "it is a
 * link", because the cost of being wrong in that direction is one manual `rmdir` and the cost of
 * being wrong in the other is 530 packages and three agents' test runs.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readlinkSync, unlinkSync, rmdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const force = args.includes('--force')
const target = args.find((a) => !a.startsWith('--'))

if (!target) {
  console.error('usage: node scripts/safe-worktree-remove.mjs <worktree-path> [--force]')
  process.exit(2)
}

const path = resolve(target)
const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

// ---------------------------------------------------------------- 1. is it really a worktree?
let registered = []
try {
  registered = git(['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => resolve(l.slice('worktree '.length).trim()))
} catch (err) {
  console.error(`REFUSING: could not list worktrees — ${err.message}`)
  process.exit(1)
}

if (!registered.includes(path)) {
  console.error(`REFUSING: ${path} is not a registered git worktree.`)
  console.error('Registered:')
  for (const r of registered) console.error(`  ${r}`)
  process.exit(1)
}

if (registered[0] === path) {
  console.error(`REFUSING: ${path} is the MAIN worktree, not a linked one.`)
  process.exit(1)
}

// ------------------------------------------------- 2. unlink a junctioned node_modules, if any
const nm = join(path, 'node_modules')

if (existsSync(nm)) {
  let st
  try {
    st = lstatSync(nm)
  } catch (err) {
    console.error(`REFUSING: cannot stat ${nm} — ${err.message}`)
    console.error('Treating an unreadable node_modules as a link. Remove it by hand and re-run.')
    process.exit(1)
  }

  // isSymbolicLink() covers POSIX symlinks AND Windows junctions created by `mklink /J`.
  if (st.isSymbolicLink()) {
    let pointsAt = '(unresolved)'
    try {
      pointsAt = readlinkSync(nm)
    } catch {
      // Non-fatal: we still unlink. Knowing the target is for the log, not the decision.
    }
    console.log(`node_modules in this worktree is a LINK -> ${pointsAt}`)
    console.log('Unlinking it first, so `git worktree remove` has nothing to follow.')
    try {
      unlinkSync(nm)
    } catch {
      // Windows junctions to directories sometimes need rmdir rather than unlink.
      try {
        rmdirSync(nm)
      } catch (err2) {
        console.error(`REFUSING: could not unlink the junction — ${err2.message}`)
        console.error('Remove it by hand before removing the worktree. Do NOT use -rf on it.')
        process.exit(1)
      }
    }
    console.log('unlinked. The shared install it pointed at is untouched.')
  } else {
    console.log('node_modules is a real directory here, not a link — nothing shared to protect.')
  }
} else {
  console.log('no node_modules in this worktree.')
}

// ---------------------------------------------------------------- 3. now remove the worktree
const removeArgs = ['worktree', 'remove', path]
if (force) removeArgs.splice(2, 0, '--force')

try {
  git(removeArgs)
  console.log(`removed worktree ${path}`)
} catch (err) {
  console.error(`git worktree remove failed: ${err.message}`)
  console.error('The junction (if any) is already unlinked, so re-running is safe.')
  process.exit(1)
}
