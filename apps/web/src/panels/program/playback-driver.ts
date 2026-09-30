// Player ↔ TransportStore sync (S03:ARC-010, PGM-003; S02:TL-873…875).
//
// The driver is the `PlayerController` attached to the session's TransportStore. It realizes a
// requested rate in one of two modes:
// - native: the Remotion Player plays at the rate and is the clock; its `frameupdate` events are
//   reported to the store;
// - seek-stepping: for reverse rates and rates above NATIVE_MAX_RATE a virtual clock advances the
//   playhead at the requested rate on every animation frame and seeks the (paused) Player at most
//   SEEK_HZ times per second (TL-873). The Player validates rates in [-10, 10], but measured on this
//   CPU-only box (1080p H.264 through @remotion/media) the Player buffers above 1×: 2× advanced at
//   ~16 fps and 4× at ~24 fps instead of 60/120, so the timecode would crawl. Only forward rates ≤ 1×
//   are native; see docs/research/remotion-4.0.499-notes.md.
// While paused the store is the source of truth and the Player is seeked on every store change.
import type { PlayerController, TransportState, TransportStore } from '@jasper/session';

export const NATIVE_MIN_RATE = 0.1;
export const NATIVE_MAX_RATE = 1;
/** Measured validation range of `<Player playbackRate>` in 4.0.499 (validate-playbackrate.js). */
export const PLAYER_RATE_BOUNDS = { min: -10, max: 10 } as const;
export const SEEK_HZ = 30;

export function isNativeRate(rate: number): boolean {
	return rate >= NATIVE_MIN_RATE && rate <= NATIVE_MAX_RATE;
}

type PlayerEvent = 'frameupdate' | 'ended' | 'pause' | 'play' | 'waiting' | 'resume';
type Listener = (e: { detail: unknown }) => void;

/** The subset of the Remotion PlayerRef the driver uses. */
export interface PlayerLike {
	seekTo(frame: number): void;
	play(): void;
	pause(): void;
	getCurrentFrame(): number;
	isPlaying(): boolean;
	mute(): void;
	unmute(): void;
	addEventListener(name: PlayerEvent, cb: Listener): void;
	removeEventListener(name: PlayerEvent, cb: Listener): void;
}

export type Clock = {
	now(): number;
	requestFrame(cb: () => void): unknown;
	cancelFrame(handle: unknown): void;
};

export const browserClock: Clock = {
	now: () => performance.now(),
	requestFrame: (cb) => requestAnimationFrame(() => cb()),
	cancelFrame: (h) => cancelAnimationFrame(h as number),
};

export type PlaybackRange = {
	/** Last seekable frame (the sequence end; shows black, TL-834). */
	end: number;
	/** Loop range when loop is on: In/Out if set, else the whole sequence (TL-875). */
	loopStart: number;
	loopEnd: number;
};

export type DriverOptions = {
	transport: TransportStore;
	getRange(): PlaybackRange;
	getFps(): number;
	/** Applies the rate to the Player (a React prop in Remotion). */
	setPlayerRate(rate: number): void;
	clock?: Clock;
	/** Buffering state for the dropped-frame/buffering indicator. */
	onBuffering?(waiting: boolean): void;
};

export type DriverMode = 'idle' | 'native' | 'stepping';

export class PlaybackDriver implements PlayerController {
	private player: PlayerLike | null = null;
	private mode: DriverMode = 'idle';
	private rate = 1;
	private lastReported = -1;
	private stopAt: number | null = null;
	private returnTo: number | null = null;
	private stepHandle: unknown = null;
	private stepOrigin = { t: 0, frame: 0 };
	private lastSeekAt = Number.NEGATIVE_INFINITY;
	private readonly clock: Clock;
	private readonly off: (() => void)[] = [];

	constructor(private readonly opts: DriverOptions) {
		this.clock = opts.clock ?? browserClock;
		this.off.push(opts.transport.subscribe((s, prev) => this.onTransport(s, prev)));
	}

	get currentMode(): DriverMode {
		return this.mode;
	}

	/** Connects a mounted Player (or disconnects with null). */
	setPlayer(player: PlayerLike | null): void {
		if (this.player === player) return;
		if (this.player) for (const [n, cb] of this.events) this.player.removeEventListener(n, cb);
		this.player = player;
		if (player) {
			for (const [n, cb] of this.events) player.addEventListener(n, cb);
			const s = this.opts.transport.getState();
			player.seekTo(s.frame);
			this.lastReported = s.frame;
			if (s.playing) this.start();
		}
	}

	dispose(): void {
		this.stopStepping();
		this.setPlayer(null);
		for (const o of this.off.splice(0)) o();
	}

	// ------------------------------------------------------------ PlayerController

	seekTo(frame: number): void {
		this.lastReported = frame;
		this.player?.seekTo(frame);
	}

	play(): void {
		this.rate = this.opts.transport.getState().rate || 1;
		this.start();
	}

	pause(): void {
		this.stopAt = null;
		this.returnTo = null;
		this.stopStepping();
		this.mode = 'idle';
		this.player?.pause();
	}

	setPlaybackRate(rate: number): void {
		this.rate = rate || 1;
		if (this.mode !== 'idle') this.start();
	}

	/**
	 * Plays `[from, toExclusive)` at 1× and stops on its last frame (Play In to Out, TL-877), or seeks
	 * to `returnTo` when given (Play Around).
	 */
	playRange(from: number, toExclusive: number, opts: { returnTo?: number } = {}): void {
		const t = this.opts.transport;
		if (t.getState().playing) t.pause();
		t.seek(from);
		t.play(1);
		this.stopAt = Math.max(from + 1, toExclusive);
		this.returnTo = opts.returnTo ?? null;
	}

	// ------------------------------------------------------------ internals

	private start(): void {
		const p = this.player;
		if (!p) return;
		if (isNativeRate(this.rate)) {
			this.stopStepping();
			this.mode = 'native';
			this.opts.setPlayerRate(this.rate);
			// TL-874: audio only at 1× forward.
			if (this.rate === 1) p.unmute();
			else p.mute();
			const s = this.opts.transport.getState();
			if (p.getCurrentFrame() !== s.frame) p.seekTo(s.frame);
			if (!p.isPlaying()) p.play();
			return;
		}
		if (p.isPlaying()) p.pause();
		this.mode = 'stepping';
		this.stepOrigin = { t: this.clock.now(), frame: this.opts.transport.getState().frame };
		this.lastSeekAt = Number.NEGATIVE_INFINITY;
		if (this.stepHandle === null) this.stepHandle = this.clock.requestFrame(this.tick);
	}

	private stopStepping(): void {
		if (this.stepHandle !== null) {
			this.clock.cancelFrame(this.stepHandle);
			this.stepHandle = null;
		}
	}

	/** Virtual clock for seek-stepping (TL-873): smooth playhead, throttled Player seeks. */
	private readonly tick = (): void => {
		this.stepHandle = null;
		if (this.mode !== 'stepping') return;
		const t = this.opts.transport;
		const now = this.clock.now();
		const fps = this.opts.getFps();
		const range = this.opts.getRange();
		let frame = Math.round(this.stepOrigin.frame + ((now - this.stepOrigin.t) / 1000) * fps * this.rate);
		const loop = t.getState().loop;
		let stop = false;
		if (this.rate > 0 && frame >= (loop ? range.loopEnd : range.end)) {
			if (loop) {
				frame = range.loopStart;
				this.stepOrigin = { t: now, frame };
			} else {
				frame = range.end;
				stop = true;
			}
		} else if (this.rate < 0 && frame <= (loop ? range.loopStart : 0)) {
			if (loop) {
				frame = range.loopEnd;
				this.stepOrigin = { t: now, frame };
			} else {
				frame = 0;
				stop = true;
			}
		}
		this.lastReported = frame;
		t.reportFrame(frame);
		if (stop || now - this.lastSeekAt >= 1000 / SEEK_HZ) {
			this.lastSeekAt = now;
			this.player?.seekTo(frame);
		}
		if (stop) {
			t.pause();
			return;
		}
		this.stepHandle = this.clock.requestFrame(this.tick);
	};

	private onTransport(s: TransportState, prev: TransportState): void {
		// External seek while playing (ruler click, timecode entry, K+tap): move the clock.
		if (s.playing && prev.playing && s.frame !== prev.frame && s.frame !== this.lastReported) {
			this.lastReported = s.frame;
			if (this.mode === 'native') this.player?.seekTo(s.frame);
			else if (this.mode === 'stepping') this.stepOrigin = { t: this.clock.now(), frame: s.frame };
		}
	}

	private readonly onFrame: Listener = (e) => {
		if (this.mode !== 'native') return;
		const frame = (e.detail as { frame: number }).frame;
		const t = this.opts.transport;
		if (this.stopAt !== null && frame >= this.stopAt - 1) {
			const at = this.returnTo ?? this.stopAt - 1;
			t.pause();
			t.seek(at);
			return;
		}
		const range = this.opts.getRange();
		if (t.getState().loop && frame >= range.loopEnd && range.loopEnd > range.loopStart) {
			this.lastReported = range.loopStart;
			t.reportFrame(range.loopStart);
			this.player?.seekTo(range.loopStart);
			return;
		}
		this.lastReported = frame;
		t.reportFrame(frame);
	};

	private readonly onEnded: Listener = () => {
		if (this.mode !== 'native') return;
		const t = this.opts.transport;
		const range = this.opts.getRange();
		if (t.getState().loop) {
			this.player?.seekTo(range.loopStart);
			this.player?.play();
			return;
		}
		t.pause();
	};

	private readonly onPause: Listener = () => {
		// The Player stopped by itself (end reached) while the store still says playing.
		if (this.mode === 'native' && this.opts.transport.getState().playing && !this.player?.isPlaying()) {
			queueMicrotask(() => {
				if (this.mode === 'native' && !this.player?.isPlaying() && !this.opts.transport.getState().loop)
					this.opts.transport.pause();
			});
		}
	};

	private readonly onWaiting: Listener = () => this.opts.onBuffering?.(true);
	private readonly onResume: Listener = () => this.opts.onBuffering?.(false);

	private readonly events: [PlayerEvent, Listener][] = [
		['frameupdate', this.onFrame],
		['ended', this.onEnded],
		['pause', this.onPause],
		['waiting', this.onWaiting],
		['resume', this.onResume],
	];
}
