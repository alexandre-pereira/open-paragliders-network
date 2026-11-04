// Types de flights.js pour le serveur (TypeScript) ; la page lit le .js directement.

import type { Pt } from './xc.js';

export interface Segment { i0: number; i1: number; t0: number; t1: number; air: boolean }
export function splitFlights(pts: readonly Pt[]): Segment[];
export function dayStart(t: number, lon: number | null | undefined): number;
