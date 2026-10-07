// Invariants and repairs of text animator data (workstream text-animators), called from `invariants.ts`:
// animators / selectors / Path Options / More Options parse, their ids are well-formed and unique (claimed by the
// caller), values stay in their ranges, Source Text keys are hold keys of valid content at increasing times.
import type { IdPrefix } from '../ids.ts';
import { TextContentSchema } from '../schema/sequence.ts';
import {
	TextAnimatorGroupSchema,
	TextMoreOptionsSchema,
	TextPathOptionsSchema,
} from '../schema/text-animators.ts';
import { ANIMATOR_PROPERTY_BY_KEY, selectorFields } from './catalog.ts';

type Issue = { message: string; path: string[] };

const hasMask = (clip: Record<string, unknown>, id: string) =>
	Array.isArray(clip.masks) && (clip.masks as { id?: string }[]).some((m) => m.id === id);
type Claim = (id: string, prefix: IdPrefix, where: string[]) => void;
type AnimLike = { value: unknown; keyframes: { value: unknown }[] };

const isAnim = (v: unknown): v is AnimLike =>
	!!v && typeof v === 'object' && 'value' in v && Array.isArray((v as AnimLike).keyframes);

function outOfRange(a: unknown, range: { min?: number; max?: number } | undefined): boolean {
	if (!range || !isAnim(a)) return false;
	return [a.value, ...a.keyframes.map((k) => k.value)].some((v) => {
		const xs = typeof v === 'number' ? [v] : Array.isArray(v) ? v : [];
		return xs.some(
			(x) =>
				typeof x === 'number' &&
				((range.min !== undefined && x < range.min) || (range.max !== undefined && x > range.max)),
		);
	});
}

/** Issues of a text clip's animator data (`cw` = the clip's path). */
export function textAnimatorIssues(clip: Record<string, unknown>, cw: string[], claim: Claim): Issue[] {
	const out: Issue[] = [];
	const animators = clip.animators;
	if (animators !== undefined) {
		if (!Array.isArray(animators))
			out.push({ message: 'animators must be a list', path: [...cw, 'animators'] });
		else
			animators.forEach((a, ai) => {
				const where = [...cw, 'animators', String(ai)];
				const parsed = TextAnimatorGroupSchema.safeParse(a);
				if (!parsed.success) {
					out.push({
						message: `Text animator ${ai} is malformed: ${parsed.error.issues[0]?.message}`,
						path: where,
					});
					return;
				}
				const g = parsed.data;
				claim(g.id, 'tan', where);
				for (const [key, v] of Object.entries(g.properties)) {
					if (key === 'axes') {
						for (const tag of Object.keys(v as object))
							if (!/^[\x20-\x7e]{4}$/.test(tag))
								out.push({
									message: `Font axis tag "${tag}" must be 4 characters`,
									path: [...where, 'properties', 'axes'],
								});
						continue;
					}
					const def = ANIMATOR_PROPERTY_BY_KEY.get(key);
					if (!def) continue; // unknown future properties are preserved
					if (outOfRange(v, def.range))
						out.push({ message: `${g.name} ${def.label} out of range`, path: [...where, 'properties', key] });
				}
				g.selectors.forEach((s, si) => {
					const sw = [...where, 'selectors', String(si)];
					claim(s.id, 'tsl', sw);
					for (const f of selectorFields(s.kind))
						if (outOfRange((s as Record<string, unknown>)[f.key], f.range))
							out.push({ message: `${s.name} ${f.label} out of range`, path: [...sw, f.key] });
				});
			});
	}
	if (clip.pathOptions !== undefined && !TextPathOptionsSchema.safeParse(clip.pathOptions).success)
		out.push({ message: 'Path Options are malformed', path: [...cw, 'pathOptions'] });
	else if (clip.pathOptions !== undefined && !hasMask(clip, (clip.pathOptions as { maskId: string }).maskId))
		out.push({ message: 'Path Options reference a missing mask', path: [...cw, 'pathOptions', 'maskId'] });
	if (clip.moreOptions !== undefined && !TextMoreOptionsSchema.safeParse(clip.moreOptions).success)
		out.push({ message: 'More Options are malformed', path: [...cw, 'moreOptions'] });
	if (clip.perCharacter3d !== undefined && typeof clip.perCharacter3d !== 'boolean')
		out.push({ message: 'perCharacter3d must be a boolean', path: [...cw, 'perCharacter3d'] });
	const st = clip.sourceTextKeyframes;
	if (st !== undefined) {
		const path = [...cw, 'sourceTextKeyframes'];
		if (!Array.isArray(st)) out.push({ message: 'Source Text keyframes must be a list', path });
		else {
			let last = Number.NEGATIVE_INFINITY;
			for (const k of st as { id: string; time: number; value: unknown; interpolation: unknown }[]) {
				claim(k.id, 'kf', [...path, k.id]);
				if (!(k.time > last)) out.push({ message: 'Keyframes must have strictly increasing times', path });
				last = k.time;
				if (k.interpolation !== 'hold')
					out.push({ message: 'Source Text keyframes are hold keyframes', path });
				if (!TextContentSchema.safeParse(k.value).success)
					out.push({ message: 'Source Text keyframe value is not valid text content', path });
			}
		}
	}
	return out;
}

const clampRange = (a: AnimLike, range: { min?: number; max?: number }) => {
	const c = (v: unknown): unknown => {
		if (typeof v === 'number') return Math.min(range.max ?? Infinity, Math.max(range.min ?? -Infinity, v));
		if (Array.isArray(v)) return v.map(c);
		return v;
	};
	a.value = c(a.value);
	for (const k of a.keyframes) k.value = c(k.value);
};

/** Repairs a text clip's animator data in place; returns notes of what changed. */
export function repairTextAnimators(clip: Record<string, unknown>): string[] {
	const notes: string[] = [];
	if (clip.animators !== undefined) {
		if (!Array.isArray(clip.animators)) {
			delete clip.animators;
			notes.push('malformed animators removed');
		} else {
			const seen = new Set<string>();
			clip.animators = (clip.animators as unknown[]).filter((a, ai) => {
				const ok = TextAnimatorGroupSchema.safeParse(a).success && !seen.has((a as { id: string }).id);
				if (!ok) notes.push(`malformed text animator ${ai} removed`);
				else seen.add((a as { id: string }).id);
				return ok;
			});
			for (const a of clip.animators as {
				properties: Record<string, unknown>;
				selectors: Record<string, unknown>[];
			}[]) {
				for (const [key, v] of Object.entries(a.properties)) {
					const def = ANIMATOR_PROPERTY_BY_KEY.get(key);
					if (def?.range && isAnim(v) && outOfRange(v, def.range)) {
						clampRange(v, def.range);
						notes.push(`text animator ${key} clamped to its range`);
					}
				}
				for (const s of a.selectors)
					for (const f of selectorFields(s.kind as 'range' | 'wiggly')) {
						const v = s[f.key];
						if (f.range && isAnim(v) && outOfRange(v, f.range)) {
							clampRange(v, f.range);
							notes.push(`selector ${f.key} clamped to its range`);
						}
					}
			}
			if ((clip.animators as unknown[]).length === 0) delete clip.animators;
		}
	}
	if (clip.pathOptions !== undefined && !TextPathOptionsSchema.safeParse(clip.pathOptions).success) {
		delete clip.pathOptions;
		notes.push('malformed Path Options removed');
	} else if (
		clip.pathOptions !== undefined &&
		!hasMask(clip, (clip.pathOptions as { maskId: string }).maskId)
	) {
		delete clip.pathOptions;
		notes.push('Path Options of a missing mask removed (Path: None)');
	}
	if (clip.moreOptions !== undefined && !TextMoreOptionsSchema.safeParse(clip.moreOptions).success) {
		delete clip.moreOptions;
		notes.push('malformed More Options removed');
	}
	if (clip.perCharacter3d !== undefined && typeof clip.perCharacter3d !== 'boolean') {
		delete clip.perCharacter3d;
		notes.push('malformed perCharacter3d removed');
	}
	const st = clip.sourceTextKeyframes;
	if (st !== undefined) {
		if (!Array.isArray(st)) {
			delete clip.sourceTextKeyframes;
			notes.push('malformed Source Text keyframes removed');
		} else {
			const kept = (st as { time: number; value: unknown; interpolation: string }[])
				.filter((k) => TextContentSchema.safeParse(k.value).success && Number.isFinite(k.time))
				.sort((a, b) => a.time - b.time)
				.filter((k, i, list) => i === 0 || k.time > list[i - 1]!.time);
			for (const k of kept) k.interpolation = 'hold';
			if (kept.length !== st.length) notes.push('malformed Source Text keyframes removed');
			if (kept.length === 0) delete clip.sourceTextKeyframes;
			else clip.sourceTextKeyframes = kept;
		}
	}
	return notes;
}
