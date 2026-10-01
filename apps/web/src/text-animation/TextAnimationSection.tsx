// Text Animation section (S11:TXA-021/022) shared by Properties (registered through `clipSections`) and Effect
// Controls: for In and Out, the preset picker ("None" first), Duration (frames, scrubby, timecode tooltip) and
// the preset's params form (rows of the `textAnimation` property group), plus a reset per side. With several
// text clips selected every edit applies to all of them; params show when they share the preset.
import { type Clip, formatTimecode, type TextAnimationSide, textAnimationParamSpecs } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useTransportFrame } from '@jasper/session/react';
import { MiniButton } from '../panels/properties/controls/fields.tsx';
import { ResetGlyph } from '../panels/properties/controls/glyphs.tsx';
import { useNotices } from '../panels/properties/controls/Notices.tsx';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { useInspectorData } from '../panels/properties/lib/hooks.ts';
import { bindProperty, makeRow, type Row } from '../panels/properties/lib/model.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { applyMessage, applyTextAnimation, removeTextAnimation } from './actions.ts';
import { PresetPicker } from './PresetPreview.tsx';

type TextClip = Extract<Clip, { kind: 'text' }>;

export function TextAnimationSection(props: {
	session: EditorSession;
	clipIds: readonly string[];
	host: 'properties' | 'effectControls';
}) {
	const { session, host } = props;
	const data = useInspectorData();
	const frame = useTransportFrame(66).frame;
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const seq = data.selection?.seq;
	if (!seq) return null;
	const clips = props.clipIds.map((id) => seq.clips[id]).filter((c): c is TextClip => c?.kind === 'text');
	if (!clips.length) return null;
	const ctx: RowContext = {
		doc: data.doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: host,
		hint: notices.hint,
		confirmStopwatchOff: notices.confirmStopwatchOff,
	};
	const ids = clips.map((c) => c.id);
	const row = (key: string): Row | null => {
		const r = makeRow(
			key,
			clips.map((c) => bindProperty(data.doc, seq, c, key, frame)),
		);
		return r && r.bindings.length === clips.length ? r : null;
	};
	const report = (r: Parameters<typeof applyMessage>[0]) => {
		const m = applyMessage(r);
		if (m) notices.hint(m.text);
	};
	const rate = seq.settings.frameRate;
	const side = (s: TextAnimationSide) => {
		const presets = [...new Set(clips.map((c) => c.textAnimation?.[s]?.preset ?? null))];
		const value = presets.length === 1 ? presets[0]! : '';
		const label = s === 'in' ? 'In' : 'Out';
		const sameAnimator =
			value !== '' &&
			value !== null &&
			new Set(clips.map((c) => `${c.textAnimation?.[s]?.preset}@${c.textAnimation?.[s]?.version}`)).size ===
				1;
		const duration = sameAnimator ? row(`textAnimation.${s}.durationFrames`) : null;
		const frames = clips[0]!.textAnimation?.[s]?.durationFrames ?? 0;
		const params = sameAnimator
			? textAnimationParamSpecs(clips[0]!)
					.filter((p) => p.key.startsWith(`textAnimation.${s}.`))
					.map((p) => row(p.key))
					.filter((r): r is Row => r !== null)
			: [];
		return (
			<div key={s} data-testid={`text-anim-side-${s}`} className="pb-1">
				<div className="flex h-[var(--pr-row-h)] items-center gap-1 pr-2 pl-3">
					<span className="w-[72px] shrink-0 text-pr-muted">{label}</span>
					<PresetPicker
						side={s}
						value={value}
						onPick={(preset) =>
							report(
								preset === null
									? removeTextAnimation(session, ids, s)
									: applyTextAnimation(session, ids, { side: s, preset }),
							)
						}
					/>
					{value ? (
						<MiniButton
							label={`Reset ${label} animation`}
							onClick={() => report(applyTextAnimation(session, ids, { side: s, preset: value }))}
							data-testid={`text-anim-reset-${s}`}
						>
							<ResetGlyph size={12} />
						</MiniButton>
					) : null}
				</div>
				{value === '' ? (
					<p className="px-3 text-pr-small text-pr-muted">Mixed presets — pick one to edit them together</p>
				) : null}
				{duration ? (
					<div
						title={`${formatTimecode(frames, rate)} (${((frames * rate.den) / rate.num).toFixed(2)} s)`}
						data-testid={`text-anim-duration-${s}`}
					>
						<PropertyRow row={{ ...duration, label: 'Duration' }} ctx={ctx} indent />
					</div>
				) : null}
				{params.map((r) => (
					<PropertyRow key={r.id} row={{ ...r, label: r.label.replace(/^(In|Out) /, '') }} ctx={ctx} indent />
				))}
			</div>
		);
	};
	return (
		<div data-testid={`text-anim-section-${host}`}>
			{notices.element}
			{side('in')}
			{side('out')}
		</div>
	);
}
