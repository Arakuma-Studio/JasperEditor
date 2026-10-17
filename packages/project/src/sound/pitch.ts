// Pitch of a placed sound (spec 12 §2.3, §2.7 Essential Sound ▸ Pitch; WP6.5b): shifts up to ±3 st are varispeed (the
// clip speed times 2^(st/12), on top of the seeded ±2 % variation), larger ones the Pitch Shifter effect with the speed
// left at the variation. Placement and `soundDesign.swap {pitchSt}` record the applied shift and the speed under it
// (`AudioClip.sfx.pitch`), because a fractional shift and the variation cannot be told apart from the speed alone
// (1.02 · 2^(2.5/12) reads as 3 st over 0.9906). `clipPitchOf` uses the record while it still describes the clip
// (its speed, and its Pitch Shifter for large shifts); otherwise (clips placed before the record, a speed changed by
// another command) the previous reading: whole semitones of varispeed within ±3, the rest is the variation, plus the
// Pitch Shifter's semitones and cents. Pure; never throws.

/** Pitch shifts up to this many semitones are made by varispeed (spec 12 §2.3); larger ones by the Pitch Shifter. */
export const VARISPEED_PITCH_MAX_ST = 3;
export const PITCH_SHIFTER_EFFECT_ID = 'jasper.audio.pitch-shifter';

/** Clip speed and Pitch Shifter semitones for a pitch shift of `pitchSt` over the speed `rate` (spec 12 §2.3). */
export function pitchPlan(pitchSt: number, rate: number): { rate: number; shifterSt: number } {
	if (!pitchSt) return { rate, shifterSt: 0 };
	if (Math.abs(pitchSt) <= VARISPEED_PITCH_MAX_ST) return { rate: rate * 2 ** (pitchSt / 12), shifterSt: 0 };
	return { rate, shifterSt: pitchSt };
}

/** The speed a swap stores for a pitch plan (micro-steps: the speed field's precision in the model). */
export function roundedRate(rate: number): number {
	return Math.round(rate * 1e6) / 1e6;
}

/** Speeds this close are the same speed (a stored record vs. the clip: rounding to `roundedRate`'s steps). */
const RATE_EPS = 1.5e-6;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Semitones of the clip's Pitch Shifters (semitones + cents / 100, summed); null when it has none. */
function shifterSemitones(effects: readonly unknown[] | undefined): number | null {
	let total: number | null = null;
	for (const fx of effects ?? []) {
		const f = fx as { effectId?: unknown; params?: Record<string, { value?: unknown } | undefined> } | null;
		if (!f || f.effectId !== PITCH_SHIFTER_EFFECT_ID) continue;
		const st = fin(f.params?.semitones?.value) ? f.params.semitones.value : 0;
		const cents = fin(f.params?.cents?.value) ? f.params.cents.value : 0;
		total = (total ?? 0) + st + cents / 100;
	}
	return total === null ? null : Math.round(total * 100) / 100;
}

export type ClipPitch = {
	/** The applied pitch shift, semitones (varispeed or Pitch Shifter). */
	st: number;
	/** The speed without the shift (the seeded variation): a reset to 0 st gives this speed. */
	baseRate: number;
	/** Semitones made by varispeed (0 when the Pitch Shifter carries the shift). */
	varispeedSt: number;
	/** Semitones the Pitch Shifter carries (0 without one). */
	shifterSt: number;
	/** True when read from `sfx.pitch` (exact), false for the previous reading (whole varispeed semitones). */
	recorded: boolean;
};

/** The pitch shift of a clip (see the module docs). */
export function clipPitchOf(clip: {
	speed?: { rate?: unknown } | null;
	effects?: readonly unknown[];
	sfx?: { pitch?: unknown } | null;
}): ClipPitch {
	const raw = clip.speed?.rate;
	const rate = fin(raw) && raw > 0 ? raw : 1;
	const shifter = shifterSemitones(clip.effects);
	const rec = clip.sfx?.pitch as { st?: unknown; baseRate?: unknown } | null | undefined;
	if (
		rec &&
		typeof rec === 'object' &&
		fin(rec.st) &&
		Math.abs(rec.st) <= 12 &&
		fin(rec.baseRate) &&
		rec.baseRate >= 0.01 &&
		rec.baseRate <= 100
	) {
		const plan = pitchPlan(rec.st, rec.baseRate);
		const speedOk = Math.abs(plan.rate - rate) <= RATE_EPS * Math.max(1, rate);
		const shifterOk = plan.shifterSt
			? shifter !== null && Math.abs(shifter - Math.round(plan.shifterSt * 100) / 100) < 0.005
			: true;
		if (speedOk && shifterOk)
			return {
				st: rec.st,
				baseRate: rec.baseRate,
				varispeedSt: plan.shifterSt ? 0 : rec.st,
				shifterSt: plan.shifterSt,
				recorded: true,
			};
	}
	const whole = Math.round(12 * Math.log2(rate));
	const varispeedSt = Math.abs(whole) <= VARISPEED_PITCH_MAX_ST ? whole : 0;
	const shifterSt = shifter ?? 0;
	return {
		st: shifter !== null ? shifterSt : varispeedSt,
		baseRate: rate / 2 ** (varispeedSt / 12),
		varispeedSt,
		shifterSt,
		recorded: false,
	};
}
