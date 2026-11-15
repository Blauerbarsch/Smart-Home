# Smart Home

Eigene Smart-Home-Übersicht für Browser, Handy und Linux-Desktop – läuft als ein
Docker-Container auf Unraid.

- **Kachel-Dashboard** für Home Assistant und ESPHome: Licht (Helligkeit, Farbe),
  Schalter, Sensoren mit Verlauf, Klima, Rollos, Medien, Kameras, Szenen, Listen,
  JSON-APIs, Dienst-Status, 3D-Drucker (Klipper/Moonraker), GitHub, Alarme.
  Kacheln verschieben, Größe ändern, kopieren – und **bedingt einblenden**
  („nur zeigen, wenn Waschmaschine läuft“).
- **Grundriss**: eigenes Bild hochladen, Geräte darauf platzieren und antippen.
- **Server**: Unraid 7.2+ über die offizielle API – CPU, RAM, Array, Plattentemperaturen,
  alle **Docker-Container und VMs** starten/stoppen/neu starten, Container-Updates,
  Erreichbarkeit deiner Dienste.
- **Standorte**: Karte mit beliebig vielen Orten, deren HA-Sensoren und Mesh-Nodes,
  HA-Zonen und Personen.
- **Meshtastic** über MQTT – versteht das normale Protobuf-Format (auch verschlüsselt,
  LongFast automatisch, eigene Kanäle mit Schlüssel) und die JSON-Ausgabe. Nodes mit
  Hardware, Rolle, Firmware, Telemetrie-Verlauf (SQLite), Funkverbindungen auf der Karte,
  Traceroutes, Nachrichten und Direktnachrichten, **Netz-Analyse** (Pakete, Pakettypen,
  Hops, Kanalauslastung, Gateways, längste Verbindungen).
- **Alarme**: Regeln für Mesh-Nodes (offline, Akku, Temperatur …), HA-Werte, Dienste,
  Container/VMs. Benachrichtigung im Browser, als Push über die Home-Assistant-App,
  per ntfy oder Kopf spricht sie aus. HA- und Unraid-Meldungen landen in der Glocke.
- **Werkstatt** im animierten HUD-Stil: Projekte mit Aufgaben, Tagebuch mit Fotos,
  Stückliste (mit **InvenTree**-Lagerbestand), Notizen, Links, Sensoren, verknüpften
  Containern/VMs und **ESPHome-Geräten** (YAML bearbeiten, prüfen, kompilieren,
  OTA-Update, Logs). **Jedes GitHub-Repo wird automatisch ein Projekt** – mit Commits,
  Issues/PRs, Release, Build-Status und README.
- **KI-Konsole**: Claude und dein lokaler **Kopf** – beide mit Werkzeugen für Home
  Assistant, Unraid (Container/VMs), GitHub, Mesh, Teilelager und Projekte.
- **Geräteprofile & Wandtablet**: Reiter nur auf Handy/Tablet/PC/Wand zeigen,
  Wandtablet-Modus mit Bildschirmschoner, Nachtdimmung, Bildschirm bleibt an.
- **Update-Knopf**: zeigt neue Versionen an und aktualisiert den Container über die
  Unraid-API.
- Als **App installierbar** (PWA) auf Android, iOS und Linux.

Keine externen Node-Abhängigkeiten: Server und Oberfläche laufen mit Node 22 pur.

## Installation auf Unraid

**Variante A – Template (empfohlen):**

1. `unraid/smart-home.xml` nach `/boot/config/plugins/dockerMan/templates-user/` kopieren.
2. Docker → *Add Container* → Template „smart-home“ wählen.
3. Port (Standard 8480) und appdata-Pfad prüfen, optional Passwort setzen → *Apply*.
4. `http://<unraid-ip>:8480` öffnen und unter **Einstellungen** alles eintragen.

Das Image `ghcr.io/blauerbarsch/smart-home:latest` baut die GitHub Action bei jedem
Push auf `main` (amd64 und arm64). Nach dem ersten Lauf unter GitHub → *Packages* →
*smart-home* → *Package settings* die Sichtbarkeit auf **Public** stellen, sonst kann
Unraid es nicht ohne Login ziehen.

**Variante B – docker compose** (z. B. mit dem Compose-Manager-Plugin):

```bash
git clone https://github.com/Blauerbarsch/Smart-Home /mnt/user/appdata/smart-home-src
cd /mnt/user/appdata/smart-home-src && docker compose up -d --build
```

Alle Einstellungen lassen sich in der Oberfläche setzen. Umgebungsvariablen haben
Vorrang und sperren das jeweilige Feld: `APP_PASSWORD`, `HA_URL`, `HA_TOKEN`,
`ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `KOPF_URL`, `KOPF_OUTPUT_URL`, `KOPF_VISION_URL`,
`ESPHOME_URL`, `MQTT_URL`, `MQTT_USER`, `MQTT_PASSWORD`, `MESH_TOPIC`, `MESH_KEYS`,
`UNRAID_URL`, `UNRAID_API_KEY`, `GITHUB_USER`, `GITHUB_TOKEN`, `INVENTREE_URL`,
`INVENTREE_TOKEN`, `NTFY_URL`, `PUID`/`PGID`
(Standard 99/100), `TZ`.

Daten liegen in `/data` (appdata): `config.json` (Einstellungen, Reiter, Kacheln,
Standorte), `projects.json`, `history.db` (SQLite: Mesh-Verlauf, Alarme, Tagebuch),
`mesh.json` (Node-Zustand), `github.json`, `alerts.json`, `uploads/` (Fotos, Grundrisse).

## Verbindungen einrichten

### Unraid (Server-Reiter, Update-Knopf)
Unraid 7.2+: *Settings → Management Access → API Keys → Create*, Rolle **ADMIN**
(oder Lesen/Schreiben für Docker, VMs, Array, Info, Notifications). Im Dashboard unter
Einstellungen → Unraid die Adresse (`http://192.168.188.175`) und den Schlüssel eintragen.
Danach erscheinen Container und VMs im Reiter „Server“ und können Projekten zugeordnet
werden (z. B. Minecraft → VM „Linux“). Der Update-Knopf oben rechts erscheint, sobald
auf GitHub eine neuere Version liegt.

### GitHub
Benutzer ist voreingestellt (`Blauerbarsch`). Öffentliche Repos klappen ohne Token; für
private ein *Fine-grained token* mit Lesezugriff auf Contents, Metadata, Issues und
Actions eintragen. Neue Repos werden alle 30 Minuten automatisch als Projekt angelegt.
Ein gelöschtes Repo-Projekt wird nicht wieder angelegt.

### Benachrichtigungen
- **Home-Assistant-App**: Dienstname eintragen, z. B. `notify.mobile_app_pixel_8`.
- **ntfy** (optional): `https://ntfy.sh/dein-geheimes-thema` oder eigener Server.
- Im Browser: Glocke → „Im Browser erlauben“.
Regeln stellst du unter Einstellungen → Alarm-Regeln ein; zwei sind voreingestellt
(Mesh-Node 2 h offline, Mesh-Akku unter 20 %).

### Home Assistant
Profil → Sicherheit → *Langlebiges Zugangstoken* erstellen und mit der Adresse
eintragen. Mit einem Admin-Token werden auch Räume angezeigt und durchsuchbar.

### ESPHome
Für die ESPHome-Kachel die Adresse des ESPHome-Dashboards eintragen
(Add-on oder Container, z. B. `http://192.168.1.10:6052`). Die Sensoren selbst
kommen wie gewohnt über Home Assistant.

### Meshtastic
1. MQTT-Broker bereitstellen (z. B. Mosquitto aus den Unraid-Community-Apps).
2. Auf einem Node mit WLAN/Ethernet (Gateway): *Module → MQTT* aktivieren und die
   Broker-Adresse eintragen. Im genutzten Kanal **Uplink** aktivieren.
3. Im Dashboard unter Einstellungen den Broker eintragen. Fertig – das normale
   (verschlüsselte) Format wird direkt gelesen. Eigene Kanäle mit eigenem Schlüssel
   unter „Kanal-Schlüssel“ eintragen (`Name=Base64-Schlüssel`).
4. Zum **Senden** braucht es zusätzlich *JSON output* im MQTT-Modul (nur ESP32),
   **Downlink** im Kanal und die Node-ID des Gateways (`!a1b2c3d4`) in den Einstellungen.

Nodes, deren Position im Radius eines Standorts liegt, werden diesem automatisch
zugeordnet; feste Zuordnung geht im Standort-Editor.

### Claude
API-Key von console.anthropic.com eintragen. Modell änderbar
(Standard `claude-sonnet-5-5`). Mit „KI darf Smart Home steuern“ bekommt Claude
Werkzeuge zum Suchen und Schalten von Entitäten, zum Abfragen der Mesh-Nodes und
zum Anlegen von Aufgaben und Notizen im gerade offenen Projekt.

### Kopf (lokale KI)
Die Werkstatt spricht mit `head-brain` über dessen OpenAI-kompatible API
(`/v1/chat/completions`, Modell `head-memory`), liest `/health` der Dienste, holt
Kamerabilder von `head-vision` (`/snapshot.jpg`) und lässt über `head-output`
(`/speak`) vorlesen.

Die Ports sind im `local-ai`-Repo bereits freigegeben. Auf dem PC einmal:

```bash
cd ~/.config/local-ai && git pull && kopf-install
systemctl --user restart head-brain head-output head-vision
kopf-lan 192.168.188.175     # nur der Unraid-Server darf zugreifen (firewalld)
```

Mit „Kopf bekommt Werkzeuge“ kann Kopf im Dashboard auch Licht schalten, nach dem
Server sehen oder Projektaufgaben anlegen (Ollama-Tool-Calls über head-brain).

## Als App nutzen

- **Handy**: Seite öffnen → Browsermenü → *Zum Startbildschirm hinzufügen*.
- **Linux (Bazzite & Co.)**: `desktop/install-linux.sh http://<unraid-ip>:8480`
  legt einen Starter im Anwendungsmenü an, der das Dashboard in einem eigenen
  Fenster öffnet (Chromium/Chrome/Brave, auch als Flatpak). Alternativ in Chromium
  über das Installieren-Symbol in der Adressleiste.

Browser erlauben die Installation als App, den Service Worker und den Standort
(„Mein Standort“ auf der Karte) nur über **HTTPS**. Am einfachsten: Nginx Proxy
Manager oder SWAG auf Unraid mit einer lokalen Domain, oder `tailscale serve`.
Für den Zugriff von unterwegs Tailscale/WireGuard nutzen und das Dashboard nicht
offen ins Internet stellen – mindestens `APP_PASSWORD` setzen.

## Entwicklung

```bash
npm start            # http://localhost:8080, Daten in ./data
npm run dev          # mit Neustart bei Änderungen
```

| Pfad | Inhalt |
|---|---|
| `server/server.js` | HTTP-Server, Routen, Live-Ereignisse (SSE), Login |
| `server/db.js` | SQLite (Mesh-Verlauf, Pakete, Alarme, Dienst-Checks, Tagebuch) |
| `server/meshproto.js` | Meshtastic-Protobuf + AES-Entschlüsselung ohne Abhängigkeiten |
| `server/unraid.js` | Unraid-GraphQL-API (Container, VMs, Array, Update) |
| `server/github.js` | Repo-Abgleich, Auto-Projekte, Repo-Details, Update-Prüfung |
| `server/alerts.js`, `services.js` | Alarm-Regeln, Benachrichtigungen, Dienst-Checks |
| `server/maker.js` | Uploads, Tagebuch, InvenTree, ESPHome, Moonraker |
| `server/ha.js` | WebSocket-Verbindung zu Home Assistant |
| `server/mqtt.js`, `server/mesh.js` | MQTT-Client und Meshtastic-Auswertung |
| `server/ai.js` | Claude (mit Werkzeugen) und Kopf |
| `server/store.js` | Einstellungen, Layout, Projekte als JSON |
| `web/js/tiles.js` | alle Kacheltypen – neue Typen hier ergänzen |
| `web/js/grid.js`, `editor.js` | Raster, Ziehen, Kachel-Editor |
| `web/js/map.js` | Standorte, Karte, Mesh |
| `web/js/workshop.js`, `hud-bg.js` | Werkstatt und HUD-Animation |

Eingebunden: [Material Design Icons](https://pictogrammers.com/library/mdi/)
(Apache 2.0) und [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2), Karten © OpenStreetMap.
