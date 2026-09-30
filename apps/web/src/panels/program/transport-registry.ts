// Per-transport helpers shared by the transport commands and the monitors: the JKL shuttle and the
// mounted PlaybackDriver of each TransportStore (the session's for Program, a local one for Source).
import type { TransportStore } from '@jasper/session';
import type { PlaybackDriver } from './playback-driver.ts';
import { Shuttle } from './shuttle.ts';

const shuttles = new WeakMap<TransportStore, Shuttle>();
const drivers = new WeakMap<TransportStore, PlaybackDriver>();
let sourceTransport: TransportStore | null = null;

export function shuttleFor(t: TransportStore): Shuttle {
	let s = shuttles.get(t);
	if (!s) {
		s = new Shuttle({
			play: (rate) => t.play(rate),
			pause: () => t.pause(),
			step: (n) => t.step(n),
			isPlaying: () => t.getState().playing,
			currentRate: () => t.getState().rate,
		});
		shuttles.set(t, s);
		// Any stop (end of media, Space, scrubbing) resets the shuttle state.
		t.subscribe((st, prev) => {
			if (prev.playing && !st.playing) s!.reset();
		});
	}
	return s;
}

export function registerDriver(t: TransportStore, d: PlaybackDriver): () => void {
	drivers.set(t, d);
	return () => {
		if (drivers.get(t) === d) drivers.delete(t);
	};
}

export function driverFor(t: TransportStore): PlaybackDriver | null {
	return drivers.get(t) ?? null;
}

/** The Source monitor publishes its local transport while mounted. */
export function setSourceTransport(t: TransportStore | null): void {
	sourceTransport = t;
}

export function getSourceTransport(): TransportStore | null {
	return sourceTransport;
}
