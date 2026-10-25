// Third-party Premiere Pro transitions matched by their MatchName (FCP7 XML `<effectid>`, the `.prproj`
// `VideoTransitionTrackItem` match name) and mapped to JasperEditor transitions with their parameters converted.
// Documents name these plug-ins with display names that collide with built-in ones ("Slide"), so the MatchName
// decides; the display name alone keeps meaning Premiere's own transition.
//
// Red Giant Universe "Slide" (`AE.Universe_Transitions_Slide`) → Smooth Slide (`jasper.smooth-slide`). Parameter
// conversion (research, decoded value ranges and assumptions: docs/wp-notes/smooth-slide.md):
//   Direction 0…3 → right, left, up, down · Animation 0…21 → SMOOTH_SLIDE_EASINGS (Linear, Ease In × 7, Ease Out × 7,
//   Ease In Out × 7) · Dolly 0…1.2 · Reflection (checkbox; "Reflect" is its group header) · Bluriness 0…100 ·
//   Falloff 0…1 · Aspect 0.01…20 · Motion Blur 0…3 → off, low, medium, high · Motion Blur Shutter 90…720 ° ·
//   Edge Smoothing 0…3 → none, low, medium, high. "Input" (the compositor's Transition B layer picker) and the
//   unnamed "#10" have no meaning in a timeline and are ignored.
import {
	type Keyframe,
	SMOOTH_SLIDE,
	SMOOTH_SLIDE_DIRECTIONS,
	SMOOTH_SLIDE_EASINGS,
	SMOOTH_SLIDE_EDGE_SMOOTHING,
	SMOOTH_SLIDE_MOTION_BLUR,
	type Transition,
} from '@jasper/project';
import type { Report, ReportSubject } from './report.ts';

export const UNIVERSE_SLIDE_MATCH_NAME = 'AE.Universe_Transitions_Slide';

type Scalar = number | boolean | string;

/** A Premiere transition parameter as documents carry it (display name, value, keyframes in flicks from the span start). */
export type PremiereParam = {
	name: string;
	value: Scalar | null;
	keyframes?: readonly { time: number; value: Scalar; interpolation?: Keyframe<number>['interpolation'] }[];
};

type Conv =
	| { kind: 'enum'; to: string; options: readonly string[] }
	| { kind: 'number'; to: string; min: number; max: number }
	| { kind: 'bool'; to: string };

type Mapping = { effectId: string; params: Record<string, Conv>; ignored: readonly string[] };

const UNIVERSE_SLIDE: Mapping = {
	effectId: SMOOTH_SLIDE.id,
	params: {
		direction: { kind: 'enum', to: 'direction', options: SMOOTH_SLIDE_DIRECTIONS },
		animation: { kind: 'enum', to: 'animation', options: SMOOTH_SLIDE_EASINGS },
		dolly: { kind: 'number', to: 'dolly', min: 0, max: 1.2 },
		reflection: { kind: 'bool', to: 'reflection' },
		bluriness: { kind: 'number', to: 'blurriness', min: 0, max: 100 },
		blurriness: { kind: 'number', to: 'blurriness', min: 0, max: 100 },
		falloff: { kind: 'number', to: 'falloff', min: 0, max: 1 },
		aspect: { kind: 'number', to: 'aspect', min: 0.01, max: 20 },
		'motion blur': { kind: 'enum', to: 'motionBlur', options: SMOOTH_SLIDE_MOTION_BLUR },
		'motion blur shutter': { kind: 'number', to: 'shutterAngle', min: 90, max: 720 },
		'edge smoothing': { kind: 'enum', to: 'edgeSmoothing', options: SMOOTH_SLIDE_EDGE_SMOOTHING },
	},
	ignored: ['input', 'reflect', '#10'],
};

const BY_MATCH_NAME: Record<string, Mapping> = {
	[UNIVERSE_SLIDE_MATCH_NAME.toLowerCase()]: UNIVERSE_SLIDE,
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The JasperEditor transition id of a Premiere MatchName this module maps, or null. */
export function premiereTransitionForMatchName(matchName: string | null | undefined): string | null {
	return matchName ? (BY_MATCH_NAME[norm(matchName)]?.effectId ?? null) : null;
}

const toNumber = (v: Scalar | null): number | null => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
};
const toBool = (v: Scalar | null): boolean | null => {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : null;
	if (typeof v === 'string') {
		const s = v.trim().toLowerCase();
		if (s === 'true' || s === '1') return true;
		if (s === 'false' || s === '0') return false;
	}
	return null;
};

/**
 * Converts the parameters of a mapped Premiere transition to the JasperEditor transition's params (only those the
 * document sets; the rest keep their defaults). Out-of-range numbers are clamped and unknown popup indices or
 * unreadable values are reported and left at the default; never throws.
 */
export function premiereTransitionParams(
	matchName: string,
	params: readonly PremiereParam[],
	report: Report,
	subject?: ReportSubject,
): Transition['params'] {
	const m = BY_MATCH_NAME[norm(matchName)];
	const out: Transition['params'] = {};
	if (!m) return out;
	const extra = subject ? { subject } : {};
	for (const p of params.slice(0, 256)) {
		const key = norm(p.name ?? '');
		const conv = m.params[key];
		if (!conv) {
			if (!m.ignored.includes(key))
				report.info(
					`parameter "${p.name}" of transition "${matchName}" has no equivalent and was ignored`,
					extra,
				);
			continue;
		}
		const convert = (v: Scalar | null): number | boolean | string | null => {
			if (conv.kind === 'bool') return toBool(v);
			const n = toNumber(v);
			if (n === null) return null;
			if (conv.kind === 'number') return Math.min(conv.max, Math.max(conv.min, n));
			const i = Math.round(n);
			return i >= 0 && i < conv.options.length ? conv.options[i]! : null;
		};
		const value = convert(p.value);
		if (value === null) {
			report.warn(
				`parameter "${p.name}" of transition "${matchName}" has an unsupported value (${String(p.value)}); the default is used`,
				extra,
			);
			continue;
		}
		// Popups and checkboxes are hold-only in JasperEditor: their keyframes are dropped (reported); numbers keep theirs.
		const keys: Keyframe<number>[] = [];
		if (p.keyframes?.length && conv.kind !== 'number')
			report.warn(
				`the keyframes of "${p.name}" (transition "${matchName}") were dropped: it is a hold-only setting`,
				extra,
			);
		else
			for (const k of (p.keyframes ?? []).slice(0, 10_000)) {
				const kv = convert(k.value);
				if (typeof kv !== 'number' || !Number.isFinite(k.time)) continue;
				const interpolation = k.interpolation ?? 'linear';
				const slope = interpolation === 'bezier' ? 0 : 1;
				keys.push({
					id: `kf${Math.round(k.time)}`,
					time: Math.max(0, Math.round(k.time)),
					value: kv,
					interpolation,
					easeIn: { influence: 1 / 3, slope },
					easeOut: { influence: 1 / 3, slope },
				});
			}
		keys.sort((a, b) => a.time - b.time);
		const unique = keys.filter((k, i) => i === keys.length - 1 || keys[i + 1]!.time !== k.time);
		out[conv.to] = {
			value: unique[0]?.value ?? value,
			keyframes: unique,
		} as Transition['params'][string];
	}
	return out;
}
