// Paste Attributes / Remove Attributes options (S01:CLB-005, S03:FX-011/012): the checkbox rows the dialog
// shows, derived from the copied clip (or effects) and the target clips. Time Remapping and Channel Volume are
// P2 and not modelled, so they have no row (no stubs).
import {
	type Clip,
	type ClipboardPayload,
	type EffectInstance,
	type EffectRegistry,
	kindCapabilities,
	type PasteAttributes,
} from '@jasper/project';

export type AttributeGroup = 'video' | 'audio' | 'effects' | 'text' | 'shape';

export type AttributeOption = {
	/** `motion`, `opacity`, `volume`, `panner`, `textAnimationIn`, …, or `fx:<id>` (effects). */
	key: string;
	label: string;
	group: AttributeGroup;
	/** False when no target clip can take it (shown disabled with `reason`). */
	available: boolean;
	reason?: string;
};

const isAudio = (k: string) => k === 'audio' || k === 'nest-audio';

function effectLabel(
	registry: EffectRegistry,
	fx: Pick<EffectInstance, 'effectId' | 'effectVersion'>,
): string {
	return (
		registry.get(fx.effectId, fx.effectVersion)?.label ?? registry.get(fx.effectId)?.label ?? fx.effectId
	);
}

type Source = {
	kind: string;
	has: { motion: boolean; opacity: boolean; volume: boolean; panner: boolean };
	effects: EffectInstance[];
	textIn: boolean;
	textOut: boolean;
	textStyle: boolean;
	shape: boolean;
};

function sourcesOf(p: ClipboardPayload): Source[] {
	if (p.kind === 'effects' && p.effects) {
		const i = p.effects.intrinsic ?? {};
		return [
			{
				kind: p.effects.source.clipKind,
				has: { motion: !!i.transform, opacity: !!i.opacity, volume: !!i.volumeDb, panner: !!i.pan },
				effects: p.effects.effects,
				textIn: false,
				textOut: false,
				textStyle: false,
				shape: false,
			},
		];
	}
	const sec = p.clips;
	if (!sec) return [];
	return [...sec.clips]
		.sort((a, b) => Number(b.id === sec.primaryClipId) - Number(a.id === sec.primaryClipId))
		.map((c) => {
			const r = c as Record<string, unknown>;
			const ta = r.textAnimation as { in?: unknown; out?: unknown } | undefined;
			return {
				kind: c.kind,
				has: { motion: !!r.transform, opacity: !!r.opacity, volume: !!r.volumeDb, panner: !!r.pan },
				effects: (r.effects as EffectInstance[] | undefined) ?? [],
				textIn: !!ta?.in,
				textOut: !!ta?.out,
				textStyle: c.kind === 'text',
				shape: c.kind === 'shape',
			};
		});
}

/** Rows of the Paste Attributes dialog: what the clipboard holds, enabled when some target can take it. */
export function pasteAttributeOptions(
	p: ClipboardPayload,
	targets: readonly Clip[],
	registry: EffectRegistry,
): AttributeOption[] {
	const sources = sourcesOf(p);
	const any = (pick: (s: Source) => boolean) => sources.some(pick);
	const takes = (test: (c: Clip & Record<string, unknown>) => boolean) =>
		targets.some((c) => test(c as Clip & Record<string, unknown>));
	const out: AttributeOption[] = [];
	const row = (key: string, label: string, group: AttributeGroup, ok: boolean, reason: string) =>
		out.push({ key, label, group, available: ok, ...(ok ? {} : { reason }) });
	const visual = 'The selected clips have no video';
	if (any((s) => s.has.motion))
		row(
			'motion',
			'Motion',
			'video',
			takes((c) => !!kindCapabilities(c.kind)?.hasTransform && !!c.transform),
			visual,
		);
	if (any((s) => s.has.opacity))
		row(
			'opacity',
			'Opacity',
			'video',
			takes((c) => !!c.opacity),
			visual,
		);
	const audio = 'The selected clips have no audio';
	if (any((s) => s.has.volume))
		row(
			'volume',
			'Volume',
			'audio',
			takes((c) => !!c.volumeDb),
			audio,
		);
	if (any((s) => s.has.panner))
		row(
			'panner',
			'Panner',
			'audio',
			takes((c) => !!c.pan),
			audio,
		);
	for (const s of sources)
		for (const fx of s.effects) {
			const spec = registry.get(fx.effectId, fx.effectVersion) ?? registry.get(fx.effectId);
			const medium = spec?.appliesTo ?? (isAudio(s.kind) ? 'audio' : 'video');
			const ok = takes((c) => {
				const caps = kindCapabilities(c.kind);
				return !!caps?.supportsEffects && (medium === 'audio' ? caps.audio : caps.visual);
			});
			row(
				`fx:${fx.id}`,
				effectLabel(registry, fx),
				'effects',
				ok,
				`No selected clip takes ${medium} effects`,
			);
		}
	const text = 'Select text clips to paste text attributes';
	if (any((s) => s.textIn))
		row(
			'textAnimationIn',
			'In Animation',
			'text',
			takes((c) => c.kind === 'text'),
			text,
		);
	if (any((s) => s.textOut))
		row(
			'textAnimationOut',
			'Out Animation',
			'text',
			takes((c) => c.kind === 'text'),
			text,
		);
	if (any((s) => s.textStyle))
		row(
			'textStyle',
			'Text Style',
			'text',
			takes((c) => c.kind === 'text'),
			text,
		);
	if (any((s) => s.shape))
		row(
			'shapeStyle',
			'Shape Style (fill, stroke, corners)',
			'shape',
			takes((c) => c.kind === 'shape'),
			'Select shapes',
		);
	return out;
}

/** Rows of the Remove Attributes dialog: what the targets have (effects by registry id). */
export function removeAttributeOptions(
	targets: readonly Clip[],
	registry: EffectRegistry,
): AttributeOption[] {
	const t = targets as (Clip & Record<string, unknown>)[];
	const out: AttributeOption[] = [];
	const row = (key: string, label: string, group: AttributeGroup) =>
		out.push({ key, label, group, available: true });
	if (t.some((c) => !!kindCapabilities(c.kind)?.hasTransform && !!c.transform))
		row('motion', 'Motion', 'video');
	if (t.some((c) => !!c.opacity)) row('opacity', 'Opacity', 'video');
	if (t.some((c) => !!c.volumeDb)) row('volume', 'Volume', 'audio');
	if (t.some((c) => !!c.pan)) row('panner', 'Panner', 'audio');
	const seen = new Set<string>();
	for (const c of t)
		for (const fx of (c.effects as EffectInstance[] | undefined) ?? []) {
			if (seen.has(fx.effectId)) continue;
			seen.add(fx.effectId);
			row(`fx:${fx.effectId}`, effectLabel(registry, fx), 'effects');
		}
	const ta = (side: 'in' | 'out') =>
		t.some((c) => !!(c.textAnimation as Record<string, unknown> | undefined)?.[side]);
	if (ta('in')) row('textAnimationIn', 'In Animation', 'text');
	if (ta('out')) row('textAnimationOut', 'Out Animation', 'text');
	return out;
}

/** Checked rows → `clip.pasteAttributes` attributes (effects by payload instance id). */
export function toPasteAttributes(keys: readonly string[]): PasteAttributes {
	const set = new Set(keys);
	return {
		...toRemoveAttributes(keys),
		...(set.has('textStyle') ? { textStyle: true } : {}),
		...(set.has('shapeStyle') ? { shapeStyle: true } : {}),
	};
}

/** Checked rows → `clip.removeAttributes` attributes (effects by registry id). */
export function toRemoveAttributes(keys: readonly string[]) {
	const set = new Set(keys);
	const fx = keys.filter((k) => k.startsWith('fx:')).map((k) => k.slice(3));
	return {
		...(set.has('motion') ? { motion: true } : {}),
		...(set.has('opacity') ? { opacity: true } : {}),
		...(set.has('volume') ? { volume: true } : {}),
		...(set.has('panner') ? { panner: true } : {}),
		...(fx.length ? { effects: fx } : {}),
		...(set.has('textAnimationIn') ? { textAnimationIn: true } : {}),
		...(set.has('textAnimationOut') ? { textAnimationOut: true } : {}),
	};
}
