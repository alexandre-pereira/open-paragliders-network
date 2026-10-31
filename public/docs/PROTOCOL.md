# Open Paragliders Network — protocol v1

Open live-tracking protocol for free-flight software (paragliders, hang gliders, sailplanes). The aim is one network
shared by every flight app: a pilot sees the pilots around them whatever app each of them uses. Any app can **send**
its pilot's position and **receive** the other pilots, with their recent track, over a link that drops often
(mountains, valleys, a phone in a pocket).

New here? Start with the [integration guide](#integration).

Design goals, in order:

1. **Nothing lost on a network cut.** Uploads are idempotent (re-sending is always safe). Downloads are resumable from
   a cursor (`seq`): after a cut the client gets exactly what it missed, without re-downloading everything.
2. **As fast as possible.** One WebSocket for both directions, pushed updates (no polling), compact arrays,
   `permessage-deflate`. HTTP is there too, for apps that cannot keep a socket open.
3. **Simple to implement.** JSON only, a dozen fields.

Base URL: `https://<server>` (given with your app key). Everything is UTF-8 JSON. Times are Unix
seconds (UTC). CORS is open.

---

## 1. Concepts

### Application key

Each flight app gets a key from the server operator (`GET /api/v1` gives their `contact`). Send it in the `X-App-Key`
header (HTTP), or in the `hello` message (WebSocket), or as `?key=` (WebSocket URL, only when headers are impossible).
`GET /api/v1` tells whether a key is required (`appKeyRequired`).

### Device and secret — no account

A device identifies itself with:

| field | rule |
|---|---|
| `device` | chosen by the app once, stored forever: 6–80 chars `[A-Za-z0-9_.:@-]`. Prefix it with your app name: `xctrack-3f9a2c71` |
| `secret` | random, generated once by the app and kept **private** (16–200 chars). Never shown to the pilot |

The first upload **claims** the `device`; later uploads must carry the same `secret` (otherwise `403 device-taken`).
Nobody else can write under that pilot's name. Lost secret → generate a new `device`.

The server answers with a public pilot id (`pilot`, a short numeric string). That id — never the `device` — is what
other pilots see.

### Fix (point)

On the wire a fix is a compact array:

```
[t, lat, lon, alt, spd, crs, vz]
```

| # | name | unit | notes |
|---|---|---|---|
| 0 | `t` | Unix s | **time of the GPS fix** (GNSS time when sane), not the time of sending. Milliseconds accepted on upload |
| 1 | `lat` | ° WGS84 | |
| 2 | `lon` | ° WGS84 | |
| 3 | `alt` | m | GPS altitude above mean sea level, or `null` |
| 4 | `spd` | m/s | ground speed, or `null` |
| 5 | `crs` | ° true | track, or `null` |
| 6 | `vz` | m/s | vertical speed, or `null` |

Uploads may also use objects: `{ "t": …, "lat": …, "lon": …, "alt": …, "spd": …, "crs": …, "vz": … }` (aliases:
`ts`, `time`, `lng`, `speed`, `course`, `track`, `vspeed`, `vario`).

A fix is rejected (counted in `bad`) when its time is more than 2 min in the future or older than the history
(`retentionH`, 72 h), or its position is impossible (including 0,0). One fix per pilot per second: a second fix with
the same `t` is a duplicate (counted in `dup`, ignored).

### Pilot profile

What other pilots see:

```json
{ "first": "Zoé", "last": "Martin", "wing": "Ozone Zeno 2", "type": "paraglider", "app": "MyVario 2.1" }
```

`type`: `paraglider`, `hangglider`, `sailplane`, `paramotor`, `other`. On upload, missing fields keep their value, an
empty string clears it; `name` (full name) is accepted instead of `first`/`last`. Send the profile with the first
upload and whenever the pilot changes it (it is cheap to send it every time).

### Cursor

Every stored fix gets a server sequence number. Every update carries `seq`, the cursor. Keep the last one; give it
back as `since` when you reconnect. If the cursor is too old (more than `windowS`, 1 h by default, or the server
restarted), the answer is a full snapshot flagged `"reset": true`: drop what you had and start again.

---

## 2. Sending

**Recommended client algorithm**:

1. Every N seconds (3 s recommended) push the latest fix into a **local queue** — persist the queue when it grows
   (app restart in the air).
2. Send the **oldest part of the queue** (up to `maxBatch`, 5000) when the link allows: over the WebSocket as soon as
   a fix is queued (screen on), or by HTTP every 10–30 s (screen off, battery).
3. **Remove the sent fixes only when the server answered** (`ack` / HTTP 200). No answer → keep them, retry later.
   Re-sending fixes the server already has is harmless (`dup`).
4. HTTP 4xx other than 401/403/408/429: the batch will never be accepted, drop it (otherwise it blocks the queue).
   413: send smaller batches.

The other pilots receive late fixes too: after a cut, the backlog arrives in one batch and fills the gap of the track
everywhere.

### HTTP

```
POST /api/v1/points
X-App-Key: <key>
Content-Type: application/json
Content-Encoding: gzip            (optional, recommended for a backlog)

{
  "device": "myvario-8f3k2m1x",
  "secret": "c2b6…",
  "app": "MyVario 2.1",
  "pilot": { "first": "Zoé", "last": "Martin", "wing": "Ozone Zeno 2", "type": "paraglider" },
  "points": [[1793440000, 45.90123, 6.12345, 1834, 10.4, 271, 1.2], …]
}
```

Answer:

```json
{ "ok": true, "pilot": "42", "stored": 20, "dup": 0, "bad": 0, "last": 1793440057 }
```

`last`: time of the newest fix the server holds for this pilot.

Profile only: `POST /api/v1/pilot` with `device`, `secret`, `pilot`, `app`.

Erase everything (GDPR, « forget me »): `POST /api/v1/forget` with `device`, `secret` → all fixes and the profile are
deleted, the `device` is freed.

### WebSocket

See §4: `hello` with `device` + `secret`, then `{ "op": "pts", "id": 7, "pts": [[…], …] }` →
`{ "op": "ack", "id": 7, "pilot": "42", "stored": 1, "dup": 0, "bad": 0, "last": … }`.

---

## 3. Receiving by HTTP (polling)

```
GET /api/v1/live?center=45.9,6.1&radius=50&trail=600
GET /api/v1/live?bbox=5.5,45.2,7.0,46.4&since=123456
```

| parameter | meaning |
|---|---|
| `bbox` | `west,south,east,north` (west > east crosses the antimeridian) |
| `center` + `radius` | `lat,lon` and km (default 100 km) — instead of `bbox`; neither = the whole world |
| `trail` | seconds of track sent with a pilot you do not have yet (default 600, max `windowS`) |
| `maxAge` | pilots whose last fix is older are left out (s, default `windowS`) |
| `since` | your cursor: only what arrived since, plus the trail of pilots new to you |

Answer — an **update** (same shape as the WebSocket `upd`):

```json
{
  "seq": 123480,
  "now": 1793440060,
  "pilots": [
    { "id": "42", "trail": true,
      "p": { "first": "Zoé", "last": "Martin", "wing": "Ozone Zeno 2", "type": "paraglider", "app": "MyVario 2.1" },
      "pts": [[1793439460, 45.88, 6.10, 1702, 10.1, 265, 0.8], …] },
    { "id": "57", "pts": [[1793440057, 45.95, 6.21, 2210, 12.0, 90, -1.1]] },
    { "id": "61", "gone": true }
  ]
}
```

Per pilot:

| field | meaning |
|---|---|
| `id` | public pilot id |
| `pts` | fixes sorted by time. **May be older than fixes you already have** (backlog of a pilot back in coverage): merge by `t`, do not just append |
| `trail` | `pts` is the recent track of a pilot new to you (merge it the same way) |
| `p` | profile — sent the first time and when it changes; keep it |
| `gone` | pilot removed (blocked, erased): delete it |

A pilot that leaves your area stops being sent (you get its last fix outside the area); if it comes back, its trail
comes with it. Remove pilots yourself when their last fix gets old.

Other reads:

- `GET /api/v1/live.geojson?…` — same parameters, a GeoJSON `FeatureCollection`: a `LineString` (track) and a `Point`
  (last position) per pilot, profile in `properties`. For web maps and quick integrations.
- `GET /api/v1/pilots/{id}` — profile and last fix.
- `GET /api/v1/pilots/{id}/track?from=&to=&step=` — the stored track (up to 72 h), `step` = one fix per N s.
- `GET /api/v1` — server description: `protocol`, `retentionH`, `liveWindowS`, `minEvery`, `maxBatch`,
  `appKeyRequired`… (no key needed).

---

## 4. WebSocket (recommended)

```
wss://<server>/api/v1/ws
```

Text frames, one JSON object each, with `op`. Any request may carry an `id`, echoed in its answer.

### Client → server

| op | fields | |
|---|---|---|
| `hello` | `key`, `app`, optional `device` + `secret` + `pilot` (to send fixes) | first message. Answer `welcome` |
| `sub` | `bbox` `[w,s,e,n]` or `center` `[lat,lon]` + `radius` (km); `trail`, `maxAge` (s); `every` (s, ≥ `minEvery`, default 3); `since` (cursor) | subscribe, or change area / period on the same connection. Answer: an `upd` at once, then one every `every` s when something is new |
| `unsub` | | stop the updates |
| `pts` | `pts` (fixes), optional `pilot`, `app` | upload. Answer `ack` |
| `pilot` | `pilot`, `app` | profile change. Answer `ack` |
| `ping` | `t` (anything) | answer `pong` with the same `t`, server `now` and `seq` |

### Server → client

| op | |
|---|---|
| `welcome` | `v` (protocol), `now`, `seq`, `minEvery`, `windowS`, `retentionH`, `maxBatch`, `pilot` (your id if `device` was given) |
| `upd` | an update (§3). On `sub` it is a snapshot (or the delta since `since`); then only what is new |
| `ack` | result of `pts` / `pilot` |
| `pong` | |
| `err` | `code`, `message`, `id` — the connection stays open, except `app-key-required` (close 4001) and `admin-required` (4003) |

### Keeping it fast and safe on a mobile link

- **Detect a dead link yourself**: a mobile connection often stays "open" while nothing passes. Send `ping` every
  10–15 s; no `pong` within 5–10 s → close and reconnect. (The server pings too, every 20 s, and drops silent sockets.)
- **Reconnect with your cursor**: `sub` with `since: <last seq>` → only what you missed. Back-off 1, 2, 4… 30 s, and
  reconnect at once when the OS says the network is back.
- **Change area without re-subscribing from scratch**: send a new `sub` (without `since`) on the same connection: the
  server keeps your cursor and the pilots you have, and only sends the trails of pilots newly in the area. Re-send it
  when you moved a quarter of the radius, not at every fix.
- **Slow link**: the server never queues more than ~256 KB for you; it waits and then sends everything at once.
- Screen off / battery saving: close the socket and poll `GET /api/v1/live?since=` every 30 s, upload by HTTP. Same
  cursor, nothing lost.

### Example

```
→ {"op":"hello","key":"…","app":"MyVario 2.1","device":"myvario-5d1c09aa","secret":"…","pilot":{"first":"Zoé","last":"Martin","wing":"Gin Leopard"}}
← {"op":"welcome","v":1,"now":1793440000,"seq":123400,"minEvery":1,"windowS":3600,"retentionH":72,"maxBatch":5000,"pilot":"57"}
→ {"op":"sub","id":1,"center":[45.9,6.1],"radius":50,"trail":600,"every":3}
← {"op":"upd","id":1,"seq":123400,"now":1793440000,"pilots":[{"id":"42","trail":true,"p":{…},"pts":[…]}]}
→ {"op":"pts","id":2,"pts":[[1793440002,45.95,6.21,2210,12.0,90,-1.1]]}
← {"op":"ack","id":2,"pilot":"57","stored":1,"dup":0,"bad":0,"last":1793440002}
← {"op":"upd","seq":123411,"now":1793440003,"pilots":[{"id":"42","pts":[[1793440000,…],[1793440003,…]]}]}
   … network cut, reconnect …
→ {"op":"hello","key":"…","device":"myvario-5d1c09aa","secret":"…"}
→ {"op":"sub","center":[45.9,6.1],"radius":50,"since":123411}
← {"op":"upd","seq":123502,"now":1793440095,"pilots":[{"id":"42","pts":[ …the 30 fixes missed… ]}]}
```

---

## 5. LiveTrack24 compatibility

Apps that can send to a LiveTrack24 server with a custom address (XCSoar, LK8000…) work without change: set the
server to `<server>` (plain host name). Account: any user name and password, claimed on first use (the password is
stored as scrypt). Without a user name, each session is an anonymous pilot. The wing name (`vname`) and the vehicle
type (`vtype`) fill the profile.

```
GET /client.php?op=login&user=U&pass=P                     → pilot id, or 0
GET /track.php?leolive=2&sid=…&user=U&pass=P&client=…&v=…&vtype=1&vname=…   start  → OK
GET /track.php?leolive=4&sid=…&lat=…&lon=…&alt=…&sog=…&cog=…&tm=…           fix    → OK   (sog km/h)
GET /track.php?leolive=3&sid=…                                              end    → OK
```

The same paths are also served under `/lt24/`.

---

## 6. Tracking link

Each pilot can have one private link for their family and friends, who need no app and no account:
`https://<server>/p/<token>` opens a live map of that pilot alone. The link is permanent until the pilot replaces it.

```
POST /api/v1/share
X-App-Key: <key>

{ "device": "myvario-8f3k2m1x", "secret": "c2b6…", "token": "Wq3vT0m2…", "pilot": { … }, "app": "MyVario 2.1" }
```

Answer: `{ "ok": true, "pilot": "42" }`.

| rule | |
|---|---|
| `token` | drawn **by your app**: at least 16 random bytes from a secure generator, 22–64 chars `[A-Za-z0-9_-]` (base64url). The server stores only its SHA-256, so it can never show the link again and a stolen database gives no link |
| One link per pilot | a new `token` replaces the previous one, which **stops working at once** |
| Same `token` again | changes nothing. Send it again at each connection: a pilot forgotten after 90 days without a fix gets the same link back |

**Client algorithm**

1. Keep the token on the device, out of backups and logs. Show the link only once the server answered `200`.
2. Offer two actions: share the link (the system share sheet), and generate a new one.
3. To generate a new one: draw a token, `POST` it, and replace the stored token **only after a `200`**. Without an
   answer the old link is still alive: tell the pilot, do not pretend it was cut. Regenerating is a privacy action.
4. `POST /api/v1/forget` deletes the link with everything else: drop the stored token too.

What the link shows, read by the page (no app key, the token is enough):

```
GET /api/v1/shared/<token>
GET /api/v1/shared/<token>?since=1793440000
```

```json
{ "p": { "first": "Zoé", "last": "Martin", "wing": "Ozone Zeno 2", "type": "paraglider" },
  "now": 1793440060,
  "pts": [[1793439460, 45.88, 6.10, 1702, 10.1, 265, 0.8], …] }
```

`pts`: the last 24 h at most, one fix per 5 s; with `since` (a fix time), every fix after it. No device, no pilot id,
no app name. A replaced, erased, blocked or unknown link answers the same `404 unknown-link`. The page is served with
`noindex` and `no-referrer`.

---

## 7. Errors

HTTP errors are JSON: `{ "ok": false, "error": "<code>", "message": "…" }`.

| status | code | what to do |
|---|---|---|
| 400 | `bad-json`, `bad-device`, `bad-secret`, `bad-points`, `bad-area`, `bad-token` | fix the request; drop the batch |
| 401 | `app-key-required` | key missing or unknown |
| 403 | `device-taken` | wrong secret for this device: new device id |
| 403 | `blocked` | pilot blocked by the operator |
| 404 | `unknown-link` | tracking link replaced, erased or unknown |
| 409 | `token-taken` | this token belongs to another pilot: draw a new one |
| 413 | `too-many-points`, `body-too-large` | smaller batches |
| 429 | `rate-limited` | wait a minute; keep the queue |
| 5xx | | keep the queue, retry |

---

## 8. Privacy

Fixes are kept 72 h (less when the disk is full: the oldest go first), then deleted. A profile without any fix is
forgotten after 90 days. `POST /api/v1/forget` deletes everything at once. Apps must let the pilot choose to share,
show which name is published, offer « forget me », and tell the pilot that anyone holding their tracking link sees
their position and their last 24 h.
