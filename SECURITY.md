# Security

Open Paragliders Network carries pilots' live positions and names. If you find a vulnerability, please report it
privately through [GitHub's private reporting](https://github.com/alexandre-pereira/open-paragliders-network/security/advisories/new)
rather than in a public issue. Please do not test against a server you do not operate.

## What the server does

- **Application keys** are stored as SHA-256 hashes, shown once at creation, and can be rotated or revoked from the
  back-office: open connections of a revoked application are closed at once.
- **Tracking links**: the token is drawn by the device and only its hash is stored. A new link kills the old one at once.
- **Banned devices** stay banned after their data is erased. A banned pilot can still erase their data.
- **Limits**: requests, device creation and WebSocket messages per client; failed back-office logins per client and in
  total; request size, decompressed size and connection count.
- **Behind a proxy**, the client address is the last entry of `X-Forwarded-For`, the one the proxy wrote: the first
  ones are chosen by the client. Set `TRUST_PROXY=1` only behind a proxy you control.
- **Pages** are served with a Content-Security-Policy, and third-party scripts with Subresource Integrity. Names come
  from pilots and are never inserted as HTML.
- **Back-office actions** are recorded in a journal, kept 30 days.
- **No IP address is stored on disk**, except in that journal. IP bans last 24 h and live in memory.

## What it does not do

- It is not a rescue service: « needs help » does not alert anyone but other pilots.
- Pilots are identified by their device, not by a verified identity: a name is what the pilot typed.
- The LiveTrack24 compatibility has no application key, because that protocol has none: it can be turned off (`LT24=0`).
- A banned person can come back on a new device: revoke the application, or ban the address for 24 h, knowing that a
  mobile operator shares one address between many people.
