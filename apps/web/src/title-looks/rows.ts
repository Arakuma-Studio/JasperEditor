// Spec 19 TL-089 / TL-090 / TL-091: inspector rows of an appearance, one row per param across the selected clips, so every
// numeric param gets `PropertyRow`'s stopwatch, keyframes, mixed value and relative drag with no code here.
import {
	type Appearance,
	appearancePropertyKey,
	COLOR_ROLES,
	type EffectRegistry,
	effectParamPropertySpec,
	LIGHT_SLOT,
	type LookQuickControl,
	layerParamSpecs,
	layerPropertySpecs,
	MAX_QUICK_CONTROLS,
	PALETTE_SLOT,
	type Paint,
	type ProjectDocument,
	type Role,
	resolvePropertyAt,
	type Sequence,
	TITLE_LOOK_EFFECT_ID,
	TITLE_LOOK_INTENSITY,
	type TitleLook,
	titleLayerType,
	withDefaults,
} from '@jasper/project';
import { bindProperty, makeRow, type Row } from '../panels/properties/lib/model.ts';
import type { LookedClip, SharedLayer } from './selection.ts';

const paintValue = (l: SharedLayer, name: string) => l.layers[0]!.params[name]?.value as Paint | undefined;

/** One param of a shared layer as a row across its clips. */
function layerRow(
	doc: ProjectDocument,
	seq: Sequence,
	shared: SharedLayer,
	param: string,
	frame: number,
): Row | null {
	return makeRow(
		`appearance.${shared.key}.${param}`,
		shared.looked.map((l, i) =>
			bindProperty(doc, seq, l.clip, appearancePropertyKey(l.fx.id, shared.layers[i]!.id, param), frame),
		),
	);
}

/** The rows a layer shows: every active param; a paint's angle only while the paint is a gradient. */
export function layerRows(doc: ProjectDocument, seq: Sequence, shared: SharedLayer, frame: number): Row[] {
	const first = shared.looked[0]!;
	const out: Row[] = [];
	for (const spec of layerPropertySpecs(first.fx, shared.layers[0]!)) {
		const param = spec.key.split('.').pop()!;
		if (param.endsWith('Angle')) {
			const paint = param.slice(0, -'Angle'.length);
			const value = paintValue(shared, paint);
			if (value && value.kind !== 'gradient') continue;
		}
		const row = layerRow(doc, seq, shared, param, frame);
		if (row) out.push(row);
	}
	return out;
}

/** Roles an appearance reads: in its palette, or named by a paint or a gradient stop. */
export function usedRoles(a: Appearance): Role[] {
	const used = new Set<Role>(Object.keys(a.palette) as Role[]);
	const visit = (p: Paint | undefined) => {
		if (p?.kind === 'role') used.add(p.role);
		if (p?.kind === 'gradient')
			for (const s of p.gradient.stops) if ('role' in s.paint) used.add(s.paint.role);
	};
	for (const l of a.layers) for (const anim of Object.values(l.params)) visit(anim.value as Paint);
	return COLOR_ROLES.filter((r) => used.has(r));
}

/** Palette colours, across the clips. */
export function paletteRows(
	doc: ProjectDocument,
	seq: Sequence,
	looked: readonly LookedClip[],
	frame: number,
): Row[] {
	const roles = looked[0] ? usedRoles(looked[0].appearance) : [];
	return roles
		.map((role) =>
			makeRow(
				`appearance.palette.${role}`,
				looked.map((l) =>
					bindProperty(doc, seq, l.clip, appearancePropertyKey(l.fx.id, PALETTE_SLOT, role), frame),
				),
			),
		)
		.filter((r): r is Row => r !== null);
}

/** Light angle and altitude, across the clips. */
export function lightRows(
	doc: ProjectDocument,
	seq: Sequence,
	looked: readonly LookedClip[],
	frame: number,
): Row[] {
	return ['angle', 'altitude']
		.map((p) =>
			makeRow(
				`appearance.light.${p}`,
				looked.map((l) =>
					bindProperty(doc, seq, l.clip, appearancePropertyKey(l.fx.id, LIGHT_SLOT, p), frame),
				),
			),
		)
		.filter((r): r is Row => r !== null);
}

/** Intensity (TL-089): the look effect's own param, across the clips. */
export function intensityRow(
	doc: ProjectDocument,
	seq: Sequence,
	looked: readonly LookedClip[],
	frame: number,
	effects: EffectRegistry,
): Row | null {
	const effect = effects.get(TITLE_LOOK_EFFECT_ID);
	const param = effect?.params.find((p) => p.name === TITLE_LOOK_INTENSITY);
	if (!effect || !param) return null;
	return makeRow(
		'appearance.intensity',
		looked.map((l) => {
			const spec = effectParamPropertySpec(l.fx.id, effect, param);
			return {
				clip: l.clip,
				spec,
				path: ['effect', l.fx.id, param.name],
				resolved: resolvePropertyAt({ doc, seq, clip: l.clip }, spec, frame),
				param: param.name,
			};
		}),
	);
}

/** The layers of a stack a quick control can reach: `nth` of that type, top of the stack first as the list reads. */
function findLayer(stack: readonly SharedLayer[], c: LookQuickControl): SharedLayer | undefined {
	return stack.filter((l) => l.type === c.layerType)[c.nth ?? 0];
}

/** What a look's quick controls are when it names none: each layer's primary value, top of the stack first. */
function primaryControls(stack: readonly SharedLayer[]): LookQuickControl[] {
	const seen = new Map<string, number>();
	const out: LookQuickControl[] = [];
	for (const l of stack) {
		const nth = seen.get(l.type) ?? 0;
		seen.set(l.type, nth + 1);
		const def = titleLayerType(l.type);
		if (!def) continue;
		const stored = Object.fromEntries(Object.entries(l.layers[0]!.params).map(([k, v]) => [k, v.value]));
		const primary = def.summary(withDefaults(def, stored as never), {}).primary;
		if (!primary) continue;
		const spec = layerParamSpecs(def).find((p) => p.name === primary);
		if (spec?.type !== 'number') continue;
		out.push({
			label: `${l.layers[0]!.name ?? def.label} ${spec.label}`,
			layerType: l.type,
			nth,
			param: primary,
		});
	}
	return out.slice(0, 3);
}

/** TL-089: the rows under the Look header: the look's own quick controls, else the first layers' primaries. */
export function quickRows(
	doc: ProjectDocument,
	seq: Sequence,
	stack: readonly SharedLayer[],
	look: Pick<TitleLook, 'quickControls'> | null,
	frame: number,
): { label: string; row: Row }[] {
	const wanted = look?.quickControls?.length ? look.quickControls : primaryControls(stack);
	const out: { label: string; row: Row }[] = [];
	for (const c of wanted.slice(0, MAX_QUICK_CONTROLS)) {
		const shared = findLayer(stack, c);
		const row = shared ? layerRow(doc, seq, shared, c.param, frame) : null;
		if (row) out.push({ label: c.label, row: { ...row, label: c.label } });
	}
	return out;
}
