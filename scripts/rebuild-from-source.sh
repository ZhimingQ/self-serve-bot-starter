#!/bin/sh
# Rebuild this storefront from its own source/ and switch to the new build.
#
# A storefront installed by "Deploy via your bot" runs a PREBUILT copy; its
# editable source ships beside it in source/. The owner's bot changes code there
# and runs this script, which:
#   1. installs dependencies in source/ (skipped when package files are unchanged),
#   2. builds the standalone server while the live site keeps serving,
#   3. swaps ONLY the built app files in (server.js, package.json, node_modules,
#      .next, public, scripts); .env, branding.json, data/, start.js, install.sh
#      and assistant-instructions.txt are never touched,
#   4. restarts the pm2 process and waits for /api/health to answer "ok":true,
#   5. puts the previous build back and restarts again if it does not.
#
# Takes a few minutes (measured 2026-10-22 at 1 CPU / 2 GB: ~35s install, ~2min
# build). Run it in the background and read rebuild.log:
#   nohup sh scripts/rebuild-from-source.sh > rebuild.log 2>&1 &
# Exit 0 = the new build is live and passed its health check. Anything else =
# it failed or was interrupted; the previous build is put back (best effort,
# and the log's last [rebuild] line says whether that worked).
set -eu

APP="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$APP/source"
SLUG="$(basename "$APP")"
NEW="$APP/.rebuild-new"
PREV="$APP/.rebuild-prev"
LOCK="$APP/.rebuild-lock"
APP_FILES="server.js package.json node_modules .next public scripts"

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -z "${PM2_HOME:-}" ]; then
  if [ -d /opt/data/home/.pm2 ]; then export PM2_HOME=/opt/data/home/.pm2
  elif [ -d /home/node/.openclaw/.pm2 ]; then export PM2_HOME=/home/node/.openclaw/.pm2
  fi
fi

say() { echo "[rebuild] $*"; }
test -f "$SRC/package.json" || { say "no source/ next to this storefront; nothing to build"; exit 2; }
mkdir "$LOCK" 2>/dev/null || { say "another rebuild is running (remove $LOCK if it is stale)"; exit 3; }
# Once the swap starts, any exit that is not the committed success path (an
# error, a kill, a closed shell) puts the previous build back.
SWAPPING=0
on_exit() {
  rc=$?
  trap '' INT TERM HUP  # the restore below must not be cut short
  if [ "$SWAPPING" = 1 ]; then
    if [ "$rc" = 5 ]; then rollback "the new build did not start or did not answer /api/health"
    else rollback "the rebuild was interrupted while switching builds"; fi
    SWAPPING=0; rc=5
  fi
  rm -rf "$LOCK" "$NEW"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# The build shares this container's memory limit with the bot itself. If it ran
# the container out of memory the kernel could kill the bot instead of the
# build, so refuse to start without room for it (anonymous memory only: page
# cache is given back on demand and would make a healthy container look full).
NEED_MB=900  # measured peak with one build worker: ~500MB (2026-10-22)
if [ -r /sys/fs/cgroup/memory.max ] && [ "$(cat /sys/fs/cgroup/memory.max)" != max ]; then
  max_mb=$(( $(cat /sys/fs/cgroup/memory.max) / 1048576 ))
  anon_mb=$(( $(awk '$1 == "anon" { print $2 }' /sys/fs/cgroup/memory.stat) / 1048576 ))
  if [ $((max_mb - anon_mb)) -lt "$NEED_MB" ]; then
    say "not enough free memory to build safely (${anon_mb}MB of ${max_mb}MB in use, the build needs ~${NEED_MB}MB); nothing was changed"
    exit 6
  fi
fi

# Build with a clean environment, like the central build: the bot's own keys
# must never be visible to (or inlined by) the storefront build.
clean() { env -i PATH="$PATH" HOME="${HOME:-/tmp}" LANG=C.UTF-8 "$@"; }
NICE=""; if command -v nice >/dev/null 2>&1; then NICE="nice -n 10"; fi

cd "$SRC"
STAMP="$(cat package.json package-lock.json 2>/dev/null | cksum | cut -d' ' -f1)"
if [ -d node_modules ] && [ "$(cat node_modules/.install-stamp 2>/dev/null)" = "$STAMP" ]; then
  say "dependencies unchanged"
else
  say "installing dependencies"
  if [ -f package-lock.json ]; then INSTALL="npm ci"; else INSTALL="npm install"; fi
  clean $INSTALL --no-audit --no-fund --loglevel=error || { say "installing dependencies failed (errors above); the old build is still live"; exit 4; }
  echo "$STAMP" > node_modules/.install-stamp
fi

say "building"
rm -rf .next/standalone
# Leave room for the bot itself in a 2 GB container.
clean STOREFRONT_STANDALONE=1 STOREFRONT_BUILD_CPUS=1 NODE_OPTIONS="--max-old-space-size=1024" NEXT_TELEMETRY_DISABLED=1 $NICE npm run build \
  || { say "the build failed (errors above); fix them and run this again. The old build is still live"; exit 4; }
test -f .next/standalone/server.js || { say "build produced no server.js; the old build is still live"; exit 4; }

# Assemble exactly as scripts/build-storefront-artifact.sh does for an install.
rm -rf "$NEW"; mkdir -p "$NEW/.next" "$NEW/scripts"
cp -a .next/standalone/. "$NEW/"
cp -a .next/static "$NEW/.next/static"
if [ -d public ]; then cp -a public "$NEW/public"; fi
cp scripts/reset-password.mjs scripts/rebuild-from-source.sh "$NEW/scripts/"
rm -f "$NEW/.env" "$NEW/.env.local" "$NEW/.env.production" "$NEW/.env.production.local"

# Moves the app files of build $1 into place and keeps the replaced ones in $2.
# Returns non-zero on the first failed move; the caller then swaps back.
# INSTALLED lists every path actually moved in from $1, so a rollback removes
# exactly those, including one the previous build never had (e.g. public/).
INSTALLED=""
swap_in() {
  for f in $APP_FILES; do
    if [ -e "$APP/$f" ]; then mv "$APP/$f" "$2/$f" || return 1; fi
    # Recorded before the move, so a signal between the two cannot hide it.
    if [ -e "$1/$f" ]; then INSTALLED="$INSTALLED $f"; mv "$1/$f" "$APP/$f" || return 1; fi
  done
}

# Puts back every app file found in $1, whatever state a failed swap left.
restore_from() {
  for f in $APP_FILES; do
    if [ -e "$1/$f" ]; then rm -rf "$APP/$f" && mv "$1/$f" "$APP/$f"; fi
  done
}

healthy() {
  url="$(node --env-file="$APP/.env" -e 'process.stdout.write(process.env.APP_URL || "")')"
  [ -n "$url" ] || return 1
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS --connect-timeout 2 --max-time 5 "$url/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

restart_app() { pm2 restart "$SLUG" --update-env >/dev/null 2>&1 && pm2 save >/dev/null 2>&1; }

rollback() {
  set +e  # best effort: one failed move must not stop the rest of the restore
  say "$1; putting the previous build back"
  BAD="$APP/.rebuild-failed"
  rm -rf "$BAD"; mkdir -p "$BAD"
  for f in $INSTALLED; do
    if [ -e "$APP/$f" ]; then mv "$APP/$f" "$BAD/$f"; fi
  done
  restore_from "$PREV"
  if restart_app && healthy; then say "previous build is live again (failed build kept in .rebuild-failed)"; else say "previous build did not answer either; check: pm2 logs $SLUG"; fi
}

# The backup dir must be empty before anything moves, or a restore could mix
# an older backup into the live files.
rm -rf "$PREV" && mkdir "$PREV" || { say "could not prepare $PREV; the old build is still live"; exit 7; }

say "switching to the new build"
SWAPPING=1
if swap_in "$NEW" "$PREV" && restart_app && healthy; then
  trap '' INT TERM HUP  # committed: nothing may report this as a failure now
  SWAPPING=0
  { echo "rebuilt=$(date -u +%FT%TZ) from source/" >> "$APP/ARTIFACT_INFO.txt"; } 2>/dev/null || say "note: could not record the rebuild in ARTIFACT_INFO.txt"
  say "done: the new build is live (previous build kept in .rebuild-prev)"
  exit 0
fi
exit 5  # SWAPPING is still 1: the EXIT trap puts the previous build back
