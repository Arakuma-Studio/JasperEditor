// JKL shuttle state machine (S02 Appendix A.8, TL-872; S03:PGM-003). Pure logic over a small target
// interface so it can be unit-tested with fake timers; transport commands drive one instance per
// TransportStore.
const SHUTTLE_RATES = [1, 2, 4, 8] as const;
const K_HOLD_SLOW_RATE = 0.25;
const K_HOLD_DELAY_MS = 250;

type ShuttleKey = 'J' | 'K' | 'L';

export interface ShuttleTarget {
	play(rate: number): void;
	pause(): void;
	/** Moves the playhead by whole frames (pauses first). */
	step(frames: number): void;
	isPlaying(): boolean;
	currentRate(): number;
}

export type TimerApi = {
	setTimeout(cb: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

const defaultTimers: TimerApi = {
	setTimeout: (cb, ms) => setTimeout(cb, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class Shuttle {
	direction: -1 | 0 | 1 = 0;
	step = 0;
	kHeld = false;
	private readonly held = new Set<ShuttleKey>();
	private holdTimer: unknown = null;
	private slowKey: ShuttleKey | null = null;

	constructor(
		private readonly target: ShuttleTarget,
		private readonly timers: TimerApi = defaultTimers,
	) {}

	/** Effective rate of the state machine (0 = paused). */
	get rate(): number {
		return this.direction * SHUTTLE_RATES[this.step]!;
	}

	keyDown(key: ShuttleKey): void {
		if (key === 'K') {
			this.held.add('K');
			this.kHeld = true;
			this.reset();
			this.target.pause();
			return;
		}
		if (this.held.has(key)) return; // auto-repeat
		this.held.add(key);
		const dir = key === 'L' ? 1 : -1;
		if (this.kHeld) {
			// Hold K + tap J/L: one frame; keep holding for 0.25× playback until release.
			this.target.step(dir);
			this.cancelHold();
			this.holdTimer = this.timers.setTimeout(() => {
				this.holdTimer = null;
				if (this.held.has(key) && this.kHeld) {
					this.slowKey = key;
					this.target.play(dir * K_HOLD_SLOW_RATE);
				}
			}, K_HOLD_DELAY_MS);
			return;
		}
		// The transport may have stopped on its own (end of sequence, a click): start over at 1×.
		if (!this.target.isPlaying()) this.direction = 0;
		if (this.direction === dir) this.step = Math.min(this.step + 1, SHUTTLE_RATES.length - 1);
		else {
			this.direction = dir;
			this.step = 0;
		}
		this.target.play(this.rate);
	}

	keyUp(key: ShuttleKey): void {
		this.held.delete(key);
		if (key === 'K') {
			this.kHeld = false;
			return;
		}
		if (this.slowKey === key) {
			this.slowKey = null;
			this.target.pause();
		}
		this.cancelHold();
	}

	/** Space: stop while playing/shuttling, else play 1× forward (A.8 last rule). */
	playStop(): void {
		if (this.target.isPlaying()) {
			this.reset();
			this.target.pause();
		} else {
			this.direction = 1;
			this.step = 0;
			this.target.play(1);
		}
	}

	/** Shift+L / Shift+J: nudge the rate by ±0.1× within ±(0.1…1)× (S02:TL-872 slow shuttle). */
	slow(dir: 1 | -1): void {
		const current = this.target.isPlaying() ? this.target.currentRate() : 0;
		const base = Math.max(-1, Math.min(1, current));
		let next = Math.round((base + dir * 0.1) * 10) / 10;
		next = Math.max(-1, Math.min(1, next));
		this.reset();
		if (next === 0) {
			this.target.pause();
			return;
		}
		this.direction = next > 0 ? 1 : -1;
		this.target.play(next);
	}

	/** Called when the transport stops for other reasons. */
	reset(): void {
		this.direction = 0;
		this.step = 0;
		this.slowKey = null;
		this.cancelHold();
	}

	private cancelHold(): void {
		if (this.holdTimer !== null) {
			this.timers.clearTimeout(this.holdTimer);
			this.holdTimer = null;
		}
	}
}
