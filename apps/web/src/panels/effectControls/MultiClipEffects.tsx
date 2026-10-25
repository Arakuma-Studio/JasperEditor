// spec 13 AS-031: Effect Controls "N clips" mode. With several clips of one medium selected, the panel lists what they
// all share — Motion and Opacity (or Volume and Panner) and every applied effect present on each clip, matched by
// effect id + occurrence (the 2nd Gaussian Blur of each clip is one row set). Editing a parameter sets every matching
// instance in one History entry (mixed values show –, a scrub moves each by the same amount); keyed parameters are
// edited "relative to each clip's In": the playhead's offset from the primary clip's In is the key time in every clip.
// Add an effect to all (drop it here), bypass or remove it on all. No mini-timeline in this mode.
import type { Clip, Command, EffectInstance, EffectSpec, ProjectDocument, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { cx } from '@jasper/ui';
import { type DragEvent, useMemo, useState } from 'react';
import { formatTimecode } from '../../gaps/time-display.ts';
import { t } from '../../i18n/runtime.ts';
import { applyEffectToClips, isEffectDrag, readEffectDragPayload } from '../effects/drag.ts';
import { MiniButton } from '../properties/controls/fields.tsx';
import { FxGlyph, TrashGlyph } from '../properties/controls/glyphs.tsx';
import { PropertyRow, type RowContext } from '../properties/controls/PropertyRow.tsx';
import { Section } from '../properties/controls/Section.tsx';
import {
	bindEffectParam,
	bindProperty,
	isAudioClip,
	makeRow,
	type Row,
	relativePlanner,
} from '../properties/lib/model.ts';

/** One effect shared by every clip: its id, occurrence and each clip's instance. */
export type SharedEffect = {
	key: string;
	effectId: string;
	occurrence: number;
	spec: EffectSpec | undefined;
	instances: { clip: Clip; fx: EffectInstance }[];
};

const effectsOf = (c: Clip) => (c as { effects?: EffectInstance[] }).effects ?? [];

/** Applied effects present on every clip, matched by effect id + occurrence, in the anchor clip's stack order. */
export function sharedEffects(
	clips: readonly Clip[],
	anchor: Clip,
	registry: { get(id: string, v?: number): EffectSpec | undefined },
): SharedEffect[] {
	const keyed = (c: Clip) => {
		const seen = new Map<string, number>();
		return effectsOf(c).map((fx) => {
			const n = seen.get(fx.effectId) ?? 0;
			seen.set(fx.effectId, n + 1);
			return { key: `${fx.effectId}#${n}`, occurrence: n, fx };
		});
	};
	const maps = clips.map((c) => new Map(keyed(c).map((k) => [k.key, k.fx])));
	return keyed(anchor)
		.filter((k) => maps.every((m) => m.has(k.key)))
		.map((k) => ({
			key: k.key,
			effectId: k.fx.effectId,
			occurrence: k.occurrence,
			spec: registry.get(k.fx.effectId, k.fx.effectVersion),
			instances: clips.map((c, i) => ({ clip: c, fx: maps[i]!.get(k.key)! })),
		}));
}

const VISUAL_INTRINSICS: [string, string[]][] = [
	['Motion', ['transform.position', 'transform.scale', 'transform.rotation', 'transform.anchor']],
	['Opacity', ['opacity']],
];
const AUDIO_INTRINSICS: [string, string[]][] = [
	['Volume', ['volumeDb']],
	['Panner', ['pan']],
];

export function MultiClipEffects(props: {
	session: EditorSession;
	doc: ProjectDocument;
	seq: Sequence;
	/** The selected clips of one medium (≥ 2). */
	clips: Clip[];
	/** The primary clip: the playhead's offset from its In is the key time in every clip. */
	anchor: Clip;
	frame: number;
	ctx: RowContext;
}) {
	const { session, doc, seq, clips, anchor, frame } = props;
	const registry = session.ctx.registries.effects;
	const [dropping, setDropping] = useState(false);
	const offset = frame - anchor.start;
	const planner = useMemo(() => relativePlanner(anchor), [anchor]);
	const ctx: RowContext = { ...props.ctx, planner };
	const audio = isAudioClip(anchor);
	const shared = sharedEffects(clips, anchor, registry);
	const n = clips.length;
	const label = (what: string) => `${what} (${n} clips)`;
	const apply = (what: string, commands: Command[]) => ctx.ops.apply(label(what), commands);

	/** A row over every clip, each value read at the clip's own In + offset. */
	const intrinsicRow = (key: string): Row | null => {
		const row = makeRow(
			key,
			clips.map((c) => bindProperty(doc, seq, c, key, c.start + offset, session.ctx.registries.mgTemplates)),
		);
		return row && row.bindings.length === n ? row : null;
	};
	const effectRow = (s: SharedEffect, param: EffectSpec['params'][number]): Row | null =>
		s.spec
			? makeRow(
					`effects.${s.key}.${param.name}`,
					s.instances.map(({ clip, fx }) => bindEffectParam(doc, seq, clip, fx, s.spec!, param, clip.start + offset)),
				)
			: null;

	const onDrop = (e: DragEvent) => {
		setDropping(false);
		const payload = readEffectDragPayload(e.dataTransfer);
		if (!payload) return;
		e.preventDefault();
		const r = applyEffectToClips(
			session,
			payload.effectId,
			clips.map((c) => c.id),
		);
		if (!r?.ok)
			ctx.hint(r?.ok === false ? (r.errors[0]?.message ?? '') : t('This effect cannot be applied to these clips.'));
	};
	const rate = seq.settings.frameRate;
	return (
		<div
			className={cx('min-h-0 flex-1 overflow-y-auto', dropping && 'outline outline-1 -outline-offset-1 outline-pr-focus')}
			data-testid="ec-multi"
			onDragOver={(e) => {
				if (!isEffectDrag(e.dataTransfer)) return;
				e.preventDefault();
				setDropping(true);
			}}
			onDragLeave={() => setDropping(false)}
			onDrop={onDrop}
		>
			<div className="flex items-center gap-2 border-pr-border-subtle border-b px-2 py-1">
				<span
					className="truncate rounded-pr-control bg-pr-selected px-2 py-[2px] text-pr-small text-pr-strong"
					data-testid="ec-multi-chip"
				>
					{t('{0} clips', n)}
				</span>
				<span
					className="truncate text-pr-small text-pr-muted"
					title="Keys are set at this offset from each clip's In"
					data-testid="ec-multi-offset"
				>
					{t('Keys at In + {0}', formatTimecode(Math.max(0, offset), rate, { dropFrame: seq.settings.dropFrame }))}
				</span>
			</div>
			{offset < 0 || offset >= anchor.duration ? (
				<p className="px-2 py-1 text-pr-small text-pr-muted">
					Move the playhead over the primary clip: its offset from the clip's In is the key time in every clip.
				</p>
			) : null}
			{(audio ? AUDIO_INTRINSICS : VISUAL_INTRINSICS).map(([title, keys]) => {
				const rows = keys.map(intrinsicRow).filter((r): r is Row => r !== null);
				if (!rows.length) return null;
				return (
					<Section key={title} id={`ec.multi.${title}`} title={title} variant="group">
						{rows.map((r) => (
							<PropertyRow key={r.id} row={r} ctx={ctx} indent />
						))}
					</Section>
				);
			})}
			{shared.map((s) => {
				const enabled = s.instances.every((i) => i.fx.enabled);
				const name = s.spec?.label ?? s.effectId;
				const title = s.occurrence > 0 ? `${name} ${s.occurrence + 1}` : name;
				return (
					<Section
						key={s.key}
						id={`ec.multi.fx.${s.effectId}`}
						variant="group"
						title={
							<span className={cx('flex items-center gap-1', !enabled && 'text-pr-dim')} data-testid={`ec-multi-fx-${s.key}`}>
								{s.spec ? title : t('Missing effect: {0}', s.effectId)}
							</span>
						}
						actions={
							<span className="flex items-center">
								<MiniButton
									label={enabled ? t('Bypass {0} on all clips', name) : t('Enable {0} on all clips', name)}
									active={enabled}
									onClick={() =>
										apply(
											enabled ? `Bypass ${name}` : `Enable ${name}`,
											s.instances.map(
												({ fx }) =>
													({ type: 'effect.setEnabled', effectInstanceId: fx.id, enabled: !enabled }) as Command,
											),
										)
									}
									data-testid={`ec-multi-bypass-${s.key}`}
								>
									<FxGlyph size={13} off={!enabled} />
								</MiniButton>
								<MiniButton
									label={t('Remove {0} from all clips', name)}
									onClick={() =>
										apply(`Remove ${name}`, [
											{
												type: 'effect.removeMany',
												clipIds: clips.map((c) => c.id),
												effectId: s.effectId,
												occurrence: s.occurrence,
											} as Command,
										])
									}
									data-testid={`ec-multi-remove-${s.key}`}
								>
									<TrashGlyph size={12} />
								</MiniButton>
							</span>
						}
					>
						{(s.spec?.params ?? [])
							.filter((p) => p.type !== 'mesh')
							.map((p) => effectRow(s, p))
							.filter((r): r is Row => r !== null)
							.map((r) => (
								<PropertyRow key={r.id} row={r} ctx={ctx} indent />
							))}
					</Section>
				);
			})}
			{shared.length === 0 ? (
				<p className="px-2 py-2 text-pr-small text-pr-muted" data-testid="ec-multi-empty">
					No applied effect is on every selected clip. Drop an effect here to add it to all of them.
				</p>
			) : (
				<p className="px-2 py-2 text-pr-small text-pr-dim">Drop an effect here to add it to all selected clips.</p>
			)}
		</div>
	);
}
