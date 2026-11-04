// Types de xc.js pour le serveur (TypeScript) ; la page lit le .js directement.

export type LatLon = [number, number];
/** un point au format du réseau : [t, lat, lon, alt, spd, crs, vz] */
export type Pt = readonly [number, number, number, ...(number | null)[]];
export type RuleName = 'xc20' | 'xc5' | 'cfd';
export interface Rule { gap(P: number): number; scored(P: number, gap: number): number }
export const RULES: Record<RuleName, Rule>;
export interface OpenTri { P: number; pts: LatLon[]; a: number }
export interface ClosedTri { d: number; P: number; gap: number; pts: LatLon[]; s: LatLon; e: LatLon }
export interface Score {
  free: { d: number; pts: LatLon[] };
  open: { fai: OpenTri | null; flat: OpenTri | null };
  closed: Record<RuleName, { fai: ClosedTri | null; flat: ClosedTri | null }>;
}
export function dist(lat1: number, lon1: number, lat2: number, lon2: number): number;
export function scoreFlight(pts: readonly Pt[], opts?: { samples?: number }): Score | null;
export function closingZone(pts: readonly Pt[], tri: OpenTri | null, rule: RuleName): { center: LatLon; radius: number; toGo: number; away: number } | null;
export function circle(center: LatLon, radius: number, steps?: number): [number, number][];
export type LeagueName = 'xcontest' | 'cfd';
export const LEAGUES: Record<LeagueName, { free: number; tiers: { rule: RuleName; flat: number; fai: number }[] }>;
export interface Counted { kind: 'free' | 'flat' | 'fai'; d: number; coef: number; pts: number; rule?: RuleName; tri?: ClosedTri }
export function leagueScore(sc: Score, league: LeagueName): { free: Counted; flat: Counted | null; fai: Counted | null; best: Counted };
