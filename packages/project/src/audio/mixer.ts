// Offline audio mixer (audio-mix): renders the mix of a render snapshot sample-accurately, block by block, from clip
// readers the caller provides (the engine decodes with ffmpeg; the browser's audio scrubbing decodes with
// WebCodecs). Used by every export path (native, hybrid, Remotion: the deliverable's audio always comes from here),
// the loudness / peak / activity analysis and scrubbing. Signal path and solo rules: see `plan.ts`.
//
// * Sample accurate: clip volume, fades, clip pan and every strip lane are evaluated per sample (5.1 panner matrices
//   every 32 samples); the output does not depend on the block size.
// * Latency compensated: processors (clip effects, inserts) report latency; clips pre-roll their processors, and
//   every route into a bus is delayed so all inputs of the bus line up; the whole graph is read ahead by its total
//   latency, so the output is aligned with the timeline.
import {
	balanceGains,
	conversionMatrix,
	type Layout,
	layoutFromChannels,
	type Mixdown,
	pan51Matrix,
	panMonoGains,
} from '@jasper/audio-dsp';
import { evaluate } from '../keyframes.ts';
import { nestGainDbAt, type RenderAudioClip, type RenderSnapshot } from '../render/snapshot.ts';
import type { Animatable } from '../schema/common.ts';
import type { EffectInstance } from '../schema/sequence.ts';
import { syntheticSamples } from '../structure/generators.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import { audioFadeGain } from '../transitions.ts';
import type { RenderStrip } from './plan.ts';
import { type AudioProcessor, audioProcessorFactory } from './processors.ts';
import { formatWidth, holdValueAt } from './strip.ts';

export const MIX_BLOCK = 1024;
const PAN51_STEP = 32;

/** Decoded audio of one clip span at the mix rate (planar). Reads past the end return fewer frames (silence). */
export interface ClipReader {
	readonly channels: number;
	read(out: Float32Array[], frames: number): Promise<number> | number;
	close(): void;
}

/**
 * Opens the decoded audio of `clip` from sample `offset` of its span. The span runs from the clip's head handle to
 * its tail handle (`spanOf`), at the mix sample rate, after speed (tempo or rate change, reverse) and channel
 * mapping (`clip.channels.map`): the reader yields `map.length` channels (or the stream's channels when empty).
 */
export type OpenClip = (
	clip: RenderAudioClip,
	at: { offset: number; length: number; sampleRate: number },
) => Promise<ClipReader | null> | ClipReader | null;

export type MixSnapshot = Pick<RenderSnapshot, 'audioClips' | 'audioMix' | 'settings'>;

export type MixerOptions = {
	snapshot: MixSnapshot;
	openClip: OpenClip;
	/** First sample (absolute, sequence time) to render. */
	startSample: number;
	/** Output layout (export channels); default the Mix format. */
	outputLayout?: Layout;
	/** 5.1 → stereo fold (Premiere "5.1 Mixdown Type"). */
	mixdown?: Mixdown;
	/** Effects without a processor (reported by the planner); default: pass through. */
	onMissingProcessor?: (effect: EffectInstance) => void;
	/** Only these strips contribute (solo-like analysis of a single track); default all. */
	onlyTracks?: ReadonlySet<string>;
	/** Skip strip processing after the track input (track-level analysis): output the sum of the track inputs. */
	tap?: 'master' | 'track-inputs';
};

export function dbToGain(db: number): number {
	return db <= -96 || !Number.isFinite(db) ? 0 : 10 ** (db / 20);
}

/** Sample index of a sequence frame start. */
export function frameToSample(frame: number, fps: Rational, sampleRate: number): number {
	return Math.round((frame * sampleRate * fps.den) / fps.num);
}

/** The sample span `[s0, s1)` a clip plays (head handle … tail handle). */
export function spanOf(clip: RenderAudioClip, fps: Rational, sampleRate: number): [number, number] {
	return [
		frameToSample(clip.start - (clip.headHandle ?? 0), fps, sampleRate),
		frameToSample(clip.start + clip.duration + (clip.tailHandle ?? 0), fps, sampleRate),
	];
}

function layoutOfWidth(w: number): Layout {
	return layoutFromChannels(w);
}

function alloc(n: number, frames: number): Float32Array[] {
	return Array.from({ length: n }, () => new Float32Array(frames));
}

/** Fills `out[0..n)` with an animatable lane at sequence samples `s0…` (flicks = sample · fps). */
function laneFill(
	a: Animatable<number>,
	s0: number,
	n: number,
	fps: number,
	out: Float64Array,
	hold = false,
): boolean {
	if (a.keyframes.length === 0) return false;
	for (let i = 0; i < n; i++) {
		const t = (s0 + i) * fps;
		out[i] = hold ? holdValueAt(a, t) : evaluate(a, t);
	}
	return true;
}

/** A fixed delay line per channel (route latency compensation). */
class Delay {
	private readonly buf: Float32Array[];
	private pos = 0;
	constructor(
		channels: number,
		readonly length: number,
	) {
		this.buf = alloc(channels, Math.max(1, length));
	}
	process(ch: Float32Array[], n: number): void {
		if (this.length === 0) return;
		for (let i = 0; i < n; i++) {
			for (let c = 0; c < ch.length; c++) {
				const b = this.buf[c]!;
				const x = ch[c]![i]!;
				ch[c]![i] = b[this.pos]!;
				b[this.pos] = x;
			}
			this.pos = (this.pos + 1) % this.length;
		}
	}
}

type Route = { target: number; delay: Delay; tapLat: number };

type StripState = {
	s: RenderStrip;
	width: number;
	input: Float32Array[];
	pre: AudioProcessor[];
	post: AudioProcessor[];
	inLat: number;
	preLat: number;
	postLat: number;
	out: Route | null;
	sends: { send: RenderStrip['sends'][number]; route: Route; buf: Float32Array[] }[];
};

type Voice = {
	clip: RenderAudioClip;
	trackIndex: number;
	s0: number;
	s1: number;
	reader: ClipReader | null;
	opening: Promise<ClipReader | null> | null;
	buf: Float32Array[];
	procs: AudioProcessor[];
	primed: boolean;
};

/**
 * The mixer. `render(out, frames)` produces the next `frames` samples of the output layout (planar). Not reentrant:
 * await each call.
 */
export class OfflineMixer {
	readonly sampleRate: number;
	readonly outputLayout: Layout;
	/** Total graph latency in samples (the output is read ahead by it). */
	readonly latency: number;
	private readonly fps: Rational;
	private readonly flicksPerSample: number;
	private readonly strips: StripState[];
	private readonly master: StripState;
	private readonly voices: Voice[];
	private readonly outMatrix: number[][];
	private pos: number;
	private toDiscard: number;
	private readonly scratch: Float64Array;
	private readonly scratch2: Float64Array;
	private readonly tmp: Float32Array[];

	constructor(private readonly o: MixerOptions) {
		const snap = o.snapshot;
		const mix = snap.audioMix;
		if (!mix) throw new Error('The render snapshot has no audioMix');
		this.sampleRate = mix.sampleRate;
		this.fps = snap.settings.fps;
		this.flicksPerSample = FLICKS_PER_SECOND / this.sampleRate;
		const masterLayout = mix.masterFormat as Layout;
		this.outputLayout = o.outputLayout ?? masterLayout;
		this.outMatrix = conversionMatrix(masterLayout, this.outputLayout, o.mixdown ?? 'frontRear');
		this.scratch = new Float64Array(MIX_BLOCK);
		this.scratch2 = new Float64Array(MIX_BLOCK);
		this.tmp = alloc(6, MIX_BLOCK);
		const index = new Map(mix.strips.map((s, i) => [s.id, i]));
		const make = (s: RenderStrip): StripState => {
			const width = formatWidth(s.format);
			const procs = (post: boolean) =>
				s.inserts
					.filter((e) => !!e.postFader === post)
					.map((e) => this.processor(e, width, 'insert'))
					.filter((p): p is AudioProcessor => !!p);
			return {
				s,
				width,
				input: alloc(width, MIX_BLOCK),
				pre: procs(false),
				post: procs(true),
				inLat: 0,
				preLat: 0,
				postLat: 0,
				out: null,
				sends: [],
			};
		};
		this.strips = mix.strips.map(make);
		this.master = this.strips[this.strips.length - 1]!;
		// Latencies in processing order (inputs only come from earlier strips).
		const arrivals = this.strips.map(() => [] as { from: number; tapLat: number; kind: 'out' | number }[]);
		this.strips.forEach((st, i) => {
			const inLat = Math.max(0, ...arrivals[i]!.map((a) => a.tapLat));
			st.inLat = inLat;
			st.preLat = inLat + st.pre.reduce((a, p) => a + p.latency, 0);
			st.postLat = st.preLat + st.post.reduce((a, p) => a + p.latency, 0);
			if (st.s.output !== null) {
				const t = index.get(st.s.output);
				if (t !== undefined) arrivals[t]!.push({ from: i, tapLat: st.postLat, kind: 'out' });
			}
			st.s.sends.forEach((x, k) => {
				const t = index.get(x.target);
				if (t !== undefined)
					arrivals[t]!.push({ from: i, tapLat: x.preFader ? st.preLat : st.postLat, kind: k });
			});
		});
		this.strips.forEach((st, i) => {
			const arrivalOf = (t: number) => Math.max(0, ...arrivals[t]!.map((a) => a.tapLat));
			if (st.s.output !== null) {
				const t = index.get(st.s.output);
				if (t !== undefined) {
					const w = this.strips[t]!.width;
					st.out = { target: t, delay: new Delay(w, arrivalOf(t) - st.postLat), tapLat: st.postLat };
				}
			}
			st.sends = st.s.sends.flatMap((x) => {
				const t = index.get(x.target);
				if (t === undefined) return [];
				const tapLat = x.preFader ? st.preLat : st.postLat;
				const w = this.strips[t]!.width;
				return [
					{
						send: x,
						route: { target: t, delay: new Delay(w, arrivalOf(t) - tapLat), tapLat },
						buf: alloc(w, MIX_BLOCK),
					},
				];
			});
			void i;
		});
		this.latency = this.master.postLat;
		this.pos = o.startSample;
		this.toDiscard = this.latency;
		const played = new Set(mix.strips.filter((s) => s.kind === 'track' && !s.inaudible).map((s) => s.id));
		this.voices = snap.audioClips
			.filter((c) => played.has(c.trackId) && (!o.onlyTracks || o.onlyTracks.has(c.trackId)))
			.map((clip) => {
				const [s0, s1] = spanOf(clip, this.fps, this.sampleRate);
				return {
					clip,
					trackIndex: index.get(clip.trackId) ?? -1,
					s0,
					s1,
					reader: null,
					opening: null,
					buf: [],
					procs: [],
					primed: false,
				};
			})
			.filter((v) => v.trackIndex >= 0 && v.s1 > o.startSample)
			.sort((a, b) => a.s0 - b.s0);
	}

	/** Opens a clip: synthetic sounds (Bars and Tone, leader blips) are generated here; media goes to `openClip`. */
	private async open(clip: RenderAudioClip, at: { offset: number; length: number; sampleRate: number }) {
		if (clip.generator) return generatorReader(clip, at, this.fps);
		return this.o.openClip(clip, at);
	}

	private processor(e: EffectInstance, channels: number, where: 'insert' | 'clip'): AudioProcessor | null {
		const f = audioProcessorFactory(e.effectId);
		if (!f) {
			this.o.onMissingProcessor?.(e);
			return null;
		}
		return f(e, { sampleRate: this.sampleRate, channels, where });
	}

	/** Renders the next `frames` samples into `out` (output layout channels). */
	async render(out: Float32Array[], frames: number): Promise<void> {
		let done = 0;
		while (done < frames) {
			// Discard the graph latency at the start (the output is aligned with the timeline).
			const n = Math.min(MIX_BLOCK, frames - done, this.toDiscard > 0 ? this.toDiscard : MIX_BLOCK);
			const block = alloc(out.length, n);
			await this.block(block, n);
			if (this.toDiscard > 0) {
				this.toDiscard -= n;
				continue;
			}
			for (let c = 0; c < out.length; c++) out[c]!.set(block[c]!, done);
			done += n;
		}
	}

	/** Closes every open clip reader. */
	close(): void {
		for (const v of this.voices) {
			v.reader?.close();
			v.reader = null;
		}
	}

	private async block(out: Float32Array[], n: number): Promise<void> {
		const p0 = this.pos;
		const p1 = p0 + n;
		for (const st of this.strips) for (const ch of st.input) ch.fill(0, 0, n);
		// ---- clips → track inputs
		for (const v of this.voices) {
			if (v.s0 >= p1) break;
			if (v.s1 <= p0) {
				if (v.reader) {
					v.reader.close();
					v.reader = null;
				}
				continue;
			}
			await this.clipBlock(v, p0, n);
		}
		// ---- strips in order
		if (this.o.tap === 'track-inputs') {
			const m = this.master;
			for (const st of this.strips) {
				if (st.s.kind !== 'track') continue;
				const mat = conversionMatrix(layoutOfWidth(st.width), layoutOfWidth(m.width));
				mix(mat, st.input, m.input, n, 1);
			}
			this.writeOut(m.input, out, n);
			this.pos = p1;
			return;
		}
		for (const st of this.strips) this.stripBlock(st, p0, n);
		this.writeOut(this.master.input, out, n);
		this.pos = p1;
	}

	private writeOut(src: Float32Array[], out: Float32Array[], n: number): void {
		for (let c = 0; c < out.length; c++) out[c]!.fill(0, 0, n);
		mix(this.outMatrix, src, out, n, 1);
	}

	private async clipBlock(v: Voice, p0: number, n: number): Promise<void> {
		const a = Math.max(p0, v.s0);
		const b = Math.min(p0 + n, v.s1);
		if (b <= a) return;
		if (!v.reader && !v.opening && v.primed === false) {
			const offset = Math.max(0, a - v.s0);
			v.opening = this.open(v.clip, { offset, length: v.s1 - v.s0 - offset, sampleRate: this.sampleRate });
			v.reader = await v.opening;
			v.opening = null;
			v.primed = true;
			if (!v.reader) return;
			const w = v.reader.channels;
			v.buf = alloc(w, MIX_BLOCK);
			v.procs = v.clip.effects
				.filter((e) => e.enabled)
				.map((e) => this.processor(e, w, 'clip'))
				.filter((p): p is AudioProcessor => !!p);
			// Pre-roll the clip effects' latency so their output lines up with the clip.
			const lat = v.procs.reduce((s, p) => s + p.latency, 0);
			for (let left = lat; left > 0; ) {
				const k = Math.min(MIX_BLOCK, left);
				await this.readClip(v, k, a);
				left -= k;
			}
		}
		if (!v.reader) return;
		const k = b - a;
		await this.readClip(v, k, a);
		this.applyClip(v, a, k, a - p0);
	}

	/** Reads `k` samples of the clip into `v.buf` and runs its effects (time of the block = sample `at`). */
	private async readClip(v: Voice, k: number, at: number): Promise<void> {
		const r = v.reader!;
		const got = await r.read(v.buf, k);
		for (const ch of v.buf) ch.fill(0, Math.max(0, got), k);
		if (v.procs.length) {
			const F = flicksPerFrame(this.fps);
			const c = v.clip;
			const frame = (at * this.fps.num) / (this.sampleRate * this.fps.den);
			const local = frame - c.start;
			const time = c.speed.reverse
				? c.sourceIn + (c.duration - 1 - local) * F * c.speed.rate
				: c.sourceIn + local * F * c.speed.rate;
			const fps = this.flicksPerSample * c.speed.rate * (c.speed.reverse ? -1 : 1);
			for (const p of v.procs)
				p.process(v.buf, k, { sampleRate: this.sampleRate, time, flicksPerSample: fps });
		}
	}

	/** Gain → volume → fades → clip pan → track input, for `k` samples starting at absolute sample `a`. */
	private applyClip(v: Voice, a: number, k: number, dst: number): void {
		const c = v.clip;
		const st = this.strips[v.trackIndex]!;
		const F = flicksPerFrame(this.fps);
		const spf = (this.sampleRate * this.fps.den) / this.fps.num; // samples per frame
		const gain = this.scratch;
		const volAnimated = c.volumeDb.keyframes.length > 0;
		const fades = c.fades;
		const nest = c.nestGain;
		const g0 = c.gainDb + c.volumeDb.value;
		for (let i = 0; i < k; i++) {
			const frame = (a + i) / spf;
			let db = g0;
			if (volAnimated) {
				// Levels of the nearest clip frame inside the clip (handles keep the edge level), like the preview.
				const local = Math.min(c.duration - 1e-9, Math.max(0, frame - c.start));
				const content = c.speed.reverse
					? c.sourceIn + (c.duration - local) * F * c.speed.rate
					: c.sourceIn + local * F * c.speed.rate;
				db = c.gainDb + evaluate(c.volumeDb, content);
			}
			// edit-structure: a clip flattened out of a nested sequence carries the nested levels per frame.
			if (nest) db += nestGainDbAt(nest, Math.floor(frame + 1e-6));
			gain[i] = dbToGain(db) * (fades ? audioFadeGain(fades, frame) : 1);
		}
		const w = v.buf.length;
		const tw = st.width;
		const src = layoutOfWidth(w);
		const mat = conversionMatrix(src, layoutOfWidth(tw));
		const panAnimated = c.pan.keyframes.length > 0;
		const panConst = c.pan.value;
		for (let i = 0; i < k; i++) {
			let pl = 1;
			let pr = 1;
			if (tw === 2) {
				let p = panConst;
				if (panAnimated) {
					const frame = (a + i) / spf;
					const local = Math.min(c.duration - 1e-9, Math.max(0, frame - c.start));
					const content = c.speed.reverse
						? c.sourceIn + (c.duration - local) * F * c.speed.rate
						: c.sourceIn + local * F * c.speed.rate;
					p = evaluate(c.pan, content);
				}
				if (p !== 0) [pl, pr] = balanceGains(Math.max(-1, Math.min(1, p / 100)));
			}
			const g = gain[i]!;
			if (g === 0) continue;
			for (let o = 0; o < tw; o++) {
				const row = mat[o]!;
				let s = 0;
				for (let j = 0; j < w; j++) s += row[j]! * v.buf[j]![i]!;
				st.input[o]![dst + i]! += s * g * (tw === 2 ? (o === 0 ? pl : pr) : 1);
			}
		}
	}

	private stripBlock(st: StripState, p0: number, n: number): void {
		const s = st.s;
		const buf = st.input;
		const fps = this.flicksPerSample;
		if (s.silent) {
			// Solo-muted: nothing leaves the strip; keep the route delays running on silence.
			for (const ch of buf) ch.fill(0, 0, n);
		}
		// input map (stereo strips)
		if (st.width === 2 && s.inputMap !== 'stereo') {
			const [l, r] = buf as [Float32Array, Float32Array];
			for (let i = 0; i < n; i++) {
				const x = l[i]!;
				const y = r[i]!;
				if (s.inputMap === 'left') r[i] = x;
				else if (s.inputMap === 'right') l[i] = y;
				else if (s.inputMap === 'swap') {
					l[i] = y;
					r[i] = x;
				} else {
					const m = (x + y) * 0.5;
					l[i] = m;
					r[i] = m;
				}
			}
		}
		const blockCtx = (lat: number) => ({
			sampleRate: this.sampleRate,
			time: (p0 - lat) * fps,
			flicksPerSample: fps,
		});
		for (const p of st.pre) p.process(buf, n, blockCtx(st.inLat));
		// pre-fader sends (before mute: a muted track keeps sending pre-fader)
		if (!s.silent) for (const x of st.sends) if (x.send.preFader) this.sendBlock(st, x, p0 - st.preLat, n);
		// mute → fader
		const lat = st.preLat;
		const vol = this.scratch;
		const mute = this.scratch2;
		const volA = laneFill(s.volumeDb, p0 - lat, n, fps, vol);
		const muteA = s.kind === 'master' ? false : laneFill(s.mute, p0 - lat, n, fps, mute, true);
		const volC = dbToGain(s.volumeDb.value);
		const muteC = s.kind !== 'master' && s.mute.value >= 0.5 ? 0 : 1;
		for (let i = 0; i < n; i++) {
			const g = (volA ? dbToGain(vol[i]!) : volC) * (muteA ? (mute[i]! >= 0.5 ? 0 : 1) : muteC);
			for (const ch of buf) ch[i]! *= g;
		}
		for (const p of st.post) p.process(buf, n, blockCtx(st.preLat));
		if (!s.silent) for (const x of st.sends) if (!x.send.preFader) this.sendBlock(st, x, p0 - st.postLat, n);
		if (st.out === null) return; // the Mix: `input` is the output
		const target = this.strips[st.out.target]!;
		const tmp = this.tmp;
		for (let c = 0; c < target.width; c++) tmp[c]!.fill(0, 0, n);
		const dest = tmp.slice(0, target.width);
		this.panStage(st, buf, dest, n, p0 - st.postLat, null);
		st.out.delay.process(dest, n);
		if (!s.silent) for (let c = 0; c < target.width; c++) addInto(target.input[c]!, dest[c]!, n);
	}

	private sendBlock(st: StripState, x: StripState['sends'][number], t0: number, n: number): void {
		const target = this.strips[x.route.target]!;
		const dest = x.buf;
		for (const ch of dest) ch.fill(0, 0, n);
		const level = this.scratch2;
		const animated = laneFill(x.send.levelDb, t0, n, this.flicksPerSample, level);
		const c = dbToGain(x.send.levelDb.value);
		const lv = new Float64Array(n);
		for (let i = 0; i < n; i++) lv[i] = animated ? dbToGain(level[i]!) : c;
		this.panStage(st, st.input, dest, n, t0, { pan: x.send.pan, level: lv });
		x.route.delay.process(dest, n);
		for (let ch = 0; ch < target.width; ch++) addInto(target.input[ch]!, dest[ch]!, n);
	}

	/**
	 * Converts the strip signal to its destination bus width with the pan law: 5.1 panner into a 5.1 bus; −3 dB
	 * constant-power pan (mono) or balance (stereo; 5.1 folded with BS.775 first) into a stereo bus; BS.775 into mono.
	 * `send` overrides the pan (static) and applies a per-sample level.
	 */
	private panStage(
		st: StripState,
		src: Float32Array[],
		dest: Float32Array[],
		n: number,
		t0: number,
		send: { pan: number; level: Float64Array } | null,
	): void {
		const s = st.s;
		const w = st.width;
		const ow = dest.length;
		const fps = this.flicksPerSample;
		const srcLayout = layoutOfWidth(w);
		if (ow === 6) {
			const lanes = s.pan51;
			const animated =
				lanes.x.keyframes.length +
					lanes.y.keyframes.length +
					lanes.center.keyframes.length +
					lanes.lfe.keyframes.length >
				0;
			const matAt = (t: number) =>
				pan51Matrix(srcLayout, {
					x: evaluate(lanes.x, t) / 100,
					y: evaluate(lanes.y, t) / 100,
					center: evaluate(lanes.center, t) / 100,
					lfeGain: dbToGain(evaluate(lanes.lfe, t)),
				});
			let mat = matAt(t0 * fps);
			for (let i0 = 0; i0 < n; i0 += PAN51_STEP) {
				if (animated && i0 > 0) mat = matAt((t0 + i0) * fps);
				const i1 = Math.min(n, i0 + PAN51_STEP);
				for (let o = 0; o < 6; o++) {
					const row = mat[o]!;
					const d = dest[o]!;
					for (let j = 0; j < w; j++) {
						const g = row[j]!;
						if (g === 0) continue;
						const x = src[j]!;
						if (send) for (let i = i0; i < i1; i++) d[i]! += g * x[i]! * send.level[i]!;
						else for (let i = i0; i < i1; i++) d[i]! += g * x[i]!;
					}
				}
			}
			return;
		}
		if (ow === 1) {
			const mat = conversionMatrix(srcLayout, 'mono');
			const lv = send?.level;
			const row = mat[0]!;
			for (let j = 0; j < w; j++) {
				const g = row[j]!;
				if (g === 0) continue;
				for (let i = 0; i < n; i++) dest[0]![i]! += g * src[j]![i]! * (lv ? lv[i]! : 1);
			}
			return;
		}
		// stereo destination
		const fold = w === 6 ? conversionMatrix('5.1', 'stereo', this.o.mixdown ?? 'frontRear') : null;
		const panA = send ? null : s.pan;
		const animated = !!panA && panA.keyframes.length > 0;
		const pConst = (send ? send.pan : s.pan.value) / 100;
		let [gl, gr] = w === 1 ? panMonoGains(pConst) : balanceGains(pConst);
		const [L, R] = dest as [Float32Array, Float32Array];
		for (let i = 0; i < n; i++) {
			if (animated) {
				const p = Math.max(-1, Math.min(1, evaluate(panA!, (t0 + i) * fps) / 100));
				[gl, gr] = w === 1 ? panMonoGains(p) : balanceGains(p);
			}
			const lv = send ? send.level[i]! : 1;
			let l: number;
			let r: number;
			if (w === 1) {
				l = src[0]![i]!;
				r = l;
			} else if (w === 2) {
				l = src[0]![i]!;
				r = src[1]![i]!;
			} else {
				l = 0;
				r = 0;
				for (let j = 0; j < 6; j++) {
					l += fold![0]![j]! * src[j]![i]!;
					r += fold![1]![j]! * src[j]![i]!;
				}
			}
			L[i]! += l * gl * lv;
			R[i]! += r * gr * lv;
		}
	}
}

function addInto(dst: Float32Array, src: Float32Array, n: number): void {
	for (let i = 0; i < n; i++) dst[i]! += src[i]!;
}

/** `dst += m · src` (matrix `m[out][in]`) over `n` samples, times `g`. */
function mix(m: number[][], src: Float32Array[], dst: Float32Array[], n: number, g: number): void {
	for (let o = 0; o < dst.length; o++) {
		const row = m[o];
		if (!row) continue;
		for (let j = 0; j < src.length; j++) {
			const k = (row[j] ?? 0) * g;
			if (k === 0) continue;
			const s = src[j]!;
			const d = dst[o]!;
			for (let i = 0; i < n; i++) d[i]! += k * s[i]!;
		}
	}
}

/**
 * A reader of a synthetic sound clip (edit-structure generators) over its span: content time follows the clip's speed
 * and direction; the mono sound is played on every mapped channel.
 */
export function generatorReader(
	clip: RenderAudioClip,
	at: { offset: number; length: number; sampleRate: number },
	fps: Rational,
): ClipReader | null {
	const sound = clip.generator;
	if (!sound) return null;
	const sr = at.sampleRate;
	const F = flicksPerFrame(fps);
	const spf = (sr * fps.den) / fps.num;
	const s0 = frameToSample(clip.start - (clip.headHandle ?? 0), fps, sr);
	const channels = Math.max(1, Math.min(6, clip.channels.map.length || 2));
	const frameSeconds = fps.den / fps.num;
	const rate = clip.speed.rate;
	let pos = at.offset;
	const end = at.offset + at.length;
	return {
		channels,
		read(out: Float32Array[], frames: number): number {
			const n = Math.max(0, Math.min(frames, end - pos));
			if (n === 0) return 0;
			const u0 = (s0 + pos) / spf - clip.start;
			let block: Float32Array;
			if (clip.speed.reverse) {
				const tEnd = (clip.sourceIn + (clip.duration - u0) * F * rate) / FLICKS_PER_SECOND;
				const t0 = tEnd - (n * rate) / sr;
				const fwd = syntheticSamples(sound, Math.max(0, t0), n, sr / rate, frameSeconds);
				block = fwd.reverse();
			} else {
				const t0 = (clip.sourceIn + u0 * F * rate) / FLICKS_PER_SECOND;
				block = syntheticSamples(sound, Math.max(0, t0), n, sr / rate, frameSeconds);
			}
			for (let c = 0; c < channels; c++) out[c]!.set(block.subarray(0, n), 0);
			pos += n;
			return n;
		},
		close(): void {},
	};
}

/** Renders a whole range into memory (tests, short analyses). */
export async function renderMixToBuffers(o: MixerOptions & { length: number }): Promise<Float32Array[]> {
	const m = new OfflineMixer(o);
	const out = alloc(formatWidthOfLayout(m.outputLayout), o.length);
	try {
		await m.render(out, o.length);
	} finally {
		m.close();
	}
	return out;
}

export function formatWidthOfLayout(l: Layout): number {
	return l === 'mono' ? 1 : l === '5.1' ? 6 : 2;
}
