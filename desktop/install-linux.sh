#!/usr/bin/env bash
# Legt einen Starter „Smart Home“ im Anwendungsmenü an, der das Dashboard
# als eigenes Fenster (ohne Browserleisten) öffnet. Funktioniert mit
# Chromium/Chrome/Brave/Edge – nativ oder als Flatpak (z. B. auf Bazzite).
#   ./install-linux.sh http://unraid:8480
set -euo pipefail
URL="${1:-http://tower.local:8480}"
DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$DIR" "$ICON_DIR"

BROWSER=""
for b in chromium chromium-browser google-chrome brave-browser microsoft-edge; do
  command -v "$b" >/dev/null 2>&1 && BROWSER="$b" && break
done
if [ -z "$BROWSER" ] && command -v flatpak >/dev/null 2>&1; then
  for app in org.chromium.Chromium com.google.Chrome com.brave.Browser com.microsoft.Edge; do
    flatpak info "$app" >/dev/null 2>&1 && BROWSER="flatpak run $app" && break
  done
fi
[ -z "$BROWSER" ] && { echo "Kein Chromium-basierter Browser gefunden."; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)/web/icons/icon-512.png"
[ -f "$SRC" ] && cp "$SRC" "$ICON_DIR/smart-home.png"

cat > "$DIR/smart-home.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Smart Home
Comment=Smart-Home-Übersicht und Werkstatt
Exec=$BROWSER --app=$URL --class=SmartHome --user-data-dir=$HOME/.local/share/smart-home-app
Icon=smart-home
Categories=Utility;Network;
StartupWMClass=SmartHome
DESK
update-desktop-database "$DIR" 2>/dev/null || true
echo "Fertig: „Smart Home“ im Anwendungsmenü ($BROWSER → $URL)"
