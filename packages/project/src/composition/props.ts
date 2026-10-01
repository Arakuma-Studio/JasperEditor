// Composition clips (M2, S08:MGC-002…005): props overrides over a composition's defaultProps, frame mapping at
// the sequence rate, render ranges and the pre-render key material. Pure; shared by the model, the web client,
// the compositions package and the engine.
import { canonicalJson } from '../color/runs.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset, MgCompositionInfo } from '../schema/media.ts';
import type { Clip } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, fpsOf, type Rational } from '../time.ts';
import { type JsonSchemaNode, type SchemaIssue, validateJsonSchema } from './json-schema.ts';

/** Remotion version every bundle and pre-render is pinned to (ARCHITECTURE D-19). */
export const MG_REMOTION_VERSION = '4.0.499';
/** Bump when the pre-render recipe (codecs, flags, re-mux) changes: every cached master is re-rendered. */
const MG_PRERENDER_RECIPE = 1;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Effective props = deep merge of `overrides` over `defaults` (S08:MGC-003): objects merge key by key, arrays
 * and primitives are replaced, `undefined` keeps the default, `null` is a value.
 */
export function mergeProps(
	defaults: Record<string, unknown> | undefined,
	overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merge = (a: unknown, b: unknown): unknown => {
		if (b === undefined) return clone(a);
		if (isPlainObject(a) && isPlainObject(b)) {
			const out: Record<string, unknown> = {};
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
				const v = merge(a[k], b[k]);
				if (v !== undefined) out[k] = v;
			}
			return out;
		}
		return clone(b);
	};
	return merge(defaults ?? {}, overrides ?? {}) as Record<string, unknown>;
}

function clone<T>(v: T): T {
	return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Value at a dotted path (`['a', 'b', '0']`), or undefined. */
export function getPropAt(obj: unknown, path: readonly string[]): unknown {
	let cur = obj;
	for (const k of path) {
		if (Array.isArray(cur)) cur = cur[Number(k)];
		else if (isPlainObject(cur)) cur = cur[k];
		else return undefined;
	}
	return cur;
}

/**
 * A copy of `overrides` with `value` written at `path`. Intermediate containers come from the override, else a
 * copy of the effective value (so writing into an array element keeps the other elements), else `{}` / `[]`
 * (numeric segments create arrays).
 */
export function setPropOverride(
	overrides: Record<string, unknown>,
	effective: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): Record<string, unknown> {
	if (path.length === 0) return isPlainObject(value) ? clone(value) : overrides;
	const root = clone(overrides);
	let cur: Record<string, unknown> | unknown[] = root;
	for (let i = 0; i < path.length - 1; i++) {
		const k = path[i]!;
		const nextIsIndex = /^\d+$/.test(path[i + 1]!);
		let next = Array.isArray(cur) ? cur[Number(k)] : cur[k];
		if (!(isPlainObject(next) || Array.isArray(next))) {
			const eff = getPropAt(effective, path.slice(0, i + 1));
			next = isPlainObject(eff) || Array.isArray(eff) ? clone(eff) : nextIsIndex ? [] : {};
		}
		if (Array.isArray(cur)) cur[Number(k)] = next;
		else cur[k] = next;
		cur = next as Record<string, unknown> | unknown[];
	}
	const last = path[path.length - 1]!;
	if (Array.isArray(cur)) cur[Number(last)] = clone(value);
	else cur[last] = clone(value);
	return root;
}

/** A copy of `overrides` without the value at `path` (the prop falls back to its default); empty parents go too. */
export function unsetPropOverride(
	overrides: Record<string, unknown>,
	path: readonly string[],
): Record<string, unknown> {
	if (path.length === 0) return {};
	const root = clone(overrides);
	const stack: [Record<string, unknown>, string][] = [];
	let cur: unknown = root;
	for (let i = 0; i < path.length - 1; i++) {
		if (!isPlainObject(cur)) return root;
		stack.push([cur, path[i]!]);
		cur = cur[path[i]!];
	}
	if (!isPlainObject(cur)) return root;
	delete cur[path[path.length - 1]!];
	for (let i = stack.length - 1; i >= 0; i--) {
		const [parent, k] = stack[i]!;
		const child = parent[k];
		if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[k];
		else break;
	}
	return root;
}

/** The mg-bundle asset and composition info a composition clip refers to (undefined when missing). */
export function compositionOfClip(
	doc: Pick<ProjectDocument, 'media'>,
	clip: Pick<Clip, 'kind'> & { composition?: { id: string; mediaId?: string } },
): { asset: MediaAsset; info: MgCompositionInfo } | undefined {
	if (clip.kind !== 'composition' || !clip.composition?.mediaId) return undefined;
	const asset = doc.media[clip.composition.mediaId];
	const info = asset?.mgBundle?.compositions.find((c) => c.id === clip.composition!.id);
	return asset && info ? { asset, info } : undefined;
}

/** Effective props of a composition clip (defaults of its composition merged with the clip's overrides). */
export function effectiveCompositionProps(
	doc: Pick<ProjectDocument, 'media'>,
	clip: Pick<Clip, 'kind'> & {
		composition?: { id: string; mediaId?: string };
		props?: Record<string, unknown>;
	},
): Record<string, unknown> {
	const found = compositionOfClip(doc, clip);
	return mergeProps(found?.info.defaultProps, clip.props);
}

/** Validates effective props against the composition's `propsSchema` (none = always valid). */
export function validateCompositionProps(
	info: Pick<MgCompositionInfo, 'propsSchema'>,
	effective: Record<string, unknown>,
): SchemaIssue[] {
	return info.propsSchema ? validateJsonSchema(info.propsSchema as JsonSchemaNode, effective) : [];
}

export function formatSchemaIssues(issues: readonly SchemaIssue[], max = 4): string {
	const shown = issues.slice(0, max).map((i) => `${i.path}: ${i.message}`);
	return issues.length > max ? `${shown.join('; ')}; …` : shown.join('; ');
}

// ---------------------------------------------------------------- time (S08:MGC-004/005)

/** The composition's own frame rate differs from the sequence rate (warning MG_FPS_MISMATCH, MGC-005). */
export function compositionFpsMismatch(info: Pick<MgCompositionInfo, 'fps'>, seqRate: Rational): boolean {
	return Math.abs(info.fps - fpsOf(seqRate)) > 1e-3;
}

/**
 * Length of a composition in sequence frames: renders and previews run at the sequence rate, with
 * `durationInFrames` scaled when the rates differ (MGC-005). At least 1.
 */
export function compositionSequenceFrames(
	info: Pick<MgCompositionInfo, 'fps' | 'durationInFrames'>,
	seqRate: Rational,
): number {
	if (!compositionFpsMismatch(info, seqRate)) return info.durationInFrames;
	return Math.max(1, Math.round((info.durationInFrames * fpsOf(seqRate)) / info.fps));
}

/** Composition frame (at the sequence rate) shown at content time `t` (flicks): floor(t · fps + ε). */
export function compositionFrameAt(contentTime: number, seqRate: Rational): number {
	return Math.floor((contentTime * seqRate.num) / (seqRate.den * FLICKS_PER_SECOND) + 1e-6);
}

/**
 * Pre-render range of a composition clip in composition frames (at the sequence rate): the clip's drawn span
 * including transition handles (MGC-032), clamped to the composition. `startFrame` of the master = the
 * composition frame shown at sequence frame `clip.start − headHandle`.
 */
export function compositionClipRenderRange(
	clip: { start: number; duration: number; sourceIn: number; headHandle?: number; tailHandle?: number },
	seqRate: Rational,
	totalFrames: number,
): { startFrame: number; durationFrames: number; layerStart: number } {
	const head = clip.headHandle ?? 0;
	const tail = clip.tailHandle ?? 0;
	const first = compositionFrameAt(clip.sourceIn, seqRate) - head;
	const startFrame = Math.max(0, Math.min(Math.max(0, totalFrames - 1), first));
	const end = Math.min(totalFrames, first + head + clip.duration + tail);
	return {
		startFrame,
		durationFrames: Math.max(1, end - startFrame),
		// Sequence frame shown by the master's frame 0.
		layerStart: clip.start - head + (startFrame - first),
	};
}

// ---------------------------------------------------------------- pre-render key (S08:MGC-031)

type CompositionRenderKeyInput = {
	bundleHash: string;
	compositionId: string;
	/** Effective props. */
	props: Record<string, unknown>;
	width: number;
	height: number;
	fps: Rational;
	startFrame: number;
	durationFrames: number;
};

/** Canonical JSON hashed (sha256) into the render key: any change of these yields a new cache entry. */
export function compositionRenderKeyMaterial(k: CompositionRenderKeyInput): string {
	return canonicalJson({
		bundleHash: k.bundleHash,
		compositionId: k.compositionId,
		props: k.props,
		width: k.width,
		height: k.height,
		fps: { num: k.fps.num, den: k.fps.den },
		startFrame: k.startFrame,
		durationFrames: k.durationFrames,
		renderer: MG_REMOTION_VERSION,
		recipe: MG_PRERENDER_RECIPE,
	});
}
