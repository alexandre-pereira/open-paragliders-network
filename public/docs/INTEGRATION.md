# Connect your flight app

Open Paragliders Network is one live-tracking server for every paragliding app. Connect yours and your pilots see the
pilots around them, whatever app those pilots use, and the other way round.

| Your app gets | |
|---|---|
| **Live traffic** | The pilots around, pushed every few seconds, each with their recent track |
| **No lost data** | Uploads can be repeated safely. A client that reconnects receives exactly what it missed |
| **A tracking link** | One private page per pilot for family and friends, with no app and no account |
| **Mutual aid** | « Landed OK » and « needs help », shown to the pilots around |
| **No accounts to run** | A device identifies itself. There is nothing for your pilots to sign up to |

There is no SDK: it is JSON over HTTP and one WebSocket. Every step below is implemented in
[example.mjs](/docs/example.mjs), a complete client that the server's own test suite runs, and the
[protocol](#protocol) has every detail.

## How it works

```
 your app                                  server
 ────────                                  ──────
 fix every 3 s ──► local queue
                     │  hello, then pts ──────►  stored, sent to the pilots around
                     ◄────────────── ack         the fixes leave the queue only now
 subscribe to an area ───────────────────►
 merge by time ◄──────────────────── upd         pushed every 3 s, with a cursor (seq)

 ── network cut ──
 fixes wait in the queue
 reconnect, sub with since: <seq> ───────►
 queue goes out ◄──────────────────── upd        exactly what was missed
```

Screen on, one WebSocket does everything. Screen off, close it to save the battery and use HTTP: upload by batches and
poll with the same cursor. Nothing is lost when you switch.

## Before you start

**Get a key.** Each app has its own. `GET /api/v1` on the server gives the operator's `contact`: write with your app's
name. The operator creates the key and can replace or revoke it without touching other apps.

A key shipped inside an app can be extracted: it identifies your app, it is not a user secret. Revoking it cuts all your
users at once, so if you can, deliver it from your own configuration service rather than hard-coding it. You can then
replace it without a new release.

**Run your own test server.** You need Node 24. With no key configured, the server is open, so you can start right away.
The back-office at `/admin/` shows what your app really sends.

```bash
git clone https://github.com/alexandre-pereira/open-paragliders-network.git
cd open-paragliders-network && npm install
ADMIN_TOKEN=choose-a-long-password npm run dev           # http://localhost:8080/admin/
npm run sim -- http://localhost:8080 12 "" 45.9 6.1      # 12 simulated pilots around that point
```

A phone needs HTTPS to reach it: `npm run local` adds a temporary public address through a Cloudflare tunnel, for tests
only. On your computer, you can also run the example client against it:

```bash
node public/docs/example.mjs http://localhost:8080 "" 45.9 6.1 60
```

## Step 1: identify the device

On first use, draw two random values and keep them on the device for good.

```js
const device = 'myvario-' + randomBytes(4).toString('hex');   // 6–80 chars, prefix it with your app's name
const secret = randomBytes(16).toString('hex');               // 16–200 chars, never shown, never logged
```

The first upload claims the `device`. Later ones must carry the same `secret`, so nobody else can write under that
pilot's name. If the server answers `403 device-taken`, draw a new pair.

Keep `device` and `secret` out of shared backups: two phones restored from one backup would be one pilot.

## Step 2: describe the pilot

The profile is what other pilots see. Send it with the first upload and whenever it changes.

```js
const pilot = {
  first: 'Zoé', last: 'Martin',        // or name: 'Zoé Martin'
  wing: 'Gin Leopard',
  type: 'paraglider',                  // paraglider, hangglider, sailplane, paramotor, other
  ids: { flarm: 'DD1234' },            // optional, see « Avoid double pilots »
};
```

Let the pilot see and change the published name, and leave sharing off until they turn it on.

## Step 3: send through a queue

Never send a fix directly. Put each one in a local queue, every 3 s, and save the queue when it grows: an app can restart
in the air.

```js
queue.push([time, lat, lon, altitude, groundSpeed, track, verticalSpeed]);
```

| # | Field | Unit | |
|---|---|---|---|
| 0 | time | Unix s | **of the GPS fix**, not of sending |
| 1, 2 | lat, lon | ° WGS84 | |
| 3 | altitude | m | GPS, above mean sea level, or `null` |
| 4 | ground speed | m/s | or `null` |
| 5 | track | ° true | or `null` |
| 6 | vertical speed | m/s | or `null` |

**Remove fixes from the queue only when the server has answered.** Sending a fix twice is harmless: the server keeps one
per pilot per second. So a lost answer costs nothing, and a long backlog goes out in a few requests.

Screen off, or with no socket, send batches every 10 to 30 s:

```js
const r = await fetch(server + '/api/v1/points', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Key': key },
  body: JSON.stringify({ device, secret, app: 'MyVario 2.1', pilot, points: queue.slice(0, 1000) }),
});
if (r.ok) queue.splice(0, 1000);
```

Screen on, send as soon as a fix is queued, one batch at a time, and wait for its `ack`:

```js
ws.send(JSON.stringify({ op: 'pts', id: 7, pts: queue.slice(0, n) }));
// ← { "op": "ack", "id": 7, "stored": 1, "dup": 0, "bad": 0, ... }: only now remove them
```

What to do with an answer:

| Answer | What to do |
|---|---|
| `200` | Remove the batch from the queue |
| No answer, `5xx`, `408` | Keep it. Try again, waiting longer each time, and at once when the network comes back |
| `429` | Keep it and wait a minute |
| `401` | Keep it. Your key is wrong or was revoked: tell your team, not the pilot |
| `403 device-taken` | Keep it and draw a new `device` and `secret` |
| `403 blocked`, `403 banned` | Stop sending |
| `413` | Send smaller batches |
| Any other `4xx` | Drop the batch: it will never be accepted, and it would block the queue |

## Step 4: receive the pilots around

Connect to `wss://<server>/api/v1/ws`. The first message must be `hello`, within 10 s.

```js
ws.onopen = () => ws.send(JSON.stringify({ op: 'hello', key, app: 'MyVario 2.1', device, secret, pilot }));

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.op === 'welcome') {
    me = m.pilot;   // your own pilot id
    ws.send(JSON.stringify({ op: 'sub', center: [lat, lon], radius: 50, trail: 600, every: 3, ...(seq !== null ? { since: seq } : {}) }));
  }
  if (m.op === 'upd') merge(m);
};
```

`center` and `radius` (km) choose the area, `trail` how many seconds of track arrive with a pilot new to you, `every` how
often the server pushes. Then merge each update:

```js
function merge(u) {
  seq = u.seq;                                  // the cursor: keep it
  if (u.reset) pilots.clear();                  // a full picture: start again
  for (const x of u.pilots) {
    if (x.gone) { pilots.delete(x.id); continue; }
    if (x.id === me) continue;                  // your own pilot comes back too
    const cur = pilots.get(x.id) ?? { p: null, pts: new Map() };
    if (x.p) cur.p = x.p;                       // sent once, and when it changes
    for (const f of x.pts ?? []) cur.pts.set(f[0], f);   // by time, see below
    pilots.set(x.id, cur);
  }
}
```

Three things catch people out:

- **Merge by time, do not append.** `pts` may be older than what you have: a pilot back in coverage sends their backlog,
  and it fills the gap in their track everywhere.
- **An update can have no fixes.** A pilot who landed sends none, but their `p` still arrives with their state.
- **Remove pilots yourself** when their last fix gets old. The server only says `gone` for a pilot blocked or erased.

Send a new `sub` when your pilot has moved a quarter of the radius, not at every fix. Leave out `since`: on the same
connection the server keeps your cursor, and only sends the tracks of pilots newly in the area.

## Step 5: survive a bad network

This is where a live-tracking client is won or lost. A mobile link often looks open while nothing passes.

**Detect a dead link yourself.** Send `ping` every 15 s. No `pong` within 10 s: close and reconnect.

```js
setInterval(() => {
  if (pingAt && pongAt < pingAt && Date.now() - pingAt > 10000) { ws.close(); return; }
  pingAt = Date.now();
  ws.send(JSON.stringify({ op: 'ping', t: pingAt }));
}, 15000);
```

**Reconnect with your cursor.** Wait 1, 2, 4… up to 30 s, and at once when the system says the network is back. Your
`sub` carries `since: seq`, so you receive only what you missed. A cursor too old, more than an hour by default, gets a
full picture flagged `reset: true`.

**Save the battery.** Screen off, close the socket and poll `GET /api/v1/live?center=45.9,6.1&radius=50&since=<seq>` every
30 s. The answer has the same shape as `upd`, so `merge()` does not change.

How the server closes a socket:

| Code | Meaning | What to do |
|---|---|---|
| `4001` | Key missing, wrong or revoked | Do not retry in a loop |
| `4003` | Address banned | Do not retry in a loop |
| `4008` | Too many messages on this connection | Slow down, then reconnect |
| `1012` | The server restarts | Reconnect as usual, with your cursor |

## Step 6: offer the tracking link

Each pilot can have one private link for their family and friends: `https://<server>/p/<token>`. It shows that pilot
alone, with their last 24 h. It needs no app and no key.

Draw the token on the device. The server keeps only its hash, so it cannot show the link again.

```js
const token = randomBytes(16).toString('base64url');
const r = await post('/api/v1/share', { device, secret, token });
if (r.status === 200) storeToken(token);   // only now is the link real
```

The link stays the same until the pilot asks for a new one. Offer both actions: **share** it through the system share
sheet, and **new link**, which draws a new token and sends the same request.

The new link is how a pilot cuts someone's access, so it has to be honest: replace the stored token only after a `200`.
If it failed, say that the old link still works. Send the stored token again at each connection: the same token changes
nothing, and it brings the link back for a pilot forgotten after 90 days without a fix.

## Step 7: say how the flight ended

When your pilot says how they landed, tell the network. Keep the last state on the device and send it again until a
`200`: a pilot in trouble is often out of coverage. Let it through any data-saving setting.

```js
await post('/api/v1/status', { device, secret, state: 'sos', lat, lon, alt });
```

| `state` | Meaning | Who sees it |
|---|---|---|
| `sos` | Landed, needs help | **Everyone**, on the public page `https://<server>/sos`, and all connected apps |
| `ok` | Landed OK. Cancels `sos` | The pilot's track and tracking link |
| `none` | Nothing to say. Send it at the next take-off | |

Every app receives it in `p.status`, even if the pilot sends no more fixes. Show it to the pilots around, they are often
the first able to help.

```js
const s = cur.p?.status;   // { state: 'sos', t: 1793440000, lat: 45.9, lon: 6.1, alt: 1420 }
```

Four rules, because this one can hurt someone:

- **It does not alert the rescue services.** Tell the pilot to call 112, and keep that first on your screen.
- **Tell the pilot before sending** that their name and position become public.
- **Never send `sos` from a simulation or a replay**, and test it only on your own server.
- **Make cancelling easy**: a false alarm stays public until someone says otherwise, 72 h at most.

## Step 8: let the pilot erase everything

« Forget me » must be one tap away.

```js
await post('/api/v1/forget', { device, secret });
// then drop the queue, the token and the identity from the device
```

All fixes, the profile, the tracking link and any state are deleted at once. The next upload starts from a new identity.

## Avoid double pilots

If your app also receives FLARM, OGN or other networks, one person may reach you twice. Pilots can declare their other
identifiers, and you receive them in `p.ids`:

```json
{ "flarm": "DD1234", "fanet": "…", "ogn": "…", "puretrack": "…", "xcontest": "…" }
```

Merge a contact whose identifier is listed there. Send your own pilot's identifiers too, so that other apps can do the
same. Nothing checks them: use them to merge pilots who are close together, not to identify anyone.

## Already speaking LiveTrack24?

Apps that can send to a LiveTrack24 server with a custom address (XCSoar, LK8000…) can **send** today with no code: set
the server address. Any user name and password are claimed on first use. To receive the other pilots, follow steps 4 and 5.

## Test it

Run these on your own server, with the back-office open:

- [ ] **First flight.** The pilot appears with the right name, wing and altitude, and the fixes arrive.
- [ ] **Network cut.** Turn on airplane mode for 2 minutes. The track fills in afterwards, with no gap and no double.
- [ ] **Restart in the air.** Kill the app with fixes in the queue. They leave at the next start.
- [ ] **Traffic.** With `npm run sim`, the simulated pilots appear with their tracks, and your own pilot does not.
- [ ] **Dead link.** Block the network without closing the socket. Your app notices within 25 s and reconnects.
- [ ] **Screen off.** Fixes keep going, and nothing is missed when the screen comes back.
- [ ] **New link.** The old page says the link is no longer valid, at once. With the network off, your app says so.
- [ ] **Needs help.** It appears on `/sos`, then disappears with « landed OK ».
- [ ] **Forget me.** The pilot and the link are gone from the back-office.

## Before going live

- [ ] Sharing is off until the pilot turns it on, and nothing is sent in simulation or replay.
- [ ] The pilot sees the name that is published, and can change it.
- [ ] The pilot is told that anyone holding the tracking link sees their position and their last 24 h.
- [ ] The tracking link can be regenerated, and the screen tells the truth when that fails.
- [ ] Before `sos`, the pilot knows that their name and position become public and that it does not call the rescue services.
- [ ] « Forget me » erases the server and the device.
- [ ] `device`, `secret` and the token stay out of logs and shared backups.
- [ ] Your privacy policy names the server, what it keeps and for how long.

## Need help?

Read the [protocol](#protocol) for every field and limit, and run [example.mjs](/docs/example.mjs). Found a problem? Open
an issue on [GitHub](https://github.com/alexandre-pereira/open-paragliders-network/issues), or see
[SECURITY.md](https://github.com/alexandre-pereira/open-paragliders-network/blob/main/SECURITY.md) for a vulnerability.
