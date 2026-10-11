// Pure helpers of the audio effect editors (audio-fx): the effect's values at the playhead, an analysis processor
// for curves (responseDb / transferDb from the same DSP the audio runs), the band handles of EQ-like effects and
// the axes of the graphs.
import { type AudioProcessor, createProcessor } from '@jasper/audio-fx';
import {
	type Clip,
	clipContentTimeAtFrame,
	type EffectInstance,
	type EffectSpec,
	evaluate,
	type ParamValue,
	type Rational,
} from '@jasper/project';

/** The effect's parameter values at sequence frame `frame` (keyframes evaluated in content time). */
export function valuesAt(
	clip: Clip,
	fx: EffectInstance,
	spec: EffectSpec,
	frame: number,
	rate: Rational,
): Record<string, ParamValue> {
	const t = clipContentTimeAtFrame(clip, frame, rate).time;
	const out: Record<string, ParamValue> = {};
	for (const p of spec.params) {
		const a = fx.params[p.name];
		out[p.name] = a ? (evaluate(a, t) as ParamValue) : p.default;
	}
	return out;
}

/** A processor configured with `values` (for analytic responses; never processes audio). */
export function analysisProcessor(
	effectId: string,
	values: Record<string, ParamValue>,
	sampleRate = 48000,
): AudioProcessor | null {
	const p = createProcessor(effectId, sampleRate, 2);
	if (!p) return null;
	for (const [k, v] of Object.entries(values)) p.setParam(k, v as number);
	return p;
}

export const F_MIN = 20;
export const F_MAX = 20000;
export const freqToX = (f: number, w: number) => (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * w;
export const xToFreq = (x: number, w: number) => F_MIN * (F_MAX / F_MIN) ** Math.min(Math.max(x / w, 0), 1);
export const dbToY = (db: number, h: number, range: number) => h / 2 - (db / range) * (h / 2);
export const yToDb = (y: number, h: number, range: number) => ((h / 2 - y) / (h / 2)) * range;
export const FREQ_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
export const freqLabel = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

/** The magnitude response of the effect sampled on a log grid (dB). */
export function responseCurve(p: AudioProcessor | null, points = 160): { f: number; db: number }[] {
	if (!p?.responseDb) return [];
	const out: { f: number; db: number }[] = [];
	for (let i = 0; i < points; i++) {
		const f = F_MIN * (F_MAX / F_MIN) ** (i / (points - 1));
		const db = p.responseDb(f);
		if (db !== null && Number.isFinite(db)) out.push({ f, db });
	}
	return out;
}

/** An EQ band handle: `${prefix}Freq` (or `Frequency`/`Center`) with optional Gain / Q / On params. */
export type BandHandle = {
	prefix: string;
	label: string;
	freq: string;
	gain: string | null;
	q: string | null;
	on: string | null;
};

export function bandHandles(spec: EffectSpec): BandHandle[] {
	const names = new Set(spec.params.map((p) => p.name));
	const out: BandHandle[] = [];
	for (const p of spec.params) {
		const m =
			/^(.*?)(Freq|Frequency|Center|Cutoff)$/.exec(p.name) ??
			(p.name === 'frequency' || p.name === 'center' || p.name === 'cutoff' ? [p.name, '', p.name] : null);
		if (!m || p.type !== 'number' || p.unit !== 'Hz') continue;
		const prefix = m[1] ?? '';
		const k = (s: string) => (prefix ? `${prefix}${s}` : s.charAt(0).toLowerCase() + s.slice(1));
		const gain = names.has(k('Gain')) ? k('Gain') : names.has(k('Boost')) ? k('Boost') : null;
		out.push({
			prefix,
			label: p.label.replace(/ (Frequency|Freq|Center|Cutoff)$/, ''),
			freq: p.name,
			gain,
			q: names.has(k('Q')) ? k('Q') : null,
			on: names.has(k('On')) ? k('On') : null,
		});
	}
	return out;
}

/** Graphic EQ band params (b1…bN, dB) in order. */
export function graphicBands(spec: EffectSpec): { name: string; label: string }[] {
	return spec.params.filter((p) => /^b\d+$/.test(p.name)).map((p) => ({ name: p.name, label: p.label }));
}

/** Dynamics bands with a transfer curve: 1 (single band) or 4 (multiband). */
export function dynamicsBands(spec: EffectSpec): number {
	return spec.audio?.editor === 'multiband-compressor' ? 4 : 1;
}
