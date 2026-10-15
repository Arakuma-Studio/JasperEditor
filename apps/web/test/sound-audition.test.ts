// Sound Library audition (spec 12 §2.7): play / stop / toggle, Loop with a 250 ms gap, volume, the Mix meter feed
// (Audio Meters show the audition), failures reported without throwing, and a stale load never starting late.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditionMeter } from '../src/audio/audition-meter.ts';
import { type AuditionAudio, AuditionPlayer, LOOP_GAP_SEC } from '../src/sound/audition.ts';

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

function fakeAudio() {
	const sources: FakeSource[] = [];
	const gains: { gain: { value: number; setTargetAtTime: (v: number) => void } }[] = [];
	const node = () => ({ connect() {}, disconnect() {} });
	const ctx: AuditionAudio = {
		currentTime: 0,
		state: 'running',
		destination: node() as unknown as AudioNode,
		resume: async () => {},
		close: async () => {},
		decodeAudioData: async () => ({ length: 48000, numberOfChannels: 2 }) as AudioBuffer,
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
	return { ctx, sources, gains };
}

let rafs: (() => void)[] = [];
function player(over: Partial<ConstructorParameters<typeof AuditionPlayer>[0]> = {}) {
	const audio = fakeAudio();
	const fetchBytes = vi.fn(async () => new ArrayBuffer(8));
	const p = new AuditionPlayer({
		createContext: () => audio.ctx,
		fetchBytes,
		raf: (cb) => {
			rafs.push(cb);
			return rafs.length;
		},
		cancelRaf: () => {},
		...over,
	});
	return { p, audio, fetchBytes };
}
const sound = { id: 'snd_0000000000000001', title: 'Crunch', url: '/a' };

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
		vi.advanceTimersByTime(LOOP_GAP_SEC * 1000 - 1);
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
});
