// Compteur par clé (une adresse IP) sur une fenêtre fixe d'une minute.

export class RateLimiter {
  private win = 0;
  private n = new Map<string, number>();
  readonly perMin: number;
  constructor(perMin: number) { this.perMin = perMin; }
  hit(ip: string, cost = 1, nowMs = Date.now()): boolean {
    const w = Math.floor(nowMs / 60000);
    if (w !== this.win) { this.win = w; this.n.clear(); }
    const v = (this.n.get(ip) ?? 0) + cost;
    this.n.set(ip, v);
    return v <= this.perMin;
  }
}
