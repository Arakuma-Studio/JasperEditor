// What the inspector needs to know about the looks of a selection (TL-089, TL-090). Pure.
import {
	type Appearance,
	type AppearanceLayer,
	type Clip,
	clipLook,
	type EffectInstance,
	type ProjectDocument,
	TITLE_LOOK_CLIP_KINDS,
	type TitleLook,
	titleLayerType,
	titleLookOf,
} from '@jasper/project';

export type LookedClip = { clip: Clip; fx: EffectInstance; appearance: Appearance };

export const takesLook = (c: Pick<Clip, 'kind'>) => (TITLE_LOOK_CLIP_KINDS as readonly string[]).includes(c.kind);

/** The clip's look, or null. */
export function lookedClip(clip: Clip): LookedClip | null {
	const fx = clipLook((clip as { effects?: EffectInstance[] }).effects);
	const appearance = fx?.appearance as Appearance | undefined;
	return fx && appearance ? { clip, fx, appearance } : null;
}

export type LookSelection = {
	/** Clips that may take a look. */
	capable: Clip[];
	looked: LookedClip[];
	/** The one look every looked clip links to; null when unlinked or when they differ. */
	look: TitleLook | null;
	/** The clips carry different looks (or some carry none). */
	mixed: boolean;
};

export function lookSelection(doc: ProjectDocument, clips: readonly Clip[]): LookSelection {
	const capable = clips.filter(takesLook);
	const looked = capable.map(lookedClip).filter((x): x is LookedClip => !!x);
	const ids = new Set(looked.map((l) => l.appearance.lookId ?? ''));
	const id = ids.size === 1 ? [...ids][0]! : '';
	return {
		capable,
		looked,
		look: id ? titleLookOf(doc, id) : null,
		mixed: ids.size > 1 || (looked.length > 0 && looked.length < capable.length),
	};
}

/** How many places a clip's appearance deviates from its look (`lookOverrides`, TL-011). */
export function overrideCount(a: Appearance): number {
	const o = a.lookOverrides;
	if (!o) return 0;
	let n = 0;
	for (const [k, v] of Object.entries(o)) n += Array.isArray(v) ? v.length : k === '$order' ? 1 : 0;
	return n;
}

/** A layer's name in lists: its own, or its type's. */
export function layerName(l: Pick<AppearanceLayer, 'name' | 'type'>): string {
	return l.name ?? titleLayerType(l.type)?.label ?? l.type;
}

/** One line of a stack, shared across the selected clips: `layers[i]` belongs to `clips[i]`. */
export type SharedLayer = {
	/** Stable across clips of one look: the layer id when they share it, else type and position. */
	key: string;
	type: string;
	layers: AppearanceLayer[];
	looked: LookedClip[];
};

const signature = (a: Appearance) => a.layers.map((l) => l.type).join('/');

/**
 * The stack of the selection, top of the stack first as a list reads (the model is bottom-first). Clips of different
 * structure have no shared stack: null, and the panel says so instead of guessing which layer is which.
 */
export function sharedStack(looked: readonly LookedClip[]): SharedLayer[] | null {
	const first = looked[0];
	if (!first) return [];
	if (looked.some((l) => signature(l.appearance) !== signature(first.appearance))) return null;
	const out: SharedLayer[] = first.appearance.layers.map((l, i) => ({
		key: looked.every((x) => x.appearance.layers[i]!.id === l.id) ? l.id : `${l.type}:${i}`,
		type: l.type,
		layers: looked.map((x) => x.appearance.layers[i]!),
		looked: [...looked],
	}));
	return out.reverse();
}
