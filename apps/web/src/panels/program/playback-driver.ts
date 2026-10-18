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

const NATIVE_MIN_RATE = 0.1;
const NATIVE_MAX_RATE = 1;
const SEEK_HZ = 30;
/**
 * Native play watchdog: when no `frameupdate` arrives for this long while playing (and the Player is not
 * buffering), the Player has stalled. Observed in 4.0.499 with @remotion/media after seeks: the store
 * says playing while the Player sits on one frame until play() is issued again (WP-3I E2E). The stall
 * can also happen after the first frame (61 → 62, then nothing), so the watchdog stays armed for the
 * whole native playback; at slow rates the window grows to three frame periods.
 */
const PLAY_WATCHDOG_MS = 600;
/** Consecutive kicks without any progress in between; progress restores the budget. */
const PLAY_WATCHDOG_RETRIES = 3;
/**
 * A Player that renders slowly (heavy layers on a loaded machine: one frame every 300–700 ms) is not
 * stalled: the window also grows to four times the recent frame interval (of this play and the ones before), up to this bound
 * (measured: the 3-layer `pnpm perf` scenario at ≈ 4 fps was kicked once with the fixed 600 ms window).
 */
const PLAY_WATCHDOG_MAX_ADAPTIVE_MS = 2500;

function isNativeRate(rate: number): boolean {
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

type PlaybackRange = {
	/** Last seekable frame (the sequence end; shows black, TL-834). */
	end: number;
	/** Loop range when loop is on: In/Out if set, else the whole sequence (TL-875). */
	loopStart: number;
	loopEnd: number;
};

type DriverOptions = {
	transport: TransportStore;
	getRange(): PlaybackRange;
	getFps(): number;
	/** Applies the rate to the Player (a React prop in Remotion). */
	setPlayerRate(rate: number): void;
	/** Buffering state for the dropped-frame/buffering indicator. */
	onBuffering?(waiting: boolean): void;
	/**
	 * edit-ux (Premiere's Dropped Frame Indicator): frames skipped during native playback since playback started (a
	 * `frameupdate` that jumps past the next frame counts the frames in between).
	 */
	onDroppedFrames?(count: number): void;
	/**
	 * The Program monitor's audio graph (sound-design Phase 6), when it has one: a seek while playing pauses, seeks and
	 * plays again once the graph has prepared a primed start (`whenPaused`, `afterSeek`), so the audio after the seek
	 * starts on its first sample (the picture holds that long, as on Play).
	 */
	audio?(): { whenPaused(): Promise<void>; afterSeek(): Promise<void> } | null;
};

type DriverMode = 'idle' | 'native' | 'stepping';

/** previews (perf instrumentation): playback counters of a driver (MCP perf_stats, scripts/performance.mjs). */
type PlaybackStats = {
	/** Native plays started since the driver was created. */
	plays: number;
	/** Frames reported by the Player while playing natively, and frames it skipped (dropped). */
	framesShown: number;
	framesDropped: number;
	/** Stalls the watchdog had to restart (the Player sat on a frame while the store played). */
	stallsRecovered: number;
	/** Time spent buffering (`waiting` → `resume`) while playing, ms. */
	bufferingMs: number;
	/** The last finished (or the current) native play. */
	lastPlay: { frames: number; dropped: number; seconds: number; fps: number; rate: number } | null;
	playing: boolean;
};

export class PlaybackDriver implements PlayerController {
	private player: PlayerLike | null = null;
	private mode: DriverMode = 'idle';
	private rate = 1;
	private lastReported = -1;
	private stopAt: number | null = null;
	private returnTo: number | null = null;
	private stepHandle: number | null = null;
	private stepOrigin = { t: 0, frame: 0 };
	private lastSeekAt = Number.NEGATIVE_INFINITY;
	private frameEvents = 0;
	/** Frame-update arrival of this play: last time and a moving average of the interval (ms). */
	private lastFrameAt = -1;
	private frameInterval = 0;
	/** `frameEvents` when the current native play started: equal = its first frame is still pending. */
	private playStartEvents = -1;
	private dropped = 0;
	private buffering = false;
	private watchdog: ReturnType<typeof setTimeout> | null = null;
	private readonly unsubscribe: () => void;
	private counters = { plays: 0, framesShown: 0, framesDropped: 0, stallsRecovered: 0, bufferingMs: 0 };
	private current: { at: number; frames: number; dropped: number; rate: number } | null = null;
	private lastPlay: PlaybackStats['lastPlay'] = null;
	private bufferingSince: number | null = null;
	/** A restart (pause, seek, play) is under way: the frame it plays from (null: where the Player paused). */
	private restarting: { frame: number | null } | null = null;

	constructor(private readonly opts: DriverOptions) {
		this.unsubscribe = opts.transport.subscribe((s, prev) => this.onTransport(s, prev));
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
		this.clearWatchdog();
		this.stopStepping();
		this.setPlayer(null);
		this.unsubscribe();
	}

	seekTo(frame: number): void {
		this.lastReported = frame;
		if (this.mode === 'native' && this.opts.transport.getState().playing) {
			this.restart(frame);
			return;
		}
		this.player?.seekTo(frame);
	}

	/**
	 * Restarts native playback at `frame` (default: where it is): pauses the Player, waits until the audio graph has
	 * prepared a primed start, seeks and plays again (sound-design Phase 6). A seek while playing then starts its audio
	 * on the first sample after the target, and a latency added while playing is taken up (the graph asks for it,
	 * `MixGraph.onRestartRequest`). The transport store stays playing; the picture holds for the primed wait as on Play.
	 * Without an audio graph it is a plain seek.
	 */
	restart(frame?: number): void {
		const p = this.player;
		if (!p || this.mode !== 'native') {
			if (frame !== undefined) p?.seekTo(frame);
			return;
		}
		const audio = this.opts.audio?.() ?? null;
		if (!audio) {
			if (frame !== undefined) p.seekTo(frame);
			return;
		}
		if (this.restarting) {
			// one restart at a time: the latest target wins
			if (frame !== undefined) this.restarting.frame = frame;
			return;
		}
		this.restarting = { frame: frame ?? null };
		this.clearWatchdog();
		p.pause();
		const live = () =>
			this.restarting !== null &&
			this.player === p &&
			this.mode === 'native' &&
			this.opts.transport.getState().playing;
		void (async () => {
			await audio.whenPaused();
			if (!live()) return;
			const target = this.restarting!.frame;
			if (target !== null && target !== p.getCurrentFrame()) {
				p.seekTo(target);
				await audio.afterSeek();
				if (!live()) return;
			}
			this.restarting = null;
			p.play();
			this.armWatchdog(PLAY_WATCHDOG_RETRIES);
		})().finally(() => {
			// abandoned (paused, the Player replaced): nothing is restarting any more
			if (this.restarting && !live()) this.restarting = null;
		});
	}

	play(): void {
		this.rate = this.opts.transport.getState().rate || 1;
		this.resetDroppedFrames();
		this.start();
	}

	/** Dropped frames counted since playback started (or the last reset). */
	get droppedFrames(): number {
		return this.dropped;
	}

	/** Playback counters (perf instrumentation). */
	get stats(): PlaybackStats {
		const live = this.current ? this.playSummary(this.current) : null;
		return { ...this.counters, lastPlay: live ?? this.lastPlay, playing: this.current !== null };
	}

	private playSummary(c: {
		at: number;
		frames: number;
		dropped: number;
		rate: number;
	}): NonNullable<PlaybackStats['lastPlay']> {
		const seconds = Math.max(1e-3, (performance.now() - c.at) / 1000);
		return {
			frames: c.frames,
			dropped: c.dropped,
			seconds: Math.round(seconds * 100) / 100,
			fps: Math.round((c.frames / seconds) * 10) / 10,
			rate: c.rate,
		};
	}

	private endPlay(): void {
		if (!this.current) return;
		this.lastPlay = this.playSummary(this.current);
		this.current = null;
	}

	resetDroppedFrames(): void {
		this.dropped = 0;
		this.opts.onDroppedFrames?.(0);
	}

	pause(): void {
		this.restarting = null;
		this.endPlay();
		this.stopAt = null;
		this.returnTo = null;
		this.clearWatchdog();
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
			if (!this.current) {
				this.counters.plays++;
				this.lastFrameAt = Date.now(); // the first interval is the time to the first frame
				// Retain the measured interval across plays so slow rendering after a seek is not mistaken for a stall.
				this.current = { at: performance.now(), frames: 0, dropped: 0, rate: this.rate };
				this.playStartEvents = this.frameEvents;
			}
			this.armWatchdog(PLAY_WATCHDOG_RETRIES);
			return;
		}
		this.clearWatchdog();
		if (p.isPlaying()) p.pause();
		this.mode = 'stepping';
		this.stepOrigin = { t: performance.now(), frame: this.opts.transport.getState().frame };
		this.lastSeekAt = Number.NEGATIVE_INFINITY;
		if (this.stepHandle === null) this.stepHandle = requestAnimationFrame(this.tick);
	}

	private clearWatchdog(): void {
		if (this.watchdog !== null) {
			clearTimeout(this.watchdog);
			this.watchdog = null;
		}
	}

	/**
	 * Re-issues play() when the Player did not start or stalled while playing (see PLAY_WATCHDOG_MS).
	 * Stays armed while native playback lasts; `retries` counts kicks since the last progress.
	 */
	private armWatchdog(retries: number): void {
		this.clearWatchdog();
		if (retries <= 0 || typeof setTimeout === 'undefined') return;
		const seen = this.frameEvents;
		const framesPerSec = Math.max(1e-3, this.opts.getFps() * Math.abs(this.rate));
		const window = Math.max(
			PLAY_WATCHDOG_MS,
			3000 / framesPerSec,
			// Seeking, decoding, and first draw need twice the steady-frame allowance.
			Math.min(
				PLAY_WATCHDOG_MAX_ADAPTIVE_MS,
				(this.frameEvents === this.playStartEvents ? 8 : 4) * this.frameInterval,
			),
		);
		this.watchdog = setTimeout(() => {
			this.watchdog = null;
			const p = this.player;
			if (!p || this.mode !== 'native' || !this.opts.transport.getState().playing) return;
			if (this.frameEvents !== seen) return this.armWatchdog(PLAY_WATCHDOG_RETRIES); // progressing
			if (this.buffering) return this.armWatchdog(retries); // legitimately buffering: keep watching
			this.counters.stallsRecovered++;
			p.pause();
			p.seekTo(this.opts.transport.getState().frame);
			p.play();
			this.armWatchdog(retries - 1);
		}, window);
	}

	private stopStepping(): void {
		if (this.stepHandle !== null) {
			cancelAnimationFrame(this.stepHandle);
			this.stepHandle = null;
		}
	}

	/** Virtual clock for seek-stepping (TL-873): smooth playhead, throttled Player seeks. */
	private readonly tick = (): void => {
		this.stepHandle = null;
		if (this.mode !== 'stepping') return;
		const t = this.opts.transport;
		const now = performance.now();
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
		this.stepHandle = requestAnimationFrame(this.tick);
	};

	private onTransport(s: TransportState, prev: TransportState): void {
		// External seek while playing (ruler click, timecode entry, K+tap): move the clock.
		if (s.playing && prev.playing && s.frame !== prev.frame && s.frame !== this.lastReported) {
			this.lastReported = s.frame;
			if (this.mode === 'native') this.restart(s.frame);
			else if (this.mode === 'stepping') this.stepOrigin = { t: performance.now(), frame: s.frame };
		}
	}

	private readonly onFrame: Listener = (e) => {
		this.frameEvents++;
		if (this.mode !== 'native') return;
		const now = Date.now();
		if (this.lastFrameAt >= 0) {
			const d = now - this.lastFrameAt;
			this.frameInterval = this.frameInterval > 0 ? this.frameInterval * 0.7 + d * 0.3 : d;
		}
		this.lastFrameAt = now;
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
			this.restart(range.loopStart);
			return;
		}
		// Dropped frames (native forward playback): a jump past the next frame skipped the frames in between.
		if (this.rate > 0 && this.lastReported >= 0 && frame > this.lastReported + 1 && !this.buffering) {
			this.dropped += frame - this.lastReported - 1;
			this.counters.framesDropped += frame - this.lastReported - 1;
			if (this.current) this.current.dropped += frame - this.lastReported - 1;
			this.opts.onDroppedFrames?.(this.dropped);
		}
		this.counters.framesShown++;
		if (this.current) this.current.frames++;
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
		// A restart pauses on purpose.
		if (this.restarting) return;
		// The Player stopped by itself (end reached) while the store still says playing.
		if (this.mode === 'native' && this.opts.transport.getState().playing && !this.player?.isPlaying()) {
			queueMicrotask(() => {
				if (this.mode === 'native' && !this.player?.isPlaying() && !this.opts.transport.getState().loop)
					this.opts.transport.pause();
			});
		}
	};

	private readonly onWaiting: Listener = () => {
		if (!this.buffering && this.mode === 'native') this.bufferingSince = performance.now();
		this.buffering = true;
		this.opts.onBuffering?.(true);
	};
	private readonly onResume: Listener = () => {
		if (this.bufferingSince !== null) this.counters.bufferingMs += performance.now() - this.bufferingSince;
		this.bufferingSince = null;
		this.buffering = false;
		this.opts.onBuffering?.(false);
	};

	private readonly events: [PlayerEvent, Listener][] = [
		['frameupdate', this.onFrame],
		['ended', this.onEnded],
		['pause', this.onPause],
		['waiting', this.onWaiting],
		['resume', this.onResume],
	];
}
