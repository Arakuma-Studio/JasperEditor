// The audio processor contract (port of filmcraft's `AudioEffect` trait, `audio-dsp/src/lib.rs`).
//
// Conventions: audio is planar f32 (one Float32Array per channel). `process(channels, start, end)` works in place
// on `[start, end)` of every channel and never allocates; buffers are sized at construction. Parameters may change
// between blocks and are smoothed per sample, so the output is independent of how the stream is cut into blocks
// (tested for every registered effect). Recursive state is flushed to zero below ~1e-30, so tails end in exact
// silence. Parameter names, ranges and defaults come from the effect's `EffectSpec` (`@jasper/project/audio`).
import { audioEffectSpec, type EffectSpec, type ParamSpec, type ParamValue } from '@jasper/project/audio';

/** A parameter value as stored in documents (numbers, booleans, enum option ids) or a numeric index. */
export type ParamInput = ParamValue | number;

export interface AudioProcessor {
	/** Registry id (`jasper.audio.*`). */
	readonly id: string;
	readonly spec: EffectSpec;
	/** Sets a parameter (clamped/sanitised); takes effect smoothly from the next sample. False for unknown names. */
	setParam(name: string, value: ParamInput): boolean;
	/** Current (target) numeric value of a parameter (enum = option index, boolean = 0/1). */
	param(name: string): number | undefined;
	/** Clears all internal state; smoothed parameters jump to their targets. */
	reset(): void;
	/** Processes `[start, end)` of every channel in place. Extra channels beyond the configured count pass through. */
	process(channels: readonly Float32Array[], start: number, end: number): void;
	/** Processing latency in samples (look-ahead / STFT delay) for delay compensation. */
	latency(): number;
	/** Analytic magnitude response (dB) at `freq` for EQ/filter effects (graphical editors), else null. */
	responseDb?(freq: number): number | null;
	/** Static input → output level curve (dB) of a dynamics effect for `band` (0 = single band), else null. */
	transferDb?(band: number, inputDb: number): number | null;
	/** Live meter values (gain reduction in dB per band, ≤ 0) for the Effect Controls meters. */
	meters?(): readonly number[];
}

export type ProcessorFactory = (sampleRate: number, channels: number) => AudioProcessor;

/** The spec of an audio effect id; throws for ids missing from the catalogue (a programming error). */
export function specOf(id: string): EffectSpec {
	const s = audioEffectSpec(id);
	if (!s) throw new Error(`audio-fx: no catalogue entry for ${id}`);
	return s;
}

/** Numeric default of a parameter (enum → option index, boolean → 0/1). */
export function numericDefault(p: ParamSpec): number {
	return toNumber(p, p.default, 0);
}

function toNumber(p: ParamSpec, v: unknown, fallback: number): number {
	switch (p.type) {
		case 'boolean':
			return typeof v === 'boolean'
				? v
					? 1
					: 0
				: typeof v === 'number' && Number.isFinite(v)
					? v >= 0.5
						? 1
						: 0
					: fallback;
		case 'enum': {
			const opts = p.options ?? [];
			if (typeof v === 'string') {
				const i = opts.indexOf(v);
				return i >= 0 ? i : fallback;
			}
			if (typeof v === 'number' && Number.isFinite(v))
				return Math.min(Math.max(Math.round(v), 0), Math.max(0, opts.length - 1));
			return fallback;
		}
		case 'number': {
			if (typeof v !== 'number' || Number.isNaN(v)) return fallback;
			const lo = p.range?.min ?? Number.NEGATIVE_INFINITY;
			const hi = p.range?.max ?? Number.POSITIVE_INFINITY;
			return v < lo ? lo : v > hi ? hi : v;
		}
		default:
			return fallback;
	}
}

/** Parameter storage of one processor: numeric values indexed like `spec.params`. */
export class ParamValues {
	readonly values: Float64Array;
	private readonly index = new Map<string, number>();

	constructor(readonly spec: EffectSpec) {
		this.values = new Float64Array(spec.params.length);
		spec.params.forEach((p, i) => {
			this.index.set(p.name, i);
			this.values[i] = numericDefault(p);
		});
	}

	has(name: string): boolean {
		return this.index.has(name);
	}

	/** Sanitises and stores a value; false for unknown names. NaN and wrong types map to the default. */
	set(name: string, v: ParamInput): boolean {
		const i = this.index.get(name);
		if (i === undefined) return false;
		const p = this.spec.params[i]!;
		this.values[i] = toNumber(p, v, numericDefault(p));
		return true;
	}

	get(name: string): number | undefined {
		const i = this.index.get(name);
		return i === undefined ? undefined : this.values[i];
	}

	/** Value of a parameter known to exist (throws otherwise: a programming error). */
	v(name: string): number {
		const i = this.index.get(name);
		if (i === undefined) throw new Error(`${this.spec.id}: unknown parameter ${name}`);
		return this.values[i]!;
	}

	on(name: string): boolean {
		return this.v(name) >= 0.5;
	}

	/** Option index of a choice parameter. */
	idx(name: string): number {
		return Math.max(0, Math.round(this.v(name)));
	}

	/** Option id of a choice parameter. */
	option(name: string): string {
		const i = this.index.get(name)!;
		return this.spec.params[i]!.options?.[this.idx(name)] ?? '';
	}
}

/**
 * Base class of the processors: parameter plumbing around `applyParams(snap)`, which subclasses implement to push
 * the stored values into their smoothers/designs (`snap` = jump instead of ramp: construction and reset). Subclass
 * constructors must call `this.applyParams(true)` once their own fields exist.
 */
export abstract class EffectBase implements AudioProcessor {
	readonly spec: EffectSpec;
	readonly pv: ParamValues;

	constructor(
		id: string,
		readonly sampleRate: number,
		readonly channels: number,
	) {
		this.spec = specOf(id);
		this.pv = new ParamValues(this.spec);
	}

	get id(): string {
		return this.spec.id;
	}

	setParam(name: string, value: ParamInput): boolean {
		if (!this.pv.set(name, value)) return false;
		this.applyParams(false);
		return true;
	}

	param(name: string): number | undefined {
		return this.pv.get(name);
	}

	latency(): number {
		return 0;
	}

	protected abstract applyParams(snap: boolean): void;
	abstract reset(): void;
	abstract process(channels: readonly Float32Array[], start: number, end: number): void;
}
