// Sound Library audition (spec 12 §2.7): play / stop / toggle, Loop with a 250 ms gap, volume, the Mix meter feed
// (Audio Meters show the audition), failures reported without throwing, a stale load never starting late, long sounds
// streamed (never fetched or decoded whole), the decoded cache's byte budget, and "plays alone" with the Program.
import { TransportStore } from '@jasper/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditionMeter } from '../src/audio/audition-meter.ts';
import { type AuditionAudio, type AuditionMediaElement, AuditionPlayer } from '../src/sound/audition.ts';
import { auditionPlaysAlone } from '../src/sound/controller.ts';

type FakeSource = {
	buffer: unknown;
	onended: (() => void) | null;
	started: number;
	stopped: boolean;
	connect(): void;
	disconnect(): void;
	start(): void;
	stop(): void;
};

type FakeElement = AuditionMediaElement & { playing: boolean; plays: number; released: boolean };

function fakeElement(): FakeElement {
	const el: FakeElement = {
		src: '',
		crossOrigin: null,
		preload: '',
		currentTime: 0,
		onended: null,
		onerror: null,
		playing: false,
		plays: 0,
		released: false,
		play: async () => {
			el.playing = true;
			el.plays++;
		},
		pause: () => {
			el.playing = false;
		},
		load: () => {},
		removeAttribute: (n: string) => {
			if (n === 'src') {
				el.src = '';
				el.released = true;
			}
		},
	};
	return el;
}

function fakeAudio() {
	const sources: FakeSource[] = [];
	const elementSources: { el: unknown; connected: unknown[] }[] = [];
	const decode = vi.fn(async () => ({ length: 48000, numberOfChannels: 2 }) as AudioBuffer);
	const gains: { gain: { value: number; setTargetAtTime: (v: number) => void } }[] = [];
	const node = () => ({ connect() {}, disconnect() {} });
	const ctx: AuditionAudio = {
		currentTime: 0,
		state: 'running',
		destination: node() as unknown as AudioNode,
		resume: async () => {},
		close: async () => {},
		decodeAudioData: decode,
		createMediaElementSource: (el: never) => {
			const n = {
				el,
				connected: [] as unknown[],
				connect: (x: unknown) => n.connected.push(x),
				disconnect() {},
			};
			elementSources.push(n);
			return n as unknown as AudioNode;
		},
		createBufferSource: () => {
			const s: FakeSource = {
				buffer: null,
				onended: null,
				started: 0,
				stopped: false,
				connect() {},
				disconnect() {},
				start() {
					s.started++;
				},
				stop() {
					s.stopped = true;
				},
			};
			sources.push(s);
			return s as unknown as AudioBufferSourceNode;
		},
		createGain: () => {
			const g = {
				...node(),
				gain: {
					value: 1,
					setTargetAtTime(v: number) {
						g.gain.value = v;
					},
				},
			};
			gains.push(g);
			return g as unknown as GainNode;
		},
		createChannelSplitter: () => node() as unknown as ChannelSplitterNode,
		createAnalyser: () =>
			({
				...node(),
				fftSize: 2048,
				getFloatTimeDomainData(a: Float32Array) {
					a.fill(0.5);
				},
			}) as unknown as AnalyserNode,
	};
	return { ctx, sources, gains, decode, elementSources };
}

let rafs: (() => void)[] = [];
function player(over: Partial<ConstructorParameters<typeof AuditionPlayer>[0]> = {}) {
	const audio = fakeAudio();
	const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
	const elements: FakeElement[] = [];
	const p = new AuditionPlayer({
		createContext: () => audio.ctx,
		fetchBytes,
		createMediaElement: () => {
			const el = fakeElement();
			elements.push(el);
			return el;
		},
		raf: (cb) => {
			rafs.push(cb);
			return rafs.length;
		},
		cancelRaf: () => {},
		...over,
	});
	return { p, audio, fetchBytes, elements };
}
const FORMAT = { durationSec: 1, channels: 2, sampleRate: 48000 };
const sound = { id: 'snd_0000000000000001', title: 'Crunch', url: '/a', format: FORMAT };

describe('AuditionPlayer', () => {
	beforeEach(() => {
		rafs = [];
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it('plays, feeds the Mix meters, stops at the end, toggles off, and caches the decoded sound', async () => {
		const { p, audio, fetchBytes } = player();
		const readings: unknown[] = [];
		const off = auditionMeter.subscribe((m) => readings.push(m));
		await p.play(sound);
		expect(p.state).toMatchObject({ phase: 'playing', soundId: sound.id, title: 'Crunch' });
		expect(audio.sources).toHaveLength(1);
		rafs.shift()!();
		expect(auditionMeter.active()).toBe(true);
		expect(readings.at(-1)).toMatchObject({ peak: [0.5, 0.5] });
		audio.sources[0]!.onended!();
		expect(p.state.phase).toBe('idle');
		expect(auditionMeter.active()).toBe(false);
		await p.toggle(sound);
		expect(p.state.phase).toBe('playing');
		await p.toggle(sound);
		expect(p.state.phase).toBe('idle');
		expect(audio.sources.at(-1)!.stopped).toBe(true);
		expect(fetchBytes).toHaveBeenCalledTimes(1);
		off();
	});

	it('loops with a 250 ms gap until stopped', async () => {
		const { p, audio } = player();
		p.setLoop(true);
		await p.play(sound);
		audio.sources[0]!.onended!();
		expect(p.state.phase).toBe('playing');
		vi.advanceTimersByTime(249);
		expect(audio.sources).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(audio.sources).toHaveLength(2);
		p.stop();
		audio.sources[1]!.onended?.();
		vi.advanceTimersByTime(1000);
		expect(audio.sources).toHaveLength(2);
		expect(p.state.phase).toBe('idle');
	});

	it('applies the audition volume (dB)', async () => {
		const { p, audio } = player();
		p.setVolumeDb(-20);
		await p.play(sound);
		expect(audio.gains[0]!.gain.value).toBeCloseTo(0.1, 6);
		p.setVolumeDb(0);
		expect(audio.gains[0]!.gain.value).toBeCloseTo(1, 6);
	});

	it('reports failures without throwing (no Web Audio, a failed fetch) and drops a stale load', async () => {
		const none = player({ createContext: () => null });
		await none.p.play(sound);
		expect(none.p.state).toMatchObject({ phase: 'idle' });
		expect(none.p.state.error).toMatch(/Web Audio/);
		const bad = player({ fetchBytes: async () => Promise.reject(new Error('404')) });
		await bad.p.play(sound);
		expect(bad.p.state.error).toMatch(/404/);
		let release!: () => void;
		const slow = player({
			fetchBytes: () =>
				new Promise<ArrayBuffer>((r) => {
					release = () => r(new ArrayBuffer(8));
				}),
		});
		const pending = slow.p.play(sound);
		slow.p.stop();
		release();
		await pending;
		expect(slow.audio.sources).toHaveLength(0);
		expect(slow.p.state.phase).toBe('idle');
	});

	it('streams a long sound (a 30 min folder WAV): never fetched whole nor decoded, same gain, loop and meters', async () => {
		const { p, audio, fetchBytes, elements } = player();
		const long = {
			id: 'snd_00000000000000aa',
			title: 'Room',
			url: '/long',
			format: { durationSec: 1800, channels: 2, sampleRate: 48000 },
		};
		p.setLoop(true);
		p.setVolumeDb(-20);
		await p.play(long);
		expect(audio.decode).not.toHaveBeenCalled();
		expect(fetchBytes).not.toHaveBeenCalled();
		expect(p.state).toMatchObject({ phase: 'playing', soundId: long.id });
		const el = elements[0]!;
		expect(el).toMatchObject({ src: '/long', playing: true, crossOrigin: 'use-credentials' });
		// the element feeds the audition gain (volume, meters)
		expect(audio.elementSources[0]!.connected).toEqual([audio.gains[0]]);
		expect(audio.gains[0]!.gain.value).toBeCloseTo(0.1, 6);
		rafs.shift()!();
		expect(auditionMeter.active()).toBe(true);
		// loop: starts again from 0 after the 250 ms gap
		el.currentTime = 1800;
		(el.onended as () => void)();
		vi.advanceTimersByTime(250);
		expect(el.plays).toBe(2);
		expect(el.currentTime).toBe(0);
		p.stop();
		expect(el.released).toBe(true);
		expect(p.state.phase).toBe('idle');
		// a sound of unknown length streams too (it may be anything)
		await p.play({ id: 'snd_00000000000000ab', title: 'X', url: '/x' });
		expect(audio.decode).not.toHaveBeenCalled();
		expect(elements).toHaveLength(2);
		// a streaming failure is reported, not thrown
		(elements[1]!.onerror as () => void)();
		expect(p.state.phase).toBe('idle');
		expect(p.state.error).toMatch(/could not be loaded/);
	});

	it('evicts the oldest decoded sound at the byte budget and does not cache oversized buffers', async () => {
		// The documented 160 MiB budget fits five 30 MiB buffers; the sixth evicts the oldest.
		// Objects describe buffer size without allocating PCM (docs/wp-notes/sound-design.md, Review fixes).
		const bytes = 30 * 1024 * 1024;
		const { p, audio, fetchBytes } = player();
		(audio.ctx as { decodeAudioData: unknown }).decodeAudioData = async () =>
			({ length: bytes / 8, numberOfChannels: 2 }) as AudioBuffer;
		const request = (i: number) => ({
			id: `snd_${String(i).padStart(16, '0')}`,
			title: `S${i}`,
			url: `/s${i}`,
			format: { durationSec: bytes / (2 * 48000 * 4), channels: 2, sampleRate: 48000 },
		});
		for (let i = 0; i < 6; i++) await p.play(request(i));
		await p.play(request(1));
		expect(fetchBytes).toHaveBeenCalledTimes(6);
		await p.play(request(0));
		expect(fetchBytes).toHaveBeenCalledTimes(7);

		// A decoder may return more PCM than the format promised: still playable, never retained.
		const big = player();
		(big.audio.ctx as { decodeAudioData: unknown }).decodeAudioData = async () =>
			({ length: (60 * 1024 * 1024) / 8, numberOfChannels: 2 }) as AudioBuffer;
		await big.p.play(sound);
		await big.p.play(sound);
		expect(big.p.state.phase).toBe('playing');
		expect(big.fetchBytes).toHaveBeenCalledTimes(2);

		// A large size estimate must stream even when the duration is short.
		const sixty = player();
		await sixty.p.play({
			id: 'snd_00000000000000ff',
			title: 'Bed',
			url: '/bed',
			format: { durationSec: (60 * 1024 * 1024) / (2 * 48000 * 4), channels: 2, sampleRate: 48000 },
		});
		expect(sixty.audio.decode).not.toHaveBeenCalled();
	});

	it('plays alone: starting an audition pauses the Program; the Program starting stops the audition', async () => {
		const { p } = player();
		const transport = new TransportStore();
		const off = auditionPlaysAlone(p, transport);
		transport.play();
		await p.play(sound);
		expect(transport.getState().playing).toBe(false);
		expect(p.state.phase).toBe('playing');
		transport.play();
		expect(p.state.phase).toBe('idle');
		off();
		await p.play(sound);
		expect(transport.getState().playing).toBe(true);
	});
});
