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
seconds (UTC). CORS is open, except on the back-office.

### At a glance

| Request | Key | |
|---|---|---|
| `GET /api/v1` | no | server description, limits, operator's `contact` |
| `POST /api/v1/points` | yes | send fixes |
| `POST /api/v1/pilot` | yes | change the profile |
| `GET /api/v1/live` | yes | the pilots around (polling) |
| `GET /api/v1/live.geojson` | yes | the same in GeoJSON |
| `GET /api/v1/pilots/{id}`, `/track` | yes | one pilot, their stored track |
| `wss://<server>/api/v1/ws` | yes | everything above, pushed |
| `POST /api/v1/share` | yes | create or replace the tracking link |
| `GET /api/v1/shared/{token}` | token | what a tracking link shows |
| `POST /api/v1/status` | yes | SOS, landed OK |
| `GET /api/v1/sos` | no | the pilots who sent an SOS |
| `GET /sos` | no | the same on a public map |
| `GET /api/v1/map` | no | the public live map: every pilot of the day, their last flight and distances |
| `GET /api/v1/map/{id}` | no | one pilot of that map: their whole last flight |
| `GET /` | no | the public live map page |
| `POST /api/v1/forget` | yes | erase everything about a pilot |

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
| 7 | `gnd` | 1 | optional, upload only: `1` when your app knows the pilot is **on the ground** (not taken off yet, or landed). Leave it out in flight or when you don't know |

Uploads may also use objects: `{ "t": …, "lat": …, "lon": …, "alt": …, "spd": …, "crs": …, "vz": …, "gnd": 1 }` (aliases:
`ts`, `time`, `lng`, `speed`, `course`, `track`, `vspeed`, `vario`).

**Ground fixes are private.** A fix sent with `gnd: 1` is stored but goes only to the pilot's tracking link (§6): no
subscriber, no public map (§11) and no live view ever gets it, so a pilot sharing from take-off (or from home) does not
publish where they wait. While the pilot is in `sos` (§7) their fixes are public whatever `gnd` says, and the alert
takes their last fix, ground ones included, when it gives no position. Send ground fixes rather than nothing: the
family following the link sees the pilot before take-off and after landing. Fixes are always sent back without `gnd`.

A fix is rejected (counted in `bad`) when its time is more than 2 min in the future or older than the history
(`retentionH`, 72 h), or its position is impossible (including 0,0). One fix per pilot per second: a second fix with
the same `t` is a duplicate (counted in `dup`, ignored).

### Pilot profile

What other pilots see:

```json
{ "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2 MS", "type": "paraglider", "app": "MyVario 2.1" }
```

`brand`: the maker of the wing, `wing`: its model and size, both free text; show them together. A wing that only has
`wing` (« Ozone Zeno 2 ») stays valid. `type`: `paraglider`, `hangglider`, `sailplane`, `paramotor`, `other`. `ids`: the pilot's identifiers on other networks,
so that apps receiving several networks show them once: `{ "flarm": "DD1234", "fanet": "…", "ogn": "…", "puretrack": "…",
"xcontest": "…" }` (10 at most, keys `[a-z0-9_-]`, send `{}` to clear them). `public`: `false` keeps the pilot off the
public web map (§11), `true` puts them back; absent, the last value stays (on by default). Other apps and the tracking
link still show the pilot. `status` is set by the server (§7). On upload, missing fields keep their value, an
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
  "pilot": { "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2 MS", "type": "paraglider" },
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
| `maxAge` | pilots whose last fix is older are left out (s, default `windowS`), except pilots in `sos` |
| `since` | your cursor: only what arrived since, plus the trail of pilots new to you |

Answer — an **update** (same shape as the WebSocket `upd`):

```json
{
  "seq": 123480,
  "now": 1793440060,
  "pilots": [
    { "id": "42", "trail": true,
      "p": { "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2 MS", "type": "paraglider", "app": "MyVario 2.1" },
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
| `err` | `code`, `message`, `id` — the connection stays open, except for the close codes below |

### Close codes

| Code | Meaning |
|---|---|
| `4001` | key missing, wrong or revoked, or no `hello` within 10 s |
| `4003` | back-office password refused, or address banned |
| `4008` | too many messages on this connection |
| `1012` | the server restarts: reconnect with your cursor |

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
`https://<server>/p/<token>` opens a live map of that pilot alone, with everything the server keeps (72 h) split into
flights, ground fixes (`gnd`, see Fix in §1) included: the link is the only place they show. The link is permanent until the pilot replaces it.

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
{ "p": { "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2 MS", "type": "paraglider" },
  "now": 1793440060,
  "pts": [[1793439460, 45.88, 6.10, 1702, 10.1, 265, 0.8], …] }
```

`pts`: the whole history kept (`retentionH`), one fix per 5 s; with `since` (a fix time), every fix after it. The page
splits it into flights (§11). `status`: the pilot's
state, when they have one (§7). No device, no pilot id, no app name. A replaced, erased, blocked or unknown link answers
the same `404 unknown-link`. The page is served with `noindex` and `no-referrer`.

---

## 7. SOS and landed OK

A pilot can declare how their flight ended. It is marked on their track, and **an SOS (« needs help ») becomes public**.

```
POST /api/v1/status
X-App-Key: <key>

{ "device": "myvario-8f3k2m1x", "secret": "c2b6…", "state": "sos", "t": 1793440000, "lat": 45.9, "lon": 6.1, "alt": 1420 }
```

| `state` | |
|---|---|
| `sos` | landed, needs help. Shown on `https://<server>/sos`, public, no key, to everyone |
| `ok` | landed OK. Cancels `sos`; marked on the pilot's track and tracking link, not on `/sos` |
| `none` | clears the state: a false alarm, or the next take-off |

`t`, `lat`, `lon`, `alt` are optional (default: now, the pilot's last fix). So are `pilot` and `app`, as in an upload: send
them, an SOS may be a pilot's very first request. This is HTTP only, there is no WebSocket `op`. Sending the same state
again is harmless: keep trying until a `200`, a pilot in trouble is often out of coverage. A state stays until the pilot
changes it or the operator removes it, 72 h at most.

Apps that follow this pilot, or are subscribed to the area of their last position, receive it in the pilot's profile, at
once and even if the pilot sends no more fixes:

```json
{ "id": "42", "p": { "first": "Zoé", …, "status": { "state": "sos", "t": 1793440000, "lat": 45.9, "lon": 6.1, "alt": 1420 } } }
```

A later subscriber of that area gets it too, whatever `maxAge` and the age of the last fix: the snapshot carries every
pilot in `sos` whose declared position (else last fix) is in the area, with their last fix, or with no `pts` once that fix
has left the live window. `GET /api/v1/sos` needs no key and lists the pilots in `sos`, newest first, 200 at most:

```json
{ "now": 1793440060,
  "pilots": [{ "p": { "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2 MS", "type": "paraglider" },
               "t": 1793440000, "lat": 45.9, "lon": 6.1, "alt": 1420,
               "pts": [[1793438200, 45.88, 6.10, 1702, 10.1, 265, 0.8], …] }] }
```

`lat`, `lon`, `alt`: `null` when the position is unknown. `pts`: the track from 30 min before the SOS until now, one fix
per 5 s. No device, no pilot id, no app name. A blocked pilot is not listed.

`https://<server>/sos` shows this list on a map, in French or English, refreshed every 15 s. It is served with `noindex`
and `no-referrer`.

**This is mutual aid between pilots: it does not alert the rescue services.** Tell the pilot to call 112, and tell them
that their name and position become public before they send `sos`. Never send `sos` from a simulation or a replay.

---

## 8. Errors

HTTP errors are JSON: `{ "ok": false, "error": "<code>", "message": "…" }`.

| status | code | what to do |
|---|---|---|
| 400 | `bad-json`, `bad-device`, `bad-secret`, `bad-points`, `bad-area`, `bad-token`, `bad-state` | fix the request; drop the batch |
| 401 | `app-key-required` | key missing, unknown or revoked |
| 401 | `device-required` | WebSocket: `pts` or `pilot` without `device` and `secret` in `hello` |
| 403 | `device-taken` | wrong secret for this device: new device id |
| 403 | `blocked` | device banned by the operator: stop sending. `POST /api/v1/forget` still works |
| 403 | `banned` | address banned by the operator for 24 h: stop sending |
| 400 | `unknown-op`, `bad-message`, `bad-gzip` | fix the request |
| 404 | `unknown-link` | tracking link replaced, erased or unknown |
| 404 | `unknown-device` | `forget`: this device is not known |
| 409 | `token-taken` | this token belongs to another pilot: draw a new one |
| 413 | `too-many-points`, `body-too-large` | smaller batches |
| 429 | `rate-limited` | wait a minute; keep the queue |
| 5xx | | keep the queue, retry |

---

## 9. Limits

Defaults; an operator can change them. `GET /api/v1` gives the ones marked *(info)*.

| Limit | Default |
|---|---|
| HTTP requests per address | 600 per minute |
| New devices per address | 20 per minute |
| WebSocket connections per address | 20 |
| WebSocket messages per connection | 600 per minute |
| Fixes per upload *(info: `maxBatch`)* | 5000 |
| Request size | 4 MB, gzip accepted |
| Shortest push period *(info: `minEvery`)* | 1 s |
| Trail, and resuming after a cut *(info: `liveWindowS`)* | 1 h |
| History *(info: `retentionH`)* | 72 h |

A mobile operator shares one address between many phones: on `429`, keep your queue and wait.

---

## 10. Privacy

Fixes are kept 72 h (less when the disk is full: the oldest go first), then deleted. A profile without any fix is
forgotten after 90 days. `POST /api/v1/forget` deletes everything at once. Apps must let the pilot choose to share,
show which name is published, offer « forget me », tell the pilot that anyone holding their tracking link sees
their position and every track the server keeps, that their name, wing, position and the track of their last flight of
the day are on the public map unless `public` is `false`, and that « needs help » makes their name and position public.

---

## 11. Public live map

`https://<server>/` is a public map of the day, like XContest Live: anyone can watch, with no app and no key. It shows
each pilot whose profile does not say `public: false`, with **their last flight of the day** only: the day is the solar
day where the pilot is (midnight by the sun at their longitude). A pilot on the ground who has not flown yet stays on it
for 30 min after their last fix, unless their app marks those fixes `gnd` (then they show only on the tracking link). Earlier flights stay on the tracking link (§6).

**Flights.** A track is cut into flights where the pilot stopped on the ground (slower than 2.5 m/s for 5 min at the
same height, or walking slowly up or down), or where it has a hole: 10 min when the pilot was slow on either side,
45 min in any case. A piece with less than a minute faster than 4 m/s is not a flight (waiting at take-off, walking).
An app that refills its queue after a network cut leaves no hole: send every fix you recorded.

**Distances** (`public/lib/xc.js`, also used by the page): free distance through three turnpoints, flat and FAI
triangles (each side ≥ 28 % of the perimeter P) closed under each contest's rule, and the largest triangle the pilot
would close by flying back to their start. Distances on the FAI sphere; indicative, never an official score.

| contest | triangle counts | points per km |
|---|---|---|
| XContest | gap < 20 % of P: P − gap | flat 1.2, FAI 1.4 |
| XContest, closed | gap < 5 % of P: P − gap | flat 1.4, FAI 1.6 |
| CFD (FFVL) | gap ≤ 3 km: P; gap ≤ 5 % of P: P − gap | flat 1.2, FAI 1.4 |

Free distance counts 1 point per km everywhere.

```
GET /api/v1/map
```

```json
{ "now": 1793440060,
  "pilots": [{ "id": "42", "p": { "first": "Zoé", "last": "Martin", "brand": "Ozone", "wing": "Zeno 2", "type": "paraglider" },
               "last": [1793440057, 45.95, 6.21, 2210, 12.0, 90, -1.1],
               "flight": { "t0": 1793425000, "t1": 1793440057, "n": 3012, "km": 70.0, "fai": 76.9, "flat": 76.9 },
               "tail": [[1793439760, 45.93, 6.20, 2150, 11.0, 80, 0.5], …] }] }
```

`flight`: start, end and fixes of the last flight; `km` its free distance, `fai` / `flat` the largest FAI / any triangle
it would close (km, from 10 km), absent when the pilot has not flown. `tail`: the last 5 min, one fix per 15 s, for a
pilot seen in the last 5 min. Same answer for everyone for 3 s. No device, app, ids or pilot secret.

```
GET /api/v1/map/42
GET /api/v1/map/42?since=1793440057
```

`{ "id", "p", "now", "t0", "t1", "pts" }`: the whole last flight from `t0` (one fix per 2 s) and what followed it (the
pilot walking after landing); with `since`, every fix after it. A new `t0` means a new flight: start again without
`since`. `404 not-on-map` for a pilot who is not on the map.
