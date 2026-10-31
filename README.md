# Open Paragliders Network

> One live-tracking server for every paragliding app. Developers: start with the
> [integration guide](public/docs/INTEGRATION.md) and the [protocol](public/docs/PROTOCOL.md).

Un seul serveur de livetracking pour tous les logiciels de vol libre : chaque pilote envoie sa position, tous
reçoivent en direct les pilotes autour d'eux **avec leur trace**, et rien ne se perd quand le réseau coupe.
Une carte de back-office montre et filtre toutes les traces en ligne.

Le direct demande un processus qui tourne en permanence (WebSocket), donc un VPS plutôt qu'un hébergement mutualisé.

## Ce qu'il fait

| | |
|---|---|
| Envoi | HTTP (`POST /api/v1/points`, par lots, gzip accepté) ou WebSocket (point par point). Renvoyer un lot déjà reçu est sans risque (doublons ignorés) : le client vide sa file seulement quand le serveur a répondu. Un arriéré après une coupure (2 h de vol) passe en un envoi. |
| Réception | WebSocket poussé toutes les `every` s (1 s au plus vite, 3 s par défaut), ou HTTP (`GET /api/v1/live`). Un pilote vu pour la première fois arrive **avec sa trace** (10 min par défaut) ; ensuite seulement les points nouveaux. |
| Coupures | Chaque mise à jour porte un curseur (`seq`). Reconnecté avec `since`, le client reçoit exactement ce qu'il a manqué. Les points envoyés en retard par un pilote revenu dans le réseau sont transmis aussi et comblent sa trace chez tous. Liaison muette détectée des deux côtés (ping). |
| Pilotes | Prénom, nom, voile, type d'aéronef, logiciel : visibles des autres. Pas de compte : l'appareil choisit un identifiant et un secret, réservés au premier envoi. « Oublie-moi » efface tout. |
| Historique | 72 h, puis effacé. Base bornée (`MAX_DB_MB`) et place libre gardée sur le disque (`MIN_FREE_DISK_MB`) : au-delà, les plus vieux points sont réécrits (la place libérée sert aux suivants, le fichier ne grossit plus). |
| Lien de suivi | Un lien par pilote (`/p/<jeton>`), permanent, à partager aux proches : une carte en direct de ce seul pilote, 24 h au plus, sans appli ni compte. Le pilote peut le régénérer : l'ancien cesse de marcher tout de suite. Le jeton est tiré par l'appareil, le serveur n'en garde que l'empreinte. |
| Back-office | `/admin/` : carte MapLibre de toutes les traces, avec le fond Terrain de WS Nav (teinte d'altitude, ombrage, courbes de niveau) et le relief en 3D où les pilotes et leurs traces sont à leur altitude réelle (bouton 2D / 3D), période de 30 min à 72 h ou personnalisée, suivi en direct, recherche (nom, voile, logiciel, appareil), filtres type / vu depuis / altitude, couleur par pilote ou par altitude, fiche pilote, trace complète, export GPX, blocage, effacement ; état de la base et du disque. |
| Autres logiciels | Doc publique servie par le serveur (`/docs/` : [guide d'intégration](public/docs/INTEGRATION.md), [protocole](public/docs/PROTOCOL.md), [client d'exemple](public/docs/example.mjs)), GeoJSON (`/api/v1/live.geojson`), et **compatibilité LiveTrack24** : XCSoar, LK8000… envoient sans changement en réglant l'adresse du serveur. |

Technique : Node.js 24, TypeScript exécuté tel quel (sans compilation), SQLite intégré à Node (`node:sqlite`, mode
WAL), une seule dépendance (`ws`). Un processus tient des milliers de pilotes : la fenêtre du direct (1 h) est en
mémoire, la base ne sert qu'à l'historique et au redémarrage.

## Lancer

```bash
npm install
ADMIN_TOKEN=un-mot-de-passe npm run dev     # http://localhost:8080/admin/
npm run sim -- http://localhost:8080 12      # 12 pilotes simulés autour d'Annecy, avec des coupures réseau
npm run check                                # types + tests
```

**Essayer avec un téléphone, sur le même réseau ou non** : `npm run local`. Lance le serveur et un tunnel Cloudflare
gratuit et sans compte (`winget install Cloudflare.cloudflared`), puis affiche l'adresse à coller dans l'appli, avec
la clé, et le mot de passe du back-office (aussi dans `data/local.txt`). Clé et mot de passe sont gardés d'un lancement
à l'autre ; l'adresse du tunnel change à chaque fois, donc les liens de suivi aussi : pour l'essai seulement.

## Configuration (variables d'environnement)

| Variable | Défaut | |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `DATA_DIR` | `./data` | dossier de la base `live.db` |
| `APP_KEYS` | vide | clés des logiciels : `wsnav:clé1,xcsoar:clé2`. **Vide = serveur ouvert à tous** (développement) |
| `ADMIN_TOKEN` | vide | mot de passe du back-office ; vide = fermé |
| `CONTACT` | vide | où demander une clé de logiciel, public dans `GET /api/v1` |
| `RETENTION_HOURS` | `72` | historique gardé |
| `MAX_DB_MB` | `2048` | place maximale des points |
| `MIN_FREE_DISK_MB` | `500` | place libre gardée sur le disque |
| `LIVE_WINDOW_MIN` | `60` | trace gardée en mémoire ; reprise possible après une coupure de moins de cette durée |
| `PUSH_EVERY` / `MIN_PUSH_EVERY` | `3` / `1` | période d'envoi aux abonnés par défaut / la plus courte permise (s) |
| `DEFAULT_TRAIL_S` | `600` | trace envoyée avec un pilote nouveau (s) |
| `LT24` | `1` | compatibilité LiveTrack24 |
| `TRUST_PROXY` | `0` | `1` derrière Caddy / nginx (IP du client dans `X-Forwarded-For`) |
| `PILOT_TTL_DAYS` | `90` | un pilote sans aucun point depuis ce délai est oublié |
| `RATE_HTTP_PER_MIN`, `MAX_WS_PER_IP`, `MAX_BATCH` | `600`, `20`, `5000` | limites |

## Déployer (VPS)

Un petit VPS suffit (1 vCPU, 1–2 Go de RAM, 20 Go de disque), sous Debian par exemple, avec un sous-domaine
(enregistrement A/AAAA vers le VPS).

**Docker (conseillé)** — Caddy devant, HTTPS automatique :

```bash
git clone https://github.com/alexandre-pereira/open-paragliders-network.git && cd open-paragliders-network
cp deploy/.env.example deploy/.env      # domaine, APP_KEYS (openssl rand -hex 24), ADMIN_TOKEN (openssl rand -base64 32)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Mise à jour : `git pull && docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build`. Les
clients WebSocket se reconnectent seuls avec leur curseur ; au redémarrage, la mémoire du direct est rechargée depuis
la base (les clients reçoivent une image complète, `reset`).

**Sans Docker** : Node 24, `deploy/open-paragliders-network.service` (systemd) et Caddy (`deploy/Caddyfile`, remplacer `live:8080`
par `127.0.0.1:8080`) ou nginx avec `proxy_read_timeout 1h` et les en-têtes `Upgrade` / `Connection`.

Sauvegarde : inutile pour un historique de 72 h ; la base se reconstruit avec les envois suivants. Les identifiants
d'appareils réservés sont dans la même base.

## Brancher un logiciel

- **WS Nav** : Menu › Trafic & live › Open Paragliders Network › Adresse du serveur (`https://…/?key=…`), ou au build
  (`VITE_LIVE_SERVER`), voir le dépôt `ws-nav`.
- **XCSoar / LK8000** : suivi LiveTrack24, serveur = le nom de domaine, utilisateur et mot de passe au choix (réservés
  au premier usage).
- **Tout autre logiciel** : `https://<serveur>/docs/` (en anglais, pour les développeurs d'autres apps).

## Organisation

```
src/config.ts    variables d'environnement
src/fix.ts       point : validation, format compact, zones
src/profile.ts   profil du pilote
src/store.ts     SQLite : pilotes, points (anneau 72 h / place), sessions LiveTrack24
src/live.ts      mémoire du direct : traces récentes, journal, curseurs, mises à jour par abonné
src/service.ts   appareils et secrets, envoi, oubli, blocage, entretien chaque minute
src/http.ts      API HTTP, back-office, fichiers
src/ws.ts        WebSocket
src/lt24.ts      LiveTrack24
public/admin/    carte du back-office (basemap.js : fond et relief, air3d.js : pilotes en l'air en 3D)
public/track/    page d'un lien de suivi
public/docs/     doc des développeurs, servie à /docs/
test/            tests (node --test)
tools/simulate.ts pilotes simulés
tools/local.ts   essai depuis ce PC avec un tunnel
```
