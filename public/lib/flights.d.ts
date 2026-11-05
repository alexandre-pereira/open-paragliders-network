// Types de flights.js pour le serveur (TypeScript) ; la page lit le .js directement.

import type { Pt } from './xc.js';

export interface Segment { i0: number; i1: number; t0: number; t1: number; air: boolean }
export function splitFlights(pts: readonly Pt[]): Segment[];
export function dayStart(t: number, lon: number | null | undefined): number;
export const CAR_MS: number, CAR_PARK_S: number, CAR_FIXES: number;
export type Kind = 'air' | 'foot' | 'car';
export function groundKind(pts: readonly (readonly (number | null)[])[]): 'foot' | 'car';
export function pilotKind(pts: readonly (readonly (number | null)[])[], inFlight: boolean): Kind;
