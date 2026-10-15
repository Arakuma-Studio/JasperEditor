// Sound Library audition (spec 12 §2.7 "Audition", P1-R7): Space plays the selected sound alone, Loop repeats it
// with a 250 ms gap, Auto-play follows the selection. The sound is fetched from the engine (`soundAudioUrl`),
// decoded once (a small cache), and played on the audition's own AudioContext at the audition volume, metered for the
// Mix meters (`auditionMeter`). Auditioning never touches the project document or history, nor the Program monitor's
// AudioContext (Remotion suspends and resumes that one with its transport; resuming it here would break primed starts).
import type { MeterReading } from '@jasper/compositions';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { auditionMeter } from '../audio/audition-meter.ts';

/** Silence between loop repetitions (spec 12 §2.7). */
export const LOOP_GAP_SEC = 0.25;
/** Decoded sounds kept (most recently used). */
const CACHE_ENTRIES = 24;
/** Larger files are not cached (bytes of decoded PCM). */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

export type AuditionState = {
	soundId: string | null;
	title: string | null;
	phase: 'idle' | 'loading' | 'playing';
	loop: boolean;
	error: string | null;
	/** Bumped on every start / stop (aria-live announcements). */
	epoch: number;
};

/** What the player needs from Web Audio (an AudioContext; tests pass a fake). */
export type AuditionAudio = {
	readonly currentTime: number;
	readonly state: string;
	readonly destination: AudioNode;
	resume(): Promise<void>;
	close(): Promise<void>;
	decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
	createBufferSource(): AudioBufferSourceNode;
	createGain(): GainNode;
	createChannelSplitter(n: number): ChannelSplitterNode;
	createAnalyser(): AnalyserNode;
};

export type AuditionDeps = {
	createContext(): AuditionAudio | null;
	fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer>;
	/** Animation-frame scheduler for metering (tests: manual). */
	raf(cb: () => void): number;
	cancelRaf(id: number): void;
};

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
		if (!r.ok) throw new Error(`The engine answered ${r.status}`);
		return r.arrayBuffer();
	},
	raf: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0),
	cancelRaf: (id) => {
		if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
	},
};

const dbToGain = (db: number) => (Number.isFinite(db) ? 10 ** (db / 20) : 1);

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
	private token = 0;
	private abort: AbortController | null = null;
	private gapTimer: ReturnType<typeof setTimeout> | null = null;
	private meterRaf = 0;
	private volumeDb = -6;
	private readonly cache = new Map<string, AudioBuffer>();

	constructor(private readonly deps: AuditionDeps = defaultDeps) {}

	get state(): AuditionState {
		return this.store.getState();
	}

	/** Plays a sound (stopping whatever plays); `url` is the engine's audio URL of the sound. */
	async play(
		sound: { id: string; title: string; url: string },
		opts: { loop?: boolean } = {},
	): Promise<void> {
		this.stopSource();
		const token = ++this.token;
		const loop = opts.loop ?? this.state.loop;
		this.set({ soundId: sound.id, title: sound.title, phase: 'loading', loop, error: null });
		try {
			const ctx = this.context();
			if (!ctx) throw new Error('This browser cannot play audio (no Web Audio)');
			let buffer = this.cache.get(sound.id);
			if (!buffer) {
				this.abort = new AbortController();
				const bytes = await this.deps.fetchBytes(sound.url, this.abort.signal);
				if (token !== this.token) return;
				buffer = await ctx.decodeAudioData(bytes);
				if (token !== this.token) return;
				this.remember(sound.id, buffer);
			} else {
				this.cache.delete(sound.id);
				this.cache.set(sound.id, buffer);
			}
			if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
			if (token !== this.token) return;
			this.set({ phase: 'playing' });
			this.startSource(buffer, token);
			this.startMeter();
		} catch (e) {
			if (token !== this.token) return;
			const aborted = e instanceof DOMException && e.name === 'AbortError';
			this.set({
				phase: 'idle',
				error: aborted
					? null
					: `Could not play “${sound.title}”: ${e instanceof Error ? e.message : String(e)}`,
			});
			this.stopMeter();
		}
	}

	/** Plays the sound, or stops it when it is the one playing (Space). */
	toggle(sound: { id: string; title: string; url: string }): Promise<void> {
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
		void this.ctx?.close().catch(() => undefined);
		this.ctx = null;
		this.gain = null;
		this.analysers = [];
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

	private remember(id: string, buffer: AudioBuffer): void {
		const bytes = buffer.length * buffer.numberOfChannels * 4;
		if (bytes > CACHE_MAX_BYTES) return;
		this.cache.set(id, buffer);
		while (this.cache.size > CACHE_ENTRIES) {
			const first = this.cache.keys().next().value;
			if (first === undefined) break;
			this.cache.delete(first);
		}
	}

	private startSource(buffer: AudioBuffer, token: number): void {
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
					if (token === this.token && this.state.phase === 'playing') this.startSource(buffer, token);
				}, LOOP_GAP_SEC * 1000);
				return;
			}
			this.set({ phase: 'idle', soundId: null });
			this.stopMeter();
		};
		this.source = src;
		src.start();
	}

	private stopSource(): void {
		this.abort?.abort();
		this.abort = null;
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = null;
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
/** Tests: replace the shared player. */
export function setAuditionPlayer(p: AuditionPlayer | null): void {
	shared?.dispose();
	shared = p;
}
