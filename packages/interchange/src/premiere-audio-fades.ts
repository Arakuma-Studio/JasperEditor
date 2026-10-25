// Premiere's audio transitions ↔ JasperEditor's (docs/wp-notes/audio-crossfades.md). Premiere stores every audio
// transition with a fade shape: `FadeShapeType` (1 = Cosine; 0 = Linear, assumed), `FadeShapeValue` (the fade value,
// seen 12 / 13 / 19 / 30) and `CrossfadeSymmetry` (0 = symmetrical; 1 = asymmetrical, assumed). Constant Power is
// Cosine @ 19 and Constant Gain Linear @ 0 (Adobe community answer); dragging a fade handle makes a Custom Fade.
import {
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CUSTOM_FADE,
	clampFadeValue,
	customFadeParamsFor,
	EXPONENTIAL_FADE,
	type FadeShapeType,
	type Transition,
	transitionSpec,
} from '@jasper/project';
import type { Report } from './report.ts';

/** The fade shape fields of a Premiere audio transition as a document gives them (strings or numbers). */
export type PremiereFadeShape = { type?: unknown; value?: unknown; symmetry?: unknown };

const num = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : null;
};

/** `FadeShapeType` → shape (also the names "linear" / "cosine"); null when unknown. */
export function premiereShapeType(v: unknown): FadeShapeType | null {
	if (typeof v === 'string' && /^(linear|cosine)$/i.test(v.trim()))
		return v.trim().toLowerCase() as FadeShapeType;
	const n = num(v);
	return n === 1 ? 'cosine' : n === 0 ? 'linear' : null;
}

/** `CrossfadeSymmetry` → symmetry (also "symmetric" / "asymmetric"); null when unknown. */
export function premiereSymmetry(v: unknown): 'symmetric' | 'asymmetric' | null {
	if (typeof v === 'string' && /^(a?symmetric)(al)?$/i.test(v.trim()))
		return v.trim().toLowerCase().startsWith('a') ? 'asymmetric' : 'symmetric';
	const n = num(v);
	return n === 0 ? 'symmetric' : n === 1 ? 'asymmetric' : null;
}

const anim = <T>(value: T) => ({ value, keyframes: [] as never[] });

/**
 * A Premiere audio transition (its JasperEditor id from the name, and its fade shape fields when the document has
 * them) → the transition to create: Custom Fade with the shape; Constant Power / Gain keep their type when the
 * shape is their own (Cosine @ 19 / Linear @ 0) and become a Custom Fade with it otherwise; Exponential Fade keeps
 * its fixed curve (its Premiere shape is not known) and says so when shape data came with it.
 */
export function premiereAudioTransition(
	effectId: string,
	shape: PremiereFadeShape | null,
	report: Report,
	where: { name: string; frame?: number },
): { effectId: string; params: Transition['params'] } {
	const has =
		shape && (shape.type !== undefined || shape.value !== undefined || shape.symmetry !== undefined);
	if (!has) return { effectId, params: {} };
	const subject = {
		kind: 'transition' as const,
		name: where.name,
		...(where.frame !== undefined ? { frame: where.frame } : {}),
	};
	const type = shape.type !== undefined ? premiereShapeType(shape.type) : null;
	if (shape.type !== undefined && type === null)
		report.warn(
			`audio transition "${where.name}" has an unknown fade shape (${String(shape.type)}); Cosine is used`,
			{
				subject,
				instead: 'Cosine',
			},
		);
	const rawValue = shape.value !== undefined ? num(shape.value) : null;
	if (shape.value !== undefined && rawValue === null)
		report.warn(
			`audio transition "${where.name}" has an unreadable fade value (${String(shape.value)}); 19 is used`,
			{
				subject,
				instead: '19',
			},
		);
	const value = rawValue === null ? null : clampFadeValue(rawValue);
	if (rawValue !== null && value !== rawValue)
		report.info(`audio transition "${where.name}": fade value ${rawValue} clamped to ${value}`, { subject });
	const symmetry = shape.symmetry !== undefined ? premiereSymmetry(shape.symmetry) : null;
	if (shape.symmetry !== undefined && symmetry === null)
		report.warn(
			`audio transition "${where.name}" has an unknown crossfade symmetry (${String(shape.symmetry)}); symmetrical is used`,
			{ subject, instead: 'Symmetrical' },
		);
	if (effectId === EXPONENTIAL_FADE) {
		report.info(
			`audio transition "${where.name}" is an Exponential Fade: its fixed curve is used (its fade shape data is not part of it)`,
			{ subject },
		);
		return { effectId, params: {} };
	}
	if (effectId === CONSTANT_POWER || effectId === CONSTANT_GAIN) {
		const own = customFadeParamsFor(effectId);
		const same =
			(type === null || type === own.fadeShape) &&
			(value === null || value === own.fadeValue) &&
			symmetry !== 'asymmetric';
		if (same) return { effectId, params: {} };
		report.info(
			`audio transition "${where.name}" has a fade shape of its own; it is imported as a Custom Fade with that shape`,
			{ subject, instead: 'Custom Fade' },
		);
		return {
			effectId: CUSTOM_FADE,
			params: {
				fadeShape: anim(type ?? own.fadeShape),
				fadeValue: anim(value ?? own.fadeValue),
				...(symmetry ? { symmetry: anim(symmetry) } : {}),
			},
		};
	}
	if (effectId !== CUSTOM_FADE || !transitionSpec(CUSTOM_FADE)) return { effectId, params: {} };
	return {
		effectId,
		params: {
			...(type ? { fadeShape: anim(type) } : {}),
			...(value !== null ? { fadeValue: anim(value) } : {}),
			...(symmetry ? { symmetry: anim(symmetry) } : {}),
		},
	};
}

/** A Custom Fade's params → Premiere's fade shape fields (`FadeShapeType` 0 / 1, `FadeShapeValue`, symmetry 0 / 1). */
export function premiereFadeShapeOf(params: Transition['params']): {
	FadeShapeType: number;
	FadeShapeValue: number;
	CrossfadeSymmetry: number;
} {
	const v = (name: string) => (params[name] as { value?: unknown } | undefined)?.value;
	const type = premiereShapeType(v('fadeShape')) ?? 'cosine';
	const value = v('fadeValue');
	return {
		FadeShapeType: type === 'cosine' ? 1 : 0,
		FadeShapeValue: value === undefined ? 19 : clampFadeValue(value),
		CrossfadeSymmetry: v('symmetry') === 'asymmetric' ? 1 : 0,
	};
}
