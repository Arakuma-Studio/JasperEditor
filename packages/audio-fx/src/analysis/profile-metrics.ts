// Reference-profile metrics (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): what one reference (or the sequence Sound
// Check compares with a profile) does with sound, measured the same way for both, without models. Streaming
// (`ProfileMeter.push` any block sizes, bounded memory: ≈ 10 MB per hour of stereo), deterministic and total: hostile
// input (NaN, ±∞, any rate or channel count) gives finite numbers or null, never a throw.
//
// Adapted from earshot `earshot/profile.py` (MIT, Copyright (c) 2026 Leon Lin; licenses/ported/earshot.md):
//   loudness  integrated (BS.1770), true peak (4× oversampled), LRA, crest = loudest 3 s − integrated;
//   arc       11 points (energy-mean momentary loudness around 0 %, 10 % … 100 %, LU re integrated), opening / closing
//             level (energy mean of the first / last 10 %, at least 0.5 s), position of the loudest 3 s, first sound
//             (the first 100 ms block within 20 LU of integrated, refined on 2 ms levels), longest gap inside (100 ms
//             level 30 LU under integrated);
//   ending    dead air after the last block within 30 LU (refined), fade (last full-level moment, 6 LU under
//             integrated, to the end of sound, − 0.2 s), final moment (loudest momentary of the last 3 s of sound re
//             integrated), final hit ring-out (the strongest onset of the last 4 s when it is in the top quarter);
//   density   onsets per second, salient hits per second (the 100 ms level jumping ≥ 6 dB within 80 ms over the
//             quietest of the 200 ms before, to within 8 LU of integrated; one per run), stop-downs per minute (≥ 10 dB
//             under the median of the preceding 2 s for 0.15–1.5 s, back within 3 dB in 0.3 s);
//   sync      picture events per second and the share with an onset within ±100 ms and within one frame, each with
//             its chance level;
//   spectrum  energy share (dB) in sub 20–60, low 60–250, low-mid 250–1k, mid 1–4k, presence 4–8k, air 8–16k Hz;
//             brightness = the median magnitude-weighted spectral centroid;
//   stereo    side / mid energy (dB; a mono mix counts −40), left / right correlation;
//   speech    the share of 5 s windows that read as speech.
// Changes from earshot: onsets are our `ListenMeter`'s (P6-E6: superflux onsets refined to the attack, only those
// rising ≥ 3 dB over their bed — earshot: librosa's spectral-flux onsets); salient hits are timed at the most prominent
// of those onsets (earshot: the onset-envelope maximum); curves are at 10 ms steps (earshot 20 ms / 100 ms); a gap's
// length adds back the 100 ms window (a 1 s hole reads 1 s, earshot ≈ 0.9 s); the chance of a sync share is the exact
// measure of the union of the tolerance windows over the piece (WP-E3's `syncChance`; earshot shifts the picture
// events by 16 fixed offsets); speech is our model-free Auto Tag classifier per 5 s window (`classifyAudio`; earshot:
// the AudioSet model's "Speech" ≥ 0.5); no music share, tempo or beat grid (models / a beat tracker).
import { defaultChannelWeights, Fft, LoudnessMeter } from '@jasper/audio-dsp';
import {
	REFERENCE_ARC_POINTS,
	REFERENCE_METRIC_KEYS,
	REFERENCE_MONO_DB,
	REFERENCE_PROFILE_LIMITS,
	REFERENCE_SHAPE_KEYS,
	type ReferenceChanceValues,
	type ReferenceMeasurement,
	type ReferenceMetricValues,
} from '@jasper/project';
import { audioCategoryFeatures, classifyAudio } from './audio-category.ts';
import {
	answerPictureEvent,
	LISTEN_SYNC,
	type ListenEvent,
	ListenMeter,
	syncChance,
	syncIndex,
} from './events.ts';

/** The profile measurement's constants (earshot `profile.py` unless said otherwise). */
export const PROFILE_METRICS = {
	/** Fast (100 ms), momentary (400 ms) and short-term (3 s) windows, in 10 ms hops. */
	fastHops: 10,
	momentaryHops: 40,
	shortTermHops: 300,
	/** First sound: within 20 LU of integrated; audible (end of sound): within 30 LU; full level (fade): within 6 LU. */
	loudLu: 20,
	audibleLu: 30,
	fullLu: 6,
	/** Edge refinement: 2 ms levels, the loudest of the next / previous 150 ms, within 20 dB. */
	edgeMs: 2,
	edgeLookMs: 150,
	edgeWithinDb: 20,
	/** Gaps listed for the advice are at least this long (s). */
	gapListSec: 0.5,
	/** Salient hits: a jump of 6 dB within 80 ms over the quietest of the 200 ms before, to within 8 LU. */
	hitJumpDb: 6,
	hitPreHops: 20,
	hitPostHops: 8,
	hitRelLu: -8,
	/** Stop-downs: 10 dB under the median of the preceding 2 s for 0.15–1.5 s, back within 3 dB in 0.3 s. */
	stopDropDb: 10,
	stopBackDb: 3,
	stopMinSec: 0.15,
	stopMaxSec: 1.5,
	stopRefHops: 200,
	stopReturnHops: 30,
	stopSkipHops: 50,
	/** The final hit: the strongest onset of the last 4 s of sound, in the top quarter by prominence. */
	finalLookSec: 4,
	finalTopPercentile: 75,
	finalMomentSec: 3,
	/** Sync: ±100 ms (and one frame); no shares under 3 picture events. */
	syncNearMs: 100,
	/** Spectrum: frames of about 85 ms (4096 at 48 kHz), Hann; bands (Hz). */
	spectrumSec: 0.085,
	bands: {
		sub: [20, 60],
		low: [60, 250],
		lowmid: [250, 1000],
		mid: [1000, 4000],
		presence: [4000, 8000],
		air: [8000, 16000],
	},
	/** Brightness: the median centroid of frames within 40 dB of the 95th-percentile frame energy. */
	brightnessWithinDb: 40,
	/** Speech: 5 s windows (a trailing one of ≥ 1 s counts), classified by `classifyAudio`. */
	speechWindowSec: 5,
	speechMinSec: 1,
} as const;

const BAND_KEYS = ['sub', 'low', 'lowmid', 'mid', 'presence', 'air'] as const;
const fin = (x: number) => x - x === 0;
const rateOf = (sr: number) => (fin(sr) && sr >= 1000 && sr <= 768_000 ? Math.round(sr) : 48_000);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const lufsOf = (meanEnergy: number) => (meanEnergy > 0 ? -0.691 + 10 * Math.log10(meanEnergy) : -120);
const dbOf = (meanSquare: number) => (meanSquare > 0 ? Math.max(-120, 10 * Math.log10(meanSquare)) : -120);

/** Energy mean of levels (dB / LU), null for none. */
function energyMean(levels: readonly number[]): number | null {
	if (!levels.length) return null;
	let e = 0;
	for (const l of levels) e += 10 ** (l / 10);
	return 10 * Math.log10(e / levels.length);
}

function percentile(xs: ArrayLike<number>, p: number): number {
	const n = xs.length;
	if (!n) return Number.NaN;
	const s = Float64Array.from(xs).sort();
	const q = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
	const lo = Math.floor(q);
	const hi = Math.min(n - 1, lo + 1);
	return s[lo]! + (s[hi]! - s[lo]!) * (q - lo);
}

/** A growable float32 series. */
class Grow {
	a: Float32Array;
	n = 0;
	constructor(cap = 4096) {
		this.a = new Float32Array(cap);
	}
	push(v: number): void {
		if (this.n >= this.a.length) {
			const next = new Float32Array(this.a.length * 2);
			next.set(this.a);
			this.a = next;
		}
		this.a[this.n++] = v;
	}
	view(): Float32Array {
		return this.a.subarray(0, this.n);
	}
}

/** Picture events of what is measured: their times (s from the first sample) and the frame rate. */
export type ProfilePicture = { timesSec: readonly number[]; fps: number | null };

/** What the measurement found, for the advice (seconds from the first sample). */
export type ProfileEvents = {
	onsetsSec: number[];
	hitsSec: number[];
	stopdowns: { startSec: number; lengthSec: number; depthDb: number }[];
	/** Silent holes inside (≥ 0.5 s), as earshot lists them. */
	gaps: [number, number][];
	firstSoundSec: number | null;
	soundEndSec: number | null;
	/** Centre of the quietest 3 s of the body (10–90 %) and of the loudest 3 s. */
	quietestSec: number | null;
	loudestSec: number | null;
	picture: {
		/** Every picture event (s) in the measured span. */
		timesSec: number[];
		/** Without an onset within ±100 ms. */
		withoutOnsetSec: number[];
		/** With no sound at all by the listening transcript's ladder (P6-E6: none within a frame, 100 ms or a swell). */
		silentSec: number[];
		/** Without a salient hit within ±100 ms, the strongest first by nothing (time order). */
		withoutHitSec: number[];
	};
};

export type ProfileResult = {
	measurement: ReferenceMeasurement;
	events: ProfileEvents;
	/** Input beyond `maxSeconds` was ignored. */
	truncated: boolean;
	/** Why it cannot be scored (shorter than 3 s, silent), else null. */
	unscorable: string | null;
};

const emptyMetrics = (): ReferenceMetricValues =>
	Object.fromEntries(REFERENCE_METRIC_KEYS.map((k) => [k, null])) as ReferenceMetricValues;

/**
 * Streams planar blocks of a whole mix (a reference file's audio, or the delivered mix of a sequence) and measures the
 * reference-profile metrics (module docs). `finish` once, with the picture events when there is a picture.
 */
export class ProfileMeter {
	readonly sampleRate: number;
	readonly channels: number;
	private readonly loud: LoudnessMeter;
	private readonly listen: ListenMeter;
	private readonly maxSamples: number;
	private samples = 0;
	private truncated = false;
	private finished: ProfileResult | null = null;
	// 2 ms mean square of the mono mean
	private readonly e2 = new Grow(8192);
	private readonly e2Hop: number;
	private e2Acc = 0;
	private e2N = 0;
	// spectrum
	private readonly fft: Fft;
	private readonly frame: Float64Array;
	private readonly im: Float64Array;
	private readonly win: Float64Array;
	private frameN = 0;
	private readonly bandE = new Float64Array(6);
	private readonly bandBins: [number, number][];
	private readonly centroids = new Grow(4096);
	private readonly frameE = new Grow(4096);
	// stereo
	private ll = 0;
	private rr = 0;
	private lr = 0;
	// speech
	private readonly speechLen: number;
	private speechBuf: Float32Array;
	private speechN = 0;
	private speechWindows = 0;
	private speechVoiced = 0;

	constructor(sampleRate: number, channels: number, opts: { maxSeconds?: number } = {}) {
		this.sampleRate = rateOf(sampleRate);
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		const sr = this.sampleRate;
		this.loud = new LoudnessMeter(sr, this.channels, { weights: defaultChannelWeights(this.channels) });
		const maxSec = Math.min(
			REFERENCE_PROFILE_LIMITS.maxSec,
			fin(opts.maxSeconds ?? Number.NaN) && opts.maxSeconds! > 0
				? opts.maxSeconds!
				: REFERENCE_PROFILE_LIMITS.maxSec,
		);
		this.listen = new ListenMeter(sr, this.channels, { maxSeconds: maxSec + 1 });
		this.maxSamples = Math.floor(maxSec * sr);
		this.e2Hop = Math.max(1, Math.round((sr * PROFILE_METRICS.edgeMs) / 1000));
		let n = 256;
		while (n < sr * PROFILE_METRICS.spectrumSec && n < 1 << 16) n *= 2;
		this.fft = new Fft(n);
		this.frame = new Float64Array(n);
		this.im = new Float64Array(n);
		this.win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
		const binHz = sr / n;
		this.bandBins = BAND_KEYS.map((k) => {
			const [a, b] = PROFILE_METRICS.bands[k];
			const lo = Math.max(1, Math.ceil(a / binHz));
			const hi = Math.min(n / 2, Math.ceil(b / binHz));
			return [lo, hi] as [number, number];
		});
		this.speechLen = Math.round(PROFILE_METRICS.speechWindowSec * sr);
		this.speechBuf = new Float32Array(this.speechLen);
	}

	/** Samples measured so far. */
	get length(): number {
		return this.samples;
	}

	push(planar: readonly (Float32Array | undefined)[], n: number): void {
		if (this.finished) return;
		let len = Math.max(0, Math.floor(fin(n) ? n : 0));
		if (this.samples + len > this.maxSamples) {
			len = Math.max(0, this.maxSamples - this.samples);
			this.truncated = true;
		}
		if (len === 0) return;
		const ch = this.channels;
		const blocks: Float32Array[] = [];
		for (let c = 0; c < ch; c++) {
			const src = planar[c];
			const out = new Float32Array(len);
			if (src)
				for (let i = 0; i < len && i < src.length; i++) {
					const v = src[i]!;
					out[i] = fin(v) ? v : 0;
				}
			blocks.push(out);
		}
		this.loud.process(blocks, 0, len);
		this.listen.push(blocks, len);
		const L = blocks[0]!;
		const R = blocks[1] ?? null;
		const inv = 1 / ch;
		for (let i = 0; i < len; i++) {
			let m = 0;
			for (let c = 0; c < ch; c++) m += blocks[c]![i]!;
			m *= inv;
			// 2 ms levels
			this.e2Acc += m * m;
			if (++this.e2N === this.e2Hop) {
				this.e2.push(this.e2Acc / this.e2N);
				this.e2Acc = 0;
				this.e2N = 0;
			}
			// spectrum
			this.frame[this.frameN++] = m;
			if (this.frameN === this.frame.length) this.spectrumFrame();
			// speech windows
			this.speechBuf[this.speechN++] = m;
			if (this.speechN === this.speechLen) this.speechWindow();
			// stereo
			if (R) {
				const l = L[i]!;
				const r = R[i]!;
				this.ll += l * l;
				this.rr += r * r;
				this.lr += l * r;
			}
		}
		this.samples += len;
	}

	private spectrumFrame(): void {
		const n = this.frame.length;
		for (let i = 0; i < n; i++) {
			this.frame[i] = this.frame[i]! * this.win[i]!;
			this.im[i] = 0;
		}
		this.fft.forward(this.frame, this.im);
		const binHz = this.sampleRate / n;
		let num = 0;
		let den = 0;
		let total = 0;
		for (let b = 0; b < BAND_KEYS.length; b++) {
			const [lo, hi] = this.bandBins[b]!;
			let e = 0;
			for (let k = lo; k < hi; k++) {
				const p = this.frame[k]! * this.frame[k]! + this.im[k]! * this.im[k]!;
				e += p;
				const mag = Math.sqrt(p);
				num += mag * k * binHz;
				den += mag;
			}
			this.bandE[b]! += e;
			total += e;
		}
		this.centroids.push(den > 0 ? num / den : 0);
		this.frameE.push(total);
		this.frameN = 0;
	}

	private speechWindow(): void {
		const len = this.speechN;
		this.speechN = 0;
		if (len < PROFILE_METRICS.speechMinSec * this.sampleRate) return;
		this.speechWindows++;
		try {
			const x = len === this.speechBuf.length ? this.speechBuf : this.speechBuf.subarray(0, len);
			const f = audioCategoryFeatures({ channels: [x], sampleRate: this.sampleRate }, len / this.sampleRate);
			if (classifyAudio(f).category === 'dialogue') this.speechVoiced++;
		} catch {
			// not classifiable: not speech
		}
	}

	/** The metrics; `picture` gives the sync shares (picture events, s from the first sample, and the frame rate). */
	finish(picture?: ProfilePicture | null): ProfileResult {
		if (this.finished) return this.finished;
		if (this.e2N > 0) this.e2.push(this.e2Acc / this.e2N);
		if (this.speechN > 0) this.speechWindow();
		this.loud.flush();
		const loud = this.loud.summary();
		const la = this.listen.finish();
		const sr = this.sampleRate;
		const dur = this.samples / sr;
		const v = emptyMetrics();
		const chance: ReferenceChanceValues = { cuts_with_sound: null, cut_frame_sync: null };
		const events: ProfileEvents = {
			onsetsSec: [],
			hitsSec: [],
			stopdowns: [],
			gaps: [],
			firstSoundSec: null,
			soundEndSec: null,
			quietestSec: null,
			loudestSec: null,
			picture: { timesSec: [], withoutOnsetSec: [], silentSec: [], withoutHitSec: [] },
		};
		const I = loud.integrated;
		const silent = !fin(I) || I <= -69.5;
		const unscorable =
			dur < REFERENCE_PROFILE_LIMITS.minSec
				? `shorter than ${REFERENCE_PROFILE_LIMITS.minSec} s (${dur.toFixed(2)} s)`
				: silent
					? 'silent (nothing above −70 LUFS)'
					: null;
		const mono = this.isMono();
		const measurement: ReferenceMeasurement = {
			durationSec: r3(dur),
			hasPicture: !!picture,
			fps: picture?.fps && fin(picture.fps) && picture.fps > 0 ? r3(picture.fps) : null,
			mono,
			metrics: v,
			chance,
			arc: null,
		};
		if (unscorable) {
			this.finished = { measurement, events, truncated: this.truncated, unscorable };
			return this.finished;
		}

		// ── loudness ────────────────────────────────────────────────────────────────────────────────────────────────
		v.lufs_i = r3(I);
		v.true_peak = fin(loud.truePeakDb) ? r3(loud.truePeakDb) : null;
		v.lra = fin(loud.lra) ? r3(loud.lra) : null;
		v.crest_lu = fin(loud.maxShortTerm) ? r3(loud.maxShortTerm - I) : null;

		// curves (centred windows at 10 ms steps, times = centres)
		const k = la.hop10.kEnergy;
		const hopS = la.hop10.samples;
		const H = 0.01;
		const nh = Math.min(la.hop10.count, Math.ceil(dur / H));
		const cum = new Float64Array(nh + 1);
		for (let i = 0; i < nh; i++) cum[i + 1] = cum[i]! + (fin(k[i]!) ? k[i]! : 0);
		const curve = (w: number) => {
			const out = new Float32Array(nh);
			const h0 = Math.floor(w / 2);
			for (let i = 0; i < nh; i++) {
				const a = Math.max(0, i - h0);
				const b = Math.min(nh, i - h0 + w);
				out[i] = b > a ? lufsOf((cum[b]! - cum[a]!) / ((b - a) * hopS)) : -120;
			}
			return out;
		};
		const Lf = curve(PROFILE_METRICS.fastHops);
		const Lm = curve(PROFILE_METRICS.momentaryHops);
		const Ls = curve(PROFILE_METRICS.shortTermHops);
		const tOf = (i: number) => (i + 0.5) * H;
		if (nh > 2) {
			const span = Math.max(0.1 * dur, 0.5);
			const intro: number[] = [];
			const outro: number[] = [];
			for (let i = 0; i < nh; i++) {
				if (tOf(i) <= span) intro.push(Lm[i]!);
				if (tOf(i) >= dur - span) outro.push(Lm[i]!);
			}
			const a = energyMean(intro);
			const b = energyMean(outro);
			v.intro_lu = a === null ? null : r3(a - I);
			v.end_lu = b === null ? null : r3(b - I);
			// the arc
			const w = Math.max(1.5, 0.05 * dur);
			measurement.arc = Array.from({ length: REFERENCE_ARC_POINTS }, (_, p) => {
				const at = (p / (REFERENCE_ARC_POINTS - 1)) * dur;
				const sel: number[] = [];
				const lo = Math.max(0, Math.floor((at - w) / H));
				const hi = Math.min(nh - 1, Math.ceil((at + w) / H));
				for (let i = lo; i <= hi; i++) if (Math.abs(tOf(i) - at) <= w) sel.push(Lm[i]!);
				const e = energyMean(sel);
				return e === null ? null : r1(e - I);
			});
		}
		let il = 0;
		for (let i = 1; i < nh; i++) if (Ls[i]! > Ls[il]!) il = i;
		if (nh > 1) events.loudestSec = r3(tOf(il));
		if (nh > 1 && dur >= 6) v.peak_pos = r3(tOf(il) / dur);
		{
			let iq = -1;
			for (let i = 0; i < nh; i++) {
				const t = tOf(i);
				if (t <= 0.1 * dur || t >= 0.9 * dur) continue;
				if (iq < 0 || Ls[i]! < Ls[iq]!) iq = i;
			}
			if (iq >= 0) events.quietestSec = r3(tOf(iq));
		}

		// ── first sound, end of sound, gaps, fade, final moment ──────────────────────────────────────────────────────
		const e2 = this.e2.view();
		const e2Sec = this.e2Hop / sr;
		const e2Db = (i: number) => dbOf(e2[i]!);
		// refine a 100 ms block's time (centred at t) on 2 ms levels: the first (last) 2 ms within 20 dB of the loudest
		// of the 150 ms after (before) it, searched ±100 ms around t (decision: earshot searches the block only, which a
		// centred block straddling the edge can miss by half its length)
		const edge = (t: number, first: boolean): number => {
			const at = (s: number) => Math.min(e2.length, Math.max(0, Math.floor(s / e2Sec)));
			const a = at(t - 0.1);
			const b = Math.min(e2.length, at(t + 0.1) + 1);
			if (b <= a) return Math.max(0, t);
			const look = PROFILE_METRICS.edgeLookMs / 1000;
			const ra = first ? a : at(t - 0.1 - look);
			const rb = first ? Math.min(e2.length, at(t + 0.1 + look) + 1) : b;
			let ref = -120;
			for (let i = ra; i < rb; i++) ref = Math.max(ref, e2Db(i));
			let pick = -1;
			for (let i = a; i < b; i++)
				if (e2Db(i) >= ref - PROFILE_METRICS.edgeWithinDb) {
					pick = i;
					if (first) break;
				}
			if (pick < 0) return Math.max(0, t);
			return r3((first ? pick : pick + 1) * e2Sec);
		};
		let firstLoud = -1;
		let lastAudible = -1;
		for (let i = 0; i < nh; i++) {
			if (firstLoud < 0 && Lf[i]! > I - PROFILE_METRICS.loudLu) firstLoud = i;
			if (Lf[i]! > I - PROFILE_METRICS.audibleLu) lastAudible = i;
		}
		let tEnd = dur;
		if (firstLoud >= 0) {
			v.first_sound_s = edge(tOf(firstLoud), true);
			events.firstSoundSec = v.first_sound_s;
		}
		const onsets = la.events.filter(
			(e) => e.shape === 'hit' && e.prominenceDb >= LISTEN_SYNC.minProminenceDb && e.ms / 1000 < dur,
		);
		events.onsetsSec = onsets.map((e) => r3(e.ms / 1000));
		if (lastAudible >= 0) {
			tEnd = Math.min(dur, edge(tOf(lastAudible), false));
			events.soundEndSec = r3(tEnd);
			v.end_silence_s = r3(Math.max(0, dur - tEnd));
			let full = -1;
			for (let i = 0; i < nh; i++) if (Lm[i]! >= I - PROFILE_METRICS.fullLu && tOf(i) <= tEnd) full = i;
			if (full >= 0) v.fade_s = r3(Math.max(0, tEnd - tOf(full) - 0.2));
			// gaps between the first sound and the end of sound: the 100 ms level 30 LU under (the window added back)
			const from = v.first_sound_s ?? 0;
			let best = 0;
			let run = 0;
			let runStart = -1;
			const close = (endIdx: number) => {
				if (run <= 0) return;
				const len = run * H + (PROFILE_METRICS.fastHops - 1) * H;
				best = Math.max(best, len);
				const s0 = tOf(runStart) - (PROFILE_METRICS.fastHops / 2) * H;
				const s1 = tOf(endIdx - 1) + (PROFILE_METRICS.fastHops / 2) * H;
				if (len >= PROFILE_METRICS.gapListSec && events.gaps.length < 50) events.gaps.push([r3(s0), r3(s1)]);
			};
			let inside = 0;
			for (let i = 0; i < nh; i++) {
				const t = tOf(i);
				if (t < from || t > tEnd) continue;
				inside++;
				if (Lf[i]! < I - PROFILE_METRICS.audibleLu) {
					if (run === 0) runStart = i;
					run++;
				} else {
					close(i);
					run = 0;
				}
			}
			close(Math.min(nh, Math.floor(tEnd / H)));
			v.max_gap_s = inside > 1 ? r3(best) : 0;
			let fl = Number.NEGATIVE_INFINITY;
			for (let i = 0; i < nh; i++) {
				const t = tOf(i);
				if (t >= tEnd - PROFILE_METRICS.finalMomentSec && t <= tEnd) fl = Math.max(fl, Lm[i]!);
			}
			if (fin(fl)) v.final_lu = r3(fl - I);
			// the final hit's ring-out
			if (onsets.length) {
				const p75 = percentile(
					onsets.map((e) => e.prominenceDb),
					PROFILE_METRICS.finalTopPercentile,
				);
				let j: ListenEvent | null = null;
				for (const e of onsets) {
					const t = e.ms / 1000;
					if (t >= tEnd - PROFILE_METRICS.finalLookSec && t < tEnd && (!j || e.prominenceDb > j.prominenceDb))
						j = e;
				}
				if (j && j.prominenceDb >= p75) v.tail_s = r3(tEnd - j.ms / 1000);
			}
		}

		// ── density ─────────────────────────────────────────────────────────────────────────────────────────────────
		v.onset_rate = dur > 0 ? r3(onsets.length / dur) : null;
		events.hitsSec = this.salientHits(Lf, I, onsets, nh);
		v.hit_rate = dur > 0 ? r3(events.hitsSec.length / dur) : null;
		events.stopdowns = stopdowns(Lf, nh);
		v.stopdowns_min = dur >= 6 ? r3((events.stopdowns.length / dur) * 60) : null;

		// ── sync ────────────────────────────────────────────────────────────────────────────────────────────────────
		if (picture) {
			const times = [...picture.timesSec].filter((t) => fin(t) && t >= 0 && t < dur).sort((a, b) => a - b);
			events.picture.timesSec = times.map(r3);
			v.cut_rate = r3(times.length / dur);
			const fps = measurement.fps;
			const frameMs = fps ? 1000 / fps : LISTEN_SYNC.defaultFrameMs;
			const onsetMs = onsets.map((e) => e.ms);
			const sorted = Float64Array.from(onsetMs).sort();
			const hitsMs = Float64Array.from(events.hitsSec.map((t) => t * 1000)).sort();
			const near = (arr: Float64Array, t: number, tol: number) => {
				let lo = 0;
				let hi = arr.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (arr[mid]! < t) lo = mid + 1;
					else hi = mid;
				}
				for (const j of [lo - 1, lo])
					if (j >= 0 && j < arr.length && Math.abs(arr[j]! - t) <= tol + 1e-9) return true;
				return false;
			};
			const ix = syncIndex(la.events.filter((e) => e.ms / 1000 < dur));
			for (const t of times) {
				const ms = t * 1000;
				if (!near(sorted, ms, PROFILE_METRICS.syncNearMs)) events.picture.withoutOnsetSec.push(r3(t));
				if (!near(hitsMs, ms, PROFILE_METRICS.syncNearMs)) events.picture.withoutHitSec.push(r3(t));
				if (answerPictureEvent(ix, ms, frameMs).status === 'none') events.picture.silentSec.push(r3(t));
			}
			if (times.length >= REFERENCE_PROFILE_LIMITS.minPictureEvents) {
				const share = (tol: number) =>
					r3(times.filter((t) => near(sorted, t * 1000, tol)).length / times.length);
				v.cuts_with_sound = share(PROFILE_METRICS.syncNearMs);
				v.cut_frame_sync = share(frameMs);
				chance.cuts_with_sound = r3(syncChance(onsetMs, 0, dur * 1000, PROFILE_METRICS.syncNearMs));
				chance.cut_frame_sync = r3(syncChance(onsetMs, 0, dur * 1000, frameMs));
			}
		}

		// ── spectrum, stereo, speech ────────────────────────────────────────────────────────────────────────────────
		const total = this.bandE.reduce((a, b) => a + b, 0);
		if (total > 0)
			BAND_KEYS.forEach((b, i) => {
				const e = this.bandE[i]!;
				v[`band_${b}` as keyof ReferenceMetricValues] = r3(
					e > 0 ? Math.max(-120, 10 * Math.log10(e / total)) : -120,
				);
			});
		const fe = this.frameE.view();
		if (fe.length) {
			const ref = percentile(fe, 95);
			const floor = ref * 10 ** (-PROFILE_METRICS.brightnessWithinDb / 10);
			const cs: number[] = [];
			const cv = this.centroids.view();
			for (let i = 0; i < fe.length; i++) if (fe[i]! > 0 && fe[i]! >= floor) cs.push(cv[i]!);
			if (cs.length) v.brightness_hz = Math.round(percentile(cs, 50));
		}
		if (mono) {
			v.side_to_mid_db = REFERENCE_MONO_DB;
			v.correlation = 1;
		} else {
			const mm = (this.ll + 2 * this.lr + this.rr) / 4;
			const ss = (this.ll - 2 * this.lr + this.rr) / 4;
			v.side_to_mid_db =
				mm > 0 ? r3(Math.max(REFERENCE_MONO_DB, 10 * Math.log10(Math.max(ss, 1e-30) / mm))) : null;
			const d = Math.sqrt(this.ll * this.rr);
			v.correlation = d > 0 ? r3(Math.max(-1, Math.min(1, this.lr / d))) : null;
		}
		v.speech_frac = this.speechWindows ? r3(this.speechVoiced / this.speechWindows) : null;
		if (dur < REFERENCE_PROFILE_LIMITS.shortSec) for (const key of REFERENCE_SHAPE_KEYS) v[key] = null;
		this.finished = { measurement, events, truncated: this.truncated, unscorable: null };
		return this.finished;
	}

	/** One channel, or identical channels (side 60 dB or more under mid). */
	private isMono(): boolean {
		if (this.channels < 2) return true;
		const mm = (this.ll + 2 * this.lr + this.rr) / 4;
		const ss = (this.ll - 2 * this.lr + this.rr) / 4;
		return !(mm > 0) || ss <= mm * 1e-6;
	}

	private salientHits(Lf: Float32Array, I: number, onsets: readonly ListenEvent[], nh: number): number[] {
		const P = PROFILE_METRICS;
		if (nh < 20) return [];
		const idx: number[] = [];
		for (let i = 0; i < nh; i++) {
			let pre = Number.POSITIVE_INFINITY;
			for (let j = Math.max(0, i - P.hitPreHops); j < i; j++) pre = Math.min(pre, Lf[j]!);
			if (i === 0) pre = Lf[0]!;
			if (i < P.hitPreHops) pre = Math.min(pre, Lf[0]!);
			let post = Number.NEGATIVE_INFINITY;
			for (let j = i; j < Math.min(nh, i + P.hitPostHops); j++) post = Math.max(post, Lf[j]!);
			if (post - pre >= P.hitJumpDb && post >= I + P.hitRelLu) idx.push(i);
		}
		const out: number[] = [];
		let s = 0;
		while (s < idx.length) {
			let e = s;
			while (e + 1 < idx.length && idx[e + 1]! - idx[e]! <= 2) e++;
			const t0 = (idx[s]! + 0.5) * 0.01;
			const t1 = (idx[e]! + 0.5) * 0.01;
			let best: ListenEvent | null = null;
			for (const o of onsets) {
				const t = o.ms / 1000;
				if (t >= t0 - 0.05 && t <= t1 + 0.1 && (!best || o.prominenceDb > best.prominenceDb)) best = o;
			}
			const t = best ? best.ms / 1000 : t0 + 0.03;
			if (!out.length || t - out[out.length - 1]! > 0.1) out.push(r3(t));
			s = e + 1;
		}
		return out;
	}
}

/** Stop-downs on the 100 ms level (earshot `profile.stopdowns`), with a sliding 2 s median. */
function stopdowns(Lf: Float32Array, nh: number): ProfileEvents['stopdowns'] {
	const P = PROFILE_METRICS;
	const w = P.stopRefHops;
	const out: ProfileEvents['stopdowns'] = [];
	if (nh <= w) return out;
	// sorted window of the w values before i
	const sorted: number[] = [];
	const insert = (x: number) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (sorted[m]! < x) lo = m + 1;
			else hi = m;
		}
		sorted.splice(lo, 0, x);
	};
	const remove = (x: number) => {
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (sorted[m]! < x) lo = m + 1;
			else hi = m;
		}
		if (lo < sorted.length) sorted.splice(lo, 1);
	};
	for (let j = 0; j < w; j++) insert(Lf[j]!);
	const med = () => {
		const n = sorted.length;
		return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
	};
	const refAt: number[] = new Array(nh).fill(Number.NaN);
	for (let i = w; i < nh; i++) {
		refAt[i] = med();
		remove(Lf[i - w]!);
		insert(Lf[i]!);
	}
	let i = w;
	while (i < nh) {
		const r = refAt[i]!;
		if (Lf[i]! < r - P.stopDropDb) {
			let j = i;
			let lowest = Lf[i]!;
			while (j < nh && Lf[j]! < r - P.stopDropDb) {
				lowest = Math.min(lowest, Lf[j]!);
				j++;
			}
			const len = (j - i) * 0.01;
			let back = Number.NEGATIVE_INFINITY;
			for (let q = j; q < Math.min(nh, j + P.stopReturnHops + 1); q++) back = Math.max(back, Lf[q]!);
			if (
				len >= P.stopMinSec &&
				len <= P.stopMaxSec &&
				j < nh &&
				back >= r - P.stopBackDb &&
				out.length < 500
			)
				out.push({ startSec: r3((i + 0.5) * 0.01 - 0.05), lengthSec: r3(len), depthDb: r1(r - lowest) });
			i = j + P.stopSkipHops;
		} else i++;
	}
	return out;
}
