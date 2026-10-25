// Sound Library audition (spec 12 §2.7 "Audition", P1-R7): Space plays the selected sound alone, Loop repeats it
// with a 250 ms gap, Auto-play follows the selection. Short sounds are fetched from the engine (`soundAudioUrl`),
// decoded once (a small cache with a total byte budget) and played from memory; a sound whose decoded PCM would exceed
// the decode budget (a long folder WAV: 30 min of stereo 48 kHz is ≈ 690 MB of float PCM) is never fetched whole: it
// streams through an HTMLAudioElement into a MediaElementAudioSourceNode on the same graph, so the audition volume,
// Loop and the Mix meters work the same. Everything plays on the audition's own AudioContext at the audition volume,
// metered for the Mix meters (`auditionMeter`). Auditioning never touches the project document or history, nor the
// Program monitor's AudioContext (Remotion suspends and resumes that one with its transport; resuming it here would
// break primed starts).
import type { MeterReading } from '@jasper/compositions';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { auditionMeter } from '../audio/audition-meter.ts';
import { t } from '../i18n/runtime.ts';

/** Silence between loop repetitions (spec 12 §2.7). */
const LOOP_GAP_SEC = 0.25;
/** Decoded sounds kept (most recently used). */
const CACHE_ENTRIES = 24;
/**
 * Largest decoded sound (bytes of float PCM: duration × channels × sample rate × 4). Longer sounds stream. 32 MB is
 * ≈ 87 s of stereo 48 kHz: every effect of the library decodes; beds and long folder files stream.
 */
const DECODE_MAX_BYTES = 32 * 1024 * 1024;
/** Total bytes of decoded PCM the cache keeps (least recently used dropped first). */
const CACHE_BUDGET_BYTES = 160 * 1024 * 1024;

export type AuditionState = {
	soundId: string | null;
	title: string | null;
	phase: 'idle' | 'loading' | 'playing';
	loop: boolean;
	error: string | null;
	/** Bumped on every start / stop (aria-live announcements). */
	epoch: number;
};

/** What the player needs from an `<audio>` element (streamed auditions; tests pass a fake). */
export type AuditionMediaElement = {
	src: string;
	crossOrigin: string | null;
	preload: string;
	currentTime: number;
	onended: ((this: never, ev: Event) => unknown) | null;
	onerror: ((this: never, ev: Event | string) => unknown) | null;
	play(): Promise<void>;
	pause(): void;
	load(): void;
	removeAttribute(name: string): void;
};

/** What the player needs from Web Audio (an AudioContext; tests pass a fake). */
export type AuditionAudio = {
	readonly currentTime: number;
	readonly state: string;
	readonly destination: AudioNode;
	readonly sampleRate?: number;
	resume(): Promise<void>;
	close(): Promise<void>;
	decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
	createBufferSource(): AudioBufferSourceNode;
	createMediaElementSource?(el: never): AudioNode;
	createGain(): GainNode;
	createChannelSplitter(n: number): ChannelSplitterNode;
	createAnalyser(): AnalyserNode;
};

export type AuditionDeps = {
	createContext(): AuditionAudio | null;
	fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
	/** A new `<audio>` element (streamed auditions), or null when the platform has none. */
	createMediaElement?(): AuditionMediaElement | null;
	/** Animation-frame scheduler for metering (tests: manual). */
	raf(cb: () => void): number;
	cancelRaf(id: number): void;
};

/** A sound to audition: its engine URL and, when known, its format (decides decode vs stream). */
export type AuditionSound = {
	id: string;
	title: string;
	url: string;
	format?: { durationSec?: number; channels?: number; sampleRate?: number } | null;
	/** Only this range of it (seconds; Find Moment, P6-E14): `id` names the range, `cacheId` the whole sound. */
	range?: { startSec: number; endSec: number };
	cacheId?: string;
};

/** A valid range of a sound (start ≥ 0, end after it), or null. */
function rangeOf(sound: AuditionSound): { startSec: number; durSec: number } | null {
	const r = sound.range;
	if (
		!r ||
		!Number.isFinite(r.startSec) ||
		!Number.isFinite(r.endSec) ||
		r.startSec < 0 ||
		!(r.endSec > r.startSec)
	)
		return null;
	return { startSec: r.startSec, durSec: r.endSec - r.startSec };
}

const defaultDeps: AuditionDeps = {
	createContext: () => {
		const Ctx =
			typeof window !== 'undefined'
				? (window.AudioContext ??
					(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
				: undefined;
		return Ctx ? (new Ctx({ latencyHint: 'interactive' }) as unknown as AuditionAudio) : null;
	},
	fetchBytes: async (url, signal) => {
		const r = await fetch(url, { credentials: 'include', signal });
		if (!r.ok) throw new Error(t('The engine answered {0}', r.status));
		return r.arrayBuffer();
	},
	createMediaElement: () =>
		typeof Audio === 'function' ? (new Audio() as unknown as AuditionMediaElement) : null,
	raf: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0),
	cancelRaf: (id) => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
	},
};

const dbToGain = (db: number) => (Number.isFinite(db) ? 10 ** (db / 20) : 1);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * Bytes of float PCM a sound decodes to (at the larger of its own and the context's sample rate), or null when its
 * format is unknown (then it streams: an unknown length may be anything).
 */
export function decodedBytesOf(format: AuditionSound['format'], contextRate?: number): number | null {
	if (!format || !fin(format.durationSec)) return null;
	const channels = fin(format.channels) ? Math.min(64, format.channels) : 2;
	const rate = Math.max(
		fin(format.sampleRate) ? format.sampleRate : 48_000,
		fin(contextRate) ? contextRate : 0,
	);
	return format.durationSec * channels * rate * 4;
}

const bufferBytes = (b: AudioBuffer) =>
	(Number.isFinite(b.length) ? b.length : 0) *
	(Number.isFinite(b.numberOfChannels) ? b.numberOfChannels : 1) *
	4;

export class AuditionPlayer {
	readonly store: StoreApi<AuditionState> = createStore<AuditionState>(() => ({
		soundId: null,
		title: null,
		phase: 'idle',
		loop: false,
		error: null,
		epoch: 0,
	}));
	private ctx: AuditionAudio | null = null;
	private gain: GainNode | null = null;
	private analysers: AnalyserNode[] = [];
	private source: AudioBufferSourceNode | null = null;
	private media: { el: AuditionMediaElement; node: AudioNode } | null = null;
	private token = 0;
	private abort: AbortController | null = null;
	private gapTimer: ReturnType<typeof setTimeout> | null = null;
	/** Ends a streamed range audition (an `<audio>` element has no stop time). */
	private rangeTimer: ReturnType<typeof setTimeout> | null = null;
	private meterRaf = 0;
	private volumeDb = -6;
	private readonly cache = new Map<string, { buffer: AudioBuffer; bytes: number }>();
	private cachedBytes = 0;

	constructor(private readonly deps: AuditionDeps = defaultDeps) {}

	get state(): AuditionState {
		return this.store.getState();
	}

	/** Plays a sound (stopping whatever plays); `url` is the engine's audio URL of the sound. */
	async play(sound: AuditionSound, opts: { loop?: boolean } = {}): Promise<void> {
		this.stopSource();
		const token = ++this.token;
		const loop = opts.loop ?? this.state.loop;
		this.set({ soundId: sound.id, title: sound.title, phase: 'loading', loop, error: null });
		try {
			const ctx = this.context();
			if (!ctx) throw new Error(t('This browser cannot play audio (no Web Audio)'));
			const key = sound.cacheId ?? sound.id;
			let buffer = this.cache.get(key)?.buffer;
			if (buffer) {
				const hit = this.cache.get(key)!;
				this.cache.delete(key);
				this.cache.set(key, hit);
			} else {
				const estimate = decodedBytesOf(sound.format, ctx.sampleRate);
				if (estimate === null || estimate > DECODE_MAX_BYTES) {
					await this.playStreamed(ctx, sound, token);
					return;
				}
				this.abort = new AbortController();
				const bytes = await this.deps.fetchBytes(sound.url, this.abort.signal);
				if (token !== this.token) return;
				buffer = await ctx.decodeAudioData(bytes);
				if (token !== this.token) return;
				this.remember(key, buffer);
			}
			if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
			if (token !== this.token) return;
			this.set({ phase: 'playing' });
			this.startSource(buffer, token, rangeOf(sound));
			this.startMeter();
		} catch (e) {
			this.fail(sound, token, e);
		}
	}

	/** Plays the sound, or stops it when it is the one playing (Space). */
	toggle(sound: AuditionSound): Promise<void> {
		if (this.state.soundId === sound.id && this.state.phase !== 'idle') {
			this.stop();
			return Promise.resolve();
		}
		return this.play(sound);
	}

	stop(): void {
		this.token++;
		this.stopSource();
		if (this.state.phase !== 'idle' || this.state.soundId) this.set({ phase: 'idle', soundId: null });
		this.stopMeter();
	}

	setLoop(loop: boolean): void {
		if (this.state.loop !== loop) this.set({ loop }, false);
	}

	setVolumeDb(db: number): void {
		this.volumeDb = db;
		if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
	}

	dispose(): void {
		this.stop();
		this.cache.clear();
		this.cachedBytes = 0;
		void this.ctx?.close().catch(() => undefined);
		this.ctx = null;
		this.gain = null;
		this.analysers = [];
	}

	private fail(sound: AuditionSound, token: number, e: unknown): void {
		if (token !== this.token) return;
		const aborted = e instanceof DOMException && e.name === 'AbortError';
		this.stopSource();
		this.set({
			phase: 'idle',
			error: aborted
				? null
				: t('Could not play “{0}”: {1}', sound.title, e instanceof Error ? e.message : String(e)),
		});
		this.stopMeter();
	}

	private set(patch: Partial<AuditionState>, bump = true): void {
		const s = this.store.getState();
		this.store.setState({ ...s, ...patch, epoch: bump ? s.epoch + 1 : s.epoch });
	}

	private context(): AuditionAudio | null {
		if (this.ctx) return this.ctx;
		const ctx = this.deps.createContext();
		if (!ctx) return null;
		const gain = ctx.createGain();
		gain.gain.value = dbToGain(this.volumeDb);
		const split = ctx.createChannelSplitter(2);
		const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
		gain.connect(ctx.destination);
		gain.connect(split);
		analysers.forEach((a, i) => {
			a.fftSize = 2048;
			split.connect(a, i);
		});
		this.ctx = ctx;
		this.gain = gain;
		this.analysers = analysers;
		return ctx;
	}

	/** Keeps a decoded sound (LRU), within the per-sound and total byte budgets. */
	private remember(id: string, buffer: AudioBuffer): void {
		const bytes = bufferBytes(buffer);
		if (bytes > DECODE_MAX_BYTES) return; // the format understated it: played, not kept
		const old = this.cache.get(id);
		if (old) {
			this.cache.delete(id);
			this.cachedBytes -= old.bytes;
		}
		this.cache.set(id, { buffer, bytes });
		this.cachedBytes += bytes;
		while (this.cache.size > CACHE_ENTRIES || this.cachedBytes > CACHE_BUDGET_BYTES) {
			const first = this.cache.keys().next().value;
			if (first === undefined) break;
			this.cachedBytes -= this.cache.get(first)?.bytes ?? 0;
			this.cache.delete(first);
		}
	}

	/** A long sound: an `<audio>` element streams it into the same gain / meters (never fetched or decoded whole). */
	private async playStreamed(ctx: AuditionAudio, sound: AuditionSound, token: number): Promise<void> {
		const el = this.deps.createMediaElement?.() ?? null;
		if (!el || typeof ctx.createMediaElementSource !== 'function' || !this.gain)
			throw new Error(t('This browser cannot stream long sounds'));
		el.crossOrigin = 'use-credentials';
		el.preload = 'auto';
		el.src = sound.url;
		const node = ctx.createMediaElementSource(el as never);
		node.connect(this.gain);
		this.media = { el, node };
		el.onerror = () => {
			if (token !== this.token || this.media?.el !== el) return;
			this.fail(sound, token, new Error(t('The sound could not be loaded')));
		};
		el.onended = () => {
			if (token !== this.token || this.media?.el !== el) return;
			if (this.state.loop) {
				this.gapTimer = setTimeout(() => {
					this.gapTimer = null;
					if (token !== this.token || this.state.phase !== 'playing' || this.media?.el !== el) return;
					el.currentTime = 0;
					el.play().catch((e) => this.fail(sound, token, e));
				}, LOOP_GAP_SEC * 1000);
				return;
			}
			this.releaseMedia();
			this.set({ phase: 'idle', soundId: null });
			this.stopMeter();
		};
		if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
		if (token !== this.token) return;
		const range = rangeOf(sound);
		if (range) el.currentTime = range.startSec;
		await el.play();
		if (token !== this.token) return;
		this.set({ phase: 'playing' });
		this.startMeter();
		if (range) {
			// the range ends by a timer (then loops from its start, or stops)
			const arm = () => {
				this.rangeTimer = setTimeout(() => {
					this.rangeTimer = null;
					if (token !== this.token || this.media?.el !== el) return;
					if (this.state.loop) {
						el.currentTime = range.startSec;
						arm();
						return;
					}
					this.releaseMedia();
					this.set({ phase: 'idle', soundId: null });
					this.stopMeter();
				}, range.durSec * 1000);
			};
			arm();
		}
	}

	private startSource(
		buffer: AudioBuffer,
		token: number,
		range: { startSec: number; durSec: number } | null = null,
	): void {
		const ctx = this.ctx;
		if (!ctx || !this.gain) return;
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		src.connect(this.gain);
		src.onended = () => {
			if (token !== this.token || this.source !== src) return;
			this.source = null;
			if (this.state.loop) {
				this.gapTimer = setTimeout(() => {
					this.gapTimer = null;
					if (token === this.token && this.state.phase === 'playing') this.startSource(buffer, token, range);
				}, LOOP_GAP_SEC * 1000);
				return;
			}
			this.set({ phase: 'idle', soundId: null });
			this.stopMeter();
		};
		this.source = src;
		if (range)
			src.start(
				0,
				Number.isFinite(buffer.duration) ? Math.min(range.startSec, buffer.duration) : range.startSec,
				range.durSec,
			);
		else src.start();
	}

	private releaseMedia(): void {
		const m = this.media;
		this.media = null;
		if (!m) return;
		m.el.onended = null;
		m.el.onerror = null;
		try {
			m.el.pause();
			m.el.removeAttribute('src');
			m.el.load();
		} catch {
			// already released
		}
		try {
			m.node.disconnect();
		} catch {
			// not connected
		}
	}

	private stopSource(): void {
		this.abort?.abort();
		this.abort = null;
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = null;
		if (this.rangeTimer) clearTimeout(this.rangeTimer);
		this.rangeTimer = null;
		this.releaseMedia();
		const s = this.source;
		this.source = null;
		if (s) {
			s.onended = null;
			try {
				s.stop();
			} catch {
				// not started
			}
			s.disconnect();
		}
	}

	private startMeter(): void {
		if (this.meterRaf || !this.analysers.length) return;
		const buf = new Float32Array(2048);
		const tick = () => {
			this.meterRaf = 0;
			if (this.state.phase !== 'playing') return;
			const peak: number[] = [];
			const rms: number[] = [];
			const clipped: number[] = [];
			for (const a of this.analysers) {
				const n = Math.min(buf.length, a.fftSize);
				const view = buf.subarray(0, n);
				a.getFloatTimeDomainData(view);
				let p = 0;
				let s = 0;
				for (let i = 0; i < n; i++) {
					const v = Math.abs(view[i]!);
					if (v > p) p = v;
					s += v * v;
				}
				peak.push(p);
				rms.push(Math.sqrt(s / Math.max(1, n)));
				clipped.push(p >= 1 ? 1 : 0);
			}
			const reading: MeterReading = { peak, rms, clipped, at: performance.now() };
			auditionMeter.publish(reading);
			this.meterRaf = this.deps.raf(tick);
		};
		this.meterRaf = this.deps.raf(tick);
	}

	private stopMeter(): void {
		if (this.meterRaf) this.deps.cancelRaf(this.meterRaf);
		this.meterRaf = 0;
		auditionMeter.end();
	}
}

let shared: AuditionPlayer | null = null;
/** The app's audition player (one sound auditions at a time). */
export function auditionPlayer(): AuditionPlayer {
	shared ??= new AuditionPlayer();
	return shared;
}
