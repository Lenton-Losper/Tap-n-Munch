#!/usr/bin/env bash
#
# Build the staging APK, then PROVE the file on disk is the one this run produced.
#
# ============================================================================================
# WHY THE PROOF IS PART OF THE BUILD
# ============================================================================================
#
# 2026-09-02: a staging APK was reported as versionCode 118 / 2.17 while the file the device
# management system was pushing read 107 / 2.06 — six days old. Both statements were true. They
# were different files, in different git worktrees of the same repo:
#
#   D:\RN\FlashTapTerminal    feat/menu-item-availability   2.06   <- what TMS was pointed at
#   D:\RN\ft-settle-control   feat/service-settle-control   2.17   <- where the build ran
#
# `BUILD SUCCESSFUL` says a build succeeded. It does not say WHICH directory now holds a fresh
# artifact, and it cannot say whether the file someone else is about to ship is that one. The same
# shape as `docker info` exiting 0 while the engine was down: a green signal that answers a
# different question from the one being asked.
#
# So this records a timestamp BEFORE gradle runs and refuses to report success unless the packaged
# APK is newer than that mark. A file that predates the build is a stale file, whatever the build
# said.
#
# ============================================================================================
# AND THE VERSION IS READ OUT OF THE PACKAGED FILE
# ============================================================================================
#
# Not from android/app/build.gradle, and not from the merged manifest in build/intermediates.
# Those are the INPUT and an INTERMEDIATE; both can be correct while the packaged artifact is
# months old. `aapt2 dump badging` parses the binary manifest inside the .apk zip — the thing that
# actually gets installed.
#
# Usage:
#   bash scripts/build-staging-apk.sh            # build, then verify
#   bash scripts/build-staging-apk.sh --verify   # verify the existing artifact only
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
APK="$REPO_ROOT/android/app/build/outputs/apk/staging/release/app-staging-release.apk"
VERIFY_ONLY="${1:-}"

: "${ANDROID_HOME:=/d/dev/android-sdk}"
export ANDROID_HOME
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/d/dev/gradle-home}"

echo "=== where this build is happening ==="
echo "  worktree : $REPO_ROOT"
echo "  branch   : $(git rev-parse --abbrev-ref HEAD)"
echo "  commit   : $(git rev-parse --short HEAD)"
echo "  declared : APP_VERSION $(grep -oE "APP_VERSION = '[^']+'" src/constants/index.ts | grep -oE "[0-9.]+")" \
     "/ versionName $(grep -oE 'versionName "[^"]+"' android/app/build.gradle | grep -oE '[0-9.]+')" \
     "/ versionCode $(grep -oE 'versionCode [0-9]+' android/app/build.gradle | grep -oE '[0-9]+')"
echo "  (declared = the INPUT. What ships is asserted from the packaged file below.)"

# The mark. Anything not newer than this did not come from this run.
BUILD_START_EPOCH=$(date +%s)
PREVIOUS_SHA=""
if [ -f "$APK" ]; then
  PREVIOUS_SHA=$(sha256sum "$APK" | cut -d' ' -f1)
  echo
  echo "  an APK already exists here:"
  echo "    mtime  : $(date -d "@$(stat -c %Y "$APK")" '+%Y-%m-%d %H:%M:%S')"
  echo "    sha256 : ${PREVIOUS_SHA:0:16}…"
fi

if [ "$VERIFY_ONLY" != "--verify" ]; then
  echo
  echo "=== gradlew assembleStagingRelease ==="
  ( cd android && ./gradlew assembleStagingRelease --no-daemon -g "$GRADLE_USER_HOME" )
fi

echo
echo "=== THE FILE ON DISK ==="
if [ ! -f "$APK" ]; then
  echo "FAIL: no APK at $APK"
  exit 1
fi

APK_EPOCH=$(stat -c %Y "$APK")
APK_SHA=$(sha256sum "$APK" | cut -d' ' -f1)
echo "  path   : $APK"
echo "  size   : $(stat -c %s "$APK") bytes"
echo "  mtime  : $(date -d "@$APK_EPOCH" '+%Y-%m-%d %H:%M:%S')"
echo "  sha256 : $APK_SHA"

if [ "$VERIFY_ONLY" != "--verify" ]; then
  if [ "$APK_EPOCH" -lt "$BUILD_START_EPOCH" ]; then
    echo
    echo "FAIL: the APK is OLDER than this build run."
    echo "  build started : $(date -d "@$BUILD_START_EPOCH" '+%Y-%m-%d %H:%M:%S')"
    echo "  apk modified  : $(date -d "@$APK_EPOCH" '+%Y-%m-%d %H:%M:%S')"
    echo "Gradle reported success but did not repackage. Do not ship this file."
    exit 1
  fi
  if [ -n "$PREVIOUS_SHA" ] && [ "$PREVIOUS_SHA" = "$APK_SHA" ]; then
    echo
    echo "NOTE: the APK is byte-identical to the one that was here before."
    echo "  That is legitimate for a no-op rebuild, and it is NOT legitimate if you changed"
    echo "  something. Check the commit above is the one you meant to build."
  fi
fi

# ── the version that will actually install ──────────────────────────────────
AAPT="$(ls -t "$ANDROID_HOME"/build-tools/*/aapt2* 2>/dev/null | head -1)"
if [ -z "$AAPT" ]; then
  echo
  echo "FAIL: no aapt2 under $ANDROID_HOME/build-tools — cannot read the packaged manifest,"
  echo "so the version cannot be asserted. Refusing to report success."
  exit 1
fi

BADGING="$("$AAPT" dump badging "$APK" 2>/dev/null | grep -m1 '^package')"
echo
echo "=== read OUT OF THE PACKAGED APK (not build.gradle, not intermediates) ==="
echo "  $BADGING"

PKG_CODE=$(echo "$BADGING" | grep -oE "versionCode='[0-9]+'" | grep -oE '[0-9]+')
PKG_NAME=$(echo "$BADGING" | grep -oE "versionName='[^']+'" | sed "s/versionName='//;s/'//")
SRC_CODE=$(grep -oE 'versionCode [0-9]+' android/app/build.gradle | grep -oE '[0-9]+')
SRC_NAME=$(grep -oE 'versionName "[^"]+"' android/app/build.gradle | grep -oE '[0-9.]+')

if [ "$PKG_CODE" != "$SRC_CODE" ] || [ "$PKG_NAME" != "$SRC_NAME" ]; then
  echo
  echo "FAIL: the packaged APK does not match the source."
  echo "  source   : versionCode $SRC_CODE / versionName $SRC_NAME"
  echo "  packaged : versionCode $PKG_CODE / versionName $PKG_NAME"
  echo "This is the stale-artifact case. Do not ship this file."
  exit 1
fi

echo
echo "PASS — packaged versionCode $PKG_CODE / versionName $PKG_NAME, matching source."
echo
echo "SHIP THIS EXACT PATH. There is more than one worktree of this repo on this machine,"
echo "and each has its own build/outputs. Point the device manager at the path above, not at"
echo "whichever worktree it used last:"
echo "  $APK"
