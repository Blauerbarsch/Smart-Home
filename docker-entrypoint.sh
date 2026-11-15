#!/bin/sh
# Läuft als PUID:PGID (Unraid-Standard 99:100 = nobody:users), damit die
# Dateien in appdata dem richtigen Benutzer gehören.
set -e
mkdir -p "${DATA_DIR:-/data}"
chown -R "${PUID:-99}:${PGID:-100}" "${DATA_DIR:-/data}" 2>/dev/null || true
exec su-exec "${PUID:-99}:${PGID:-100}" "$@"
