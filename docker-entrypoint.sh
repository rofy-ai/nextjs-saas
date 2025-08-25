#!/usr/bin/env bash
set -euo pipefail

APPSEED="${APPSEED:-/opt/appseed}"   # source baked into the image
WORKDIR="${WORKDIR:-/data}"          # mounted volume path
APP_ROOT="${APP_ROOT:-}"             # optional subdir under WORKDIR (e.g. apps/server)

echo "[entrypoint] WORKDIR=${WORKDIR}  APPSEED=${APPSEED}  APP_ROOT=${APP_ROOT:-<none>}"

# Wait until volume is mounted (defensive)
for i in {1..30}; do
  if grep -qs " ${WORKDIR} " /proc/mounts; then break; fi
  echo "[entrypoint] waiting for ${WORKDIR} mount…"
  sleep 1
done

mkdir -p "${WORKDIR}"

# Resolve where package.json should live
TARGET_ROOT="${WORKDIR}"
if [ -n "${APP_ROOT}" ]; then
  TARGET_ROOT="${WORKDIR}/${APP_ROOT}"
fi

# Seed only if there is no package.json at target
if [ ! -f "${TARGET_ROOT}/package.json" ]; then
  echo "[seed] package.json not found at ${TARGET_ROOT} → seeding from ${APPSEED}"
  mkdir -p "${TARGET_ROOT}"

  # Copy everything from APPSEED into WORKDIR without overwriting existing files
  # `/.` ensures dotfiles are included
  cp -an "${APPSEED}/." "${WORKDIR}/"

  # Verify seed produced package.json
  if [ ! -f "${TARGET_ROOT}/package.json" ]; then
    echo "[seed][ERROR] Still no package.json at ${TARGET_ROOT}"
    echo "[seed] Listing ${TARGET_ROOT}:"
    ls -la "${TARGET_ROOT}" || true
    echo "[seed] Listing ${WORKDIR}:"
    ls -la "${WORKDIR}" || true
    echo "[seed] Listing ${APPSEED}:"
    ls -la "${APPSEED}" || true
    exit 1
  fi
  echo "[seed] done"
else
  echo "[seed] package.json exists at ${TARGET_ROOT} → skipping seed"
fi

# Run the given command from the correct directory
if [ -n "${APP_ROOT}" ]; then
  cd "${TARGET_ROOT}"
else
  cd "${WORKDIR}"
fi

echo "[entrypoint] pwd=$(pwd) → exec: $*"
exec "$@"
