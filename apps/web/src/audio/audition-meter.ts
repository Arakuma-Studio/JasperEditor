// Meter readings of the Sound Library audition (spec 12 §2.7 "Space plays alone through the Mix"): while a library
// sound auditions, its level is what reaches the output, so the Audio Meters (and the Track Mixer's Mix strip) show it
// in place of the Program mix. The audition has its own AudioContext (sound/audition.ts) and publishes here.
import type { MeterReading } from '@jasper/compositions';

type Listener = (m: MeterReading | null) => void;

let last: MeterReading | null = null;
let active = false;
const listeners = new Set<Listener>();

export const auditionMeter = {
	/** A reading of the audition output (per channel peak / RMS, linear). */
	publish(m: MeterReading): void {
		active = true;
		last = m;
		for (const l of [...listeners]) l(m);
	},
	/** The audition stopped: the meters go back to the Program mix. */
	end(): void {
		if (!active) return;
		active = false;
		last = null;
		for (const l of [...listeners]) l(null);
	},
	active: (): boolean => active,
	last: (): MeterReading | null => last,
	subscribe(l: Listener): () => void {
		listeners.add(l);
		return () => listeners.delete(l);
	},
};
