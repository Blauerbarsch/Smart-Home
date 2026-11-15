# Smart Home

Eigene Smart-Home-Übersicht für Browser, Handy und Linux-Desktop – läuft als ein
Docker-Container auf Unraid.

- **Kachel-Dashboard** für Home Assistant und ESPHome: Licht (Helligkeit, Farbe),
  Schalter, Sensoren mit Verlauf, Klima, Rollos, Medien, Kameras, Szenen, Listen.
  Kacheln frei verschieben (Maus und Touch), Größe ändern, kopieren, eigene Reiter anlegen.
- **Standorte**: Karte mit beliebig vielen Orten (Zuhause, Garten, Hütte …), jeweils
  mit zugeordneten HA-Sensoren und Mesh-Nodes; dazu HA-Zonen und Personen mit GPS.
- **Meshtastic** über MQTT: Nodes mit Position, Akku, Telemetrie (Temperatur, Feuchte,
  Luftdruck …), Verlauf, Funkverbindungen zwischen Nodes, Nachrichten lesen und senden.
- **Werkstatt** im animierten HUD-Stil: Bastelprojekte mit Aufgaben, Stückliste,
  Notizen (Markdown), Links und verknüpften Sensoren – plus **KI-Konsole** mit
  Claude (kann Home Assistant steuern und Projektaufgaben anlegen) und deinem
  lokalen **Kopf** (head-brain, Sprachausgabe über head-output, Kamera über head-vision).
- **Apps**: andere Dienste (Unraid, Grafana, Frigate …) als Kachel verlinken, im
  Fenster oder direkt in der Kachel einbetten.
- Als **App installierbar** (PWA) auf Android, iOS und Linux; ohne Internet nutzbar
  (Icons und Kartenbibliothek liegen lokal, nur die Kartenkacheln kommen aus dem Netz).

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
`ESPHOME_URL`, `MQTT_URL`, `MQTT_USER`, `MQTT_PASSWORD`, `MESH_TOPIC`, `PUID`/`PGID`
(Standard 99/100), `TZ`.

Daten liegen in `/data` (appdata): `config.json` (Einstellungen, Reiter, Kacheln,
Standorte), `projects.json`, `mesh.json` (Nodes und Verlauf), `sessions.json`.

## Verbindungen einrichten

### Home Assistant
Profil → Sicherheit → *Langlebiges Zugangstoken* erstellen und mit der Adresse
eintragen. Mit einem Admin-Token werden auch Räume angezeigt und durchsuchbar.

### ESPHome
Für die ESPHome-Kachel die Adresse des ESPHome-Dashboards eintragen
(Add-on oder Container, z. B. `http://192.168.1.10:6052`). Die Sensoren selbst
kommen wie gewohnt über Home Assistant.

### Meshtastic
1. MQTT-Broker bereitstellen (z. B. Mosquitto aus den Unraid-Community-Apps).
2. Auf einem Node mit WLAN/Ethernet (Gateway): *Module → MQTT* aktivieren,
   Broker-Adresse eintragen, **JSON output** einschalten.
3. Im genutzten Kanal **Uplink** aktivieren (zum Senden zusätzlich **Downlink**).
4. Im Dashboard unter Einstellungen den Broker eintragen. Zum Senden die Node-ID
   des Gateways (`!a1b2c3d4`) angeben.

Hinweis: Die JSON-Ausgabe gibt es nur auf ESP32-Geräten. Hängen deine Nodes an
nRF52-Gateways (RAK, T-Echo), nimm ein ESP32-Gerät als MQTT-Gateway.

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

**Wichtig:** In `local-ai/quadlet/*.container` sind die Ports nur an `127.0.0.1`
gebunden. Damit der Unraid-Server sie erreicht, z. B. in `head-brain.container`
`PublishPort=127.0.0.1:8100:8000` durch `PublishPort=8100:8000` ersetzen (ebenso für
head-output 8600 und head-vision 8400), danach `kopf-install` und Dienste neu starten.
Sicherer als die Freigabe im ganzen LAN: beide Geräte ins Tailnet (Tailscale) und
die Tailscale-IP des PCs eintragen.

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
