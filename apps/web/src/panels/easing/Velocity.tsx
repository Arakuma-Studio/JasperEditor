// Easing panel ▸ the Keyframe Velocity editor: for one selected key, its incoming and outgoing speed (property units
// per second — px/s along the drawn path for point properties, signed for numbers) and influence (%), as
// `describeKeyframeEases` reports them; edits run `keyframe.setVelocity` (one undo step each). With Link, an edit
// sets both sides. A side without a segment, a holding or roving key, or a segment whose two keys are equal (no
// speed to scale) is disabled with the reason.
import { cx } from '@jasper/ui';
import { useState } from 'react';
import { t } from '../../i18n/runtime.ts';
import type { EaseDispatch } from './dispatch.tsx';
import { NumberCell } from './NumberCell.tsx';
import type { EaseKeyInfo, EasePropertyInfo } from './selection.ts';

type Side = 'in' | 'out';

/** Why a side of a key has no editable speed / influence, else undefined. */
export function sideReason(p: EasePropertyInfo, k: EaseKeyInfo, side: Side): string | undefined {
	if (k.roving) return t('The keyframe roves across time: its speed follows its run');
	const seg = p.segments.find((s) => (side === 'in' ? s.toId === k.id : s.fromId === k.id));
	if (!seg) return side === 'in' ? t('No keyframe before it') : t('No keyframe after it');
	if (seg.hold) return t('The segment holds its value: it has no speed');
	if (!(side === 'in' ? k.easeIn : k.easeOut)) return t('No segment on this side');
	return undefined;
}

/** Why the speed of a side cannot be set (a flat segment), else undefined. */
export function speedReason(p: EasePropertyInfo, k: EaseKeyInfo, side: Side): string | undefined {
	const seg = p.segments.find((s) => (side === 'in' ? s.toId === k.id : s.fromId === k.id));
	if (seg && seg.averageSpeed === 0)
		return t('Both keys of this segment are equal: it has no speed to set (influence still applies)');
	return undefined;
}

export function VelocityEditor(props: { prop: EasePropertyInfo | null; dispatch: EaseDispatch }) {
	const { prop, dispatch } = props;
	const [index, setIndex] = useState(0);
	const [link, setLink] = useState(false);
	if (!prop || prop.keys.length === 0) return null;
	const k = prop.keys[Math.min(index, prop.keys.length - 1)]!;
	const blocked = dispatch.reason('ease.setVelocity');
	const unit = prop.spatial ? t('px/s') : t('/s');
	const run = (side: Side, values: { speed?: number; influence?: number }) =>
		void dispatch.run('ease.setVelocity', { keyframeId: k.id, side: link ? 'both' : side, ...values });
	const sideFields = (side: Side) => {
		const info = side === 'in' ? k.easeIn : k.easeOut;
		const why = blocked ?? sideReason(prop, k, side);
		const speedWhy = why ?? speedReason(prop, k, side);
		return (
			<div className="flex items-center gap-2" data-testid={`ease-velocity-${side}`}>
				<span className="w-[24px] text-pr-small text-pr-muted">{side === 'in' ? t('In') : t('Out')}</span>
				<NumberCell
					label={t('Speed')}
					value={info?.speed ?? Number.NaN}
					unit={unit}
					digits={2}
					disabled={speedWhy}
					onCommit={(v) => run(side, { speed: v })}
					testId={`ease-velocity-${side}-speed`}
				/>
				<NumberCell
					label={t('Influence')}
					value={info?.influencePercent ?? Number.NaN}
					unit="%"
					digits={2}
					disabled={why}
					onCommit={(v) => run(side, { influence: Math.min(100, Math.max(0.1, v)) })}
					testId={`ease-velocity-${side}-influence`}
				/>
			</div>
		);
	};
	return (
		<section
			className="flex flex-col gap-1 rounded-pr-control border border-pr-border-subtle p-1"
			aria-label="Keyframe velocity"
			data-testid="ease-velocity"
		>
			<div className="flex items-center gap-2">
				<span className="text-pr-small text-pr-text">Keyframe Velocity</span>
				{prop.keys.length > 1 ? (
					<select
						aria-label="Keyframe"
						className="h-[20px] rounded-pr-control bg-pr-field px-1 text-pr-ui text-pr-text"
						value={Math.min(index, prop.keys.length - 1)}
						onChange={(e) => setIndex(Number(e.target.value))}
						data-testid="ease-velocity-key"
					>
						{prop.keys.map((key, i) => (
							<option key={key.id} value={i}>
								{t('Key {0} ({1} s)', i + 1, key.seconds.toFixed(2))}
							</option>
						))}
					</select>
				) : (
					<span className="text-pr-small text-pr-muted">{t('{0} s', k.seconds.toFixed(2))}</span>
				)}
				<span className="ml-auto" />
				<button
					type="button"
					aria-pressed={link}
					title={t('Set the incoming and outgoing side together')}
					className={cx(
						'h-[20px] rounded-pr-control px-2 text-pr-small',
						link ? 'bg-pr-accent-fill text-pr-on-accent' : 'text-pr-muted hover:bg-pr-hover',
					)}
					onClick={() => setLink(!link)}
					data-testid="ease-velocity-link"
				>
					Link
				</button>
			</div>
			{sideFields('in')}
			{sideFields('out')}
		</section>
	);
}
