# Connect your flight app

Open Paragliders Network is one live-tracking server for every paragliding app. A pilot on your app sees the pilots
around them on any other connected app, and the other way round. Instead of each app keeping its own closed group of
pilots, all of them share one network.

What your app gets:

- the pilots around, live, each with their recent track;
- nothing lost when the network drops: uploads can be repeated safely, and a reconnecting client receives exactly what
  it missed, including what a pilot sent late;
- a private tracking link for each pilot's family and friends;
- no accounts to run: a device identifies itself.

There is no SDK to install: JSON over HTTP and one WebSocket. A first version takes about a page of code, and
[example.mjs](/docs/example.mjs) is a complete working client. The details are in the [protocol](#protocol).

## Already speaking LiveTrack24?

Apps that can send to a LiveTrack24 server with a custom address (XCSoar, LK8000…) can **send** today without any code:
set the server address. To receive the other pilots, use the steps below.

## 1. Get a key

Each app has its own key. `GET /api/v1` on the server gives the operator's `contact`: write with your app's name.

## 2. Create the pilot's identity, once

On first use, draw two random values and keep them on the device:

```js
const device = 'myvario-' + randomHex(8);  // public to the server, prefix it with your app name
const secret = randomHex(32);              // never shown, never logged
```

There is no sign-up: the first upload claims the `device`. Show the pilot which name will be published, and let them
choose to share.

## 3. Send fixes through a queue

Put each fix in a local queue, every 3 s. Send the oldest fixes, and **remove them only when the server answered**.
Sending a fix twice is harmless, so a lost answer costs nothing.

```js
await fetch(server + '/api/v1/points', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-App-Key': key },
  body: JSON.stringify({ device, secret, app: 'MyVario 2.1', pilot: { name: 'Zoé Martin', wing: 'Gin Leopard', type: 'paraglider' }, points: queue.slice(0, 1000) }),
});
```

A fix is `[time, lat, lon, altitude, ground speed m/s, track, vertical speed m/s]`; any of the last four may be `null`.
Use the time of the GPS fix, not the time of sending.

## 4. Receive the pilots around

Screen on, keep one WebSocket on `wss://<server>/api/v1/ws`. Screen off, close it and poll
`GET /api/v1/live?since=<seq>` every 30 s instead: same cursor, nothing lost.

```js
ws.send(JSON.stringify({ op: 'hello', key, app: 'MyVario 2.1', device, secret }));
// after "welcome":
ws.send(JSON.stringify({ op: 'sub', center: [lat, lon], radius: 50, trail: 600, every: 3, since: lastSeq }));
```

Each `upd` carries `seq`: keep the last one and give it back as `since` when you reconnect. For each pilot:

- `pts` may be **older** than what you have (a pilot back in coverage): merge by time, do not append;
- `p` is the profile, sent once and when it changes: keep it;
- `gone` means remove the pilot;
- with `reset: true`, drop everything and start again.

Send a new `sub` when the pilot has moved a quarter of the radius, not at every fix. Send `ping` every 15 s, and
reconnect if no `pong` comes within 10 s: a mobile link often looks open while nothing passes.

## 5. Offer the tracking link

Draw a token on the device, register it, then let the pilot share `https://<server>/p/<token>`:

```js
const token = randomBase64Url(16);
const r = await post('/api/v1/share', { device, secret, token });
if (r.status === 200) storeToken(token);   // only now is the link real
```

The link stays the same until the pilot asks for a new one. Offer that button: a pilot uses it to cut someone's access.
Replace the stored token only after a `200`, and say so if it failed, because the old link is then still alive.

## Checklist before going live

- [ ] Sharing is off until the pilot turns it on, and nothing is sent in simulation or replay.
- [ ] The pilot sees the name that is published, and can change it.
- [ ] « Forget me » calls `POST /api/v1/forget` and drops the local token.
- [ ] The pilot is told that anyone holding the tracking link sees their position and their last 24 h.
- [ ] The tracking link can be regenerated.
- [ ] `device`, `secret` and the token are kept out of logs and shared backups.
- [ ] Uploads leave the queue only on an answer; `pts` are merged by time.
- [ ] 401, 403 and 429 keep the queue; any other 4xx drops the batch.

## Try it

```bash
node example.mjs https://<server> <key>
```

[example.mjs](/docs/example.mjs) sends a simulated pilot through a queue, receives the others, and creates a tracking
link. It needs Node 22 or later and nothing else.
