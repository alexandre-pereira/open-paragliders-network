// Web Push sans dépendance : le message chiffré pour le seul navigateur abonné (RFC 8291, aes128gcm) et signé par la
// clé du serveur (VAPID, RFC 8292). Le service de notification du navigateur (Google, Mozilla, Apple, Microsoft) ne
// lit pas le message ; il le remet au navigateur, même page fermée.

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { PushSub } from './store.ts';

export interface VapidKeys { publicKey: string; privateKey: string }

const b64u = (b: Buffer) => b.toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
const info = (s: string) => Buffer.from(s + '\0', 'latin1');

/** une paire de clés P-256 pour VAPID, en base64url (publique : 65 octets non compressés) */
export function newVapidKeys(): VapidKeys {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

/** clés d'un abonnement valables : publique P-256 non compressée, secret d'au moins 16 octets */
export function validKeys(p256dh: string, auth: string): boolean {
  const k = Buffer.from(p256dh, 'base64url'), a = Buffer.from(auth, 'base64url');
  return k.length === 65 && k[0] === 4 && a.length >= 16 && a.length <= 64;
}

/** le message chiffré pour ce navigateur (RFC 8291 : un seul enregistrement, sans bourrage) ; `fixed` : sel et clé
 *  privée imposés (l'exemple de la RFC, dans les tests) */
export function encrypt(payload: Buffer, p256dh: string, auth: string, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  const ua = Buffer.from(p256dh, 'base64url'), secret = Buffer.from(auth, 'base64url');
  const e = createECDH('prime256v1');
  if (fixed) e.setPrivateKey(fixed.privateKey); else e.generateKeys();
  const asPub = e.getPublicKey();
  const ikm = hmac(hmac(secret, e.computeSecret(ua)), Buffer.concat([info('WebPush: info'), ua, asPub, Buffer.from([1])]));
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([info('Content-Encoding: aes128gcm'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([info('Content-Encoding: nonce'), Buffer.from([1])])).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  // 2 : dernier enregistrement
  const body = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}

export class Vapid {
  readonly keys: VapidKeys;
  /** qui joindre (mailto: ou https:) : le service de notification le demande */
  subject: string;
  private key: KeyObject;
  /** jeton signé par service (origine), réutilisé jusqu'à une heure avant sa fin */
  private jwt = new Map<string, { exp: number; t: string }>();

  constructor(keys: VapidKeys, subject: string) {
    this.keys = keys;
    this.subject = subject;
    const pub = Buffer.from(keys.publicKey, 'base64url');
    this.key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  }

  /** l'en-tête Authorization pour ce service */
  header(endpoint: string, nowS: number): string {
    const aud = new URL(endpoint).origin;
    let j = this.jwt.get(aud);
    if (!j || j.exp - nowS < 3600) {
      const exp = Math.floor(nowS) + 12 * 3600;
      const h = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
      const p = b64u(Buffer.from(JSON.stringify({ aud, exp, sub: this.subject })));
      const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key: this.key, dsaEncoding: 'ieee-p1363' });
      j = { exp, t: `${h}.${p}.${b64u(sig)}` };
      this.jwt.set(aud, j);
    }
    return `vapid t=${j.t}, k=${this.keys.publicKey}`;
  }

  /** envoie ; le statut HTTP du service (201 : remis ; 404, 410 : abonnement fini) */
  async send(sub: PushSub, payload: unknown, opts: { ttl: number; urgency: 'normal' | 'high' }, nowS: number): Promise<number> {
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: this.header(sub.endpoint, nowS), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(opts.ttl), Urgency: opts.urgency,
      },
      body: new Uint8Array(encrypt(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth)),
      signal: AbortSignal.timeout(15000),
    });
    await r.arrayBuffer().catch(() => null);
    return r.status;
  }
}
