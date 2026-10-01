// Preset previews and the preset picker (S11:TXA-020/021): a static poster of the "Aa Title" sample mid-motion
// and, on hover, the shared looping Player (PreviewThumb: reduced motion / touch keep the poster). The picker is
// a popover grid with "None" first; it lists the presets that support the side.
import {
	TEXT_ANIMATION_PREVIEW,
	TextAnimationPreview,
	type TextAnimationPreviewSide,
	textAnimationPreviewTiming,
} from '@jasper/compositions';
import { TEXT_ANIMATION_SPECS, type TextAnimationSide, type TextAnimationSpec } from '@jasper/project';
import { cx } from '@jasper/ui';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { PreviewThumb } from '../panels/motionTemplates/PreviewThumb.tsx';

/** The newest version of every preset id, in catalogue order. */
export const LATEST_TEXT_ANIMATIONS: readonly TextAnimationSpec[] = TEXT_ANIMATION_SPECS.filter(
	(s) => !TEXT_ANIMATION_SPECS.some((o) => o.id === s.id && o.version > s.version),
);

export function PresetPreview({
	spec,
	side,
	className,
}: {
	spec: TextAnimationSpec;
	side: TextAnimationPreviewSide;
	className?: string;
}) {
	const timing = textAnimationPreviewTiming(spec.defaultDurationFrames, side);
	return (
		<PreviewThumb
			component={TextAnimationPreview}
			inputProps={{ preset: spec.id, version: spec.version, side }}
			durationInFrames={timing.durationInFrames}
			fps={TEXT_ANIMATION_PREVIEW.fps}
			width={TEXT_ANIMATION_PREVIEW.width}
			height={TEXT_ANIMATION_PREVIEW.height}
			posterFrame={timing.posterFrame}
			label={`${spec.label} preview`}
			className={className}
		/>
	);
}

/** Grid of the presets of one side, "None" first; `value` = current preset id, null = none, '' = mixed. */
export function PresetGrid({
	side,
	value,
	onPick,
}: {
	side: TextAnimationSide;
	value: string | null;
	onPick(preset: string | null): void;
}) {
	const cell =
		'flex flex-col gap-0.5 rounded-pr-control border p-0.5 text-left outline-none focus-visible:border-pr-focus';
	const tone = (on: boolean) =>
		on ? 'border-pr-accent bg-pr-selected' : 'border-pr-border-subtle hover:border-pr-border-strong';
	return (
		<div
			className="grid grid-cols-3 gap-1"
			role="listbox"
			aria-label={`${side === 'in' ? 'In' : 'Out'} presets`}
		>
			<button
				type="button"
				role="option"
				aria-selected={value === null}
				className={cx(cell, tone(value === null))}
				onClick={() => onPick(null)}
				data-preset="none"
			>
				<span className="aspect-video w-full rounded-pr-control bg-pr-field-deep" />
				<span className="truncate px-0.5 text-pr-small text-pr-text">None</span>
			</button>
			{LATEST_TEXT_ANIMATIONS.filter((s) => s.phases.includes(side)).map((s) => (
				<button
					key={s.id}
					type="button"
					role="option"
					aria-selected={value === s.id}
					className={cx(cell, tone(value === s.id))}
					onClick={() => onPick(s.id)}
					data-preset={s.id}
					title={s.description}
				>
					<span className="w-full overflow-hidden rounded-pr-control bg-pr-field-deep">
						<PresetPreview spec={s} side={side} />
					</span>
					<span className="truncate px-0.5 text-pr-small text-pr-text">{s.label}</span>
				</button>
			))}
		</div>
	);
}

/** Button showing the current preset that opens the picker popover. */
export function PresetPicker({
	side,
	value,
	onPick,
	disabled,
}: {
	side: TextAnimationSide;
	/** Current preset id, null = none, '' = mixed (multi-selection). */
	value: string | null;
	onPick(preset: string | null): void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const label =
		value === null
			? 'None'
			: value === ''
				? '–'
				: (LATEST_TEXT_ANIMATIONS.find((s) => s.id === value)?.label ?? `${value} (not installed)`);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild disabled={disabled}>
				<button
					type="button"
					aria-label={`${side === 'in' ? 'In' : 'Out'} animation: ${label}`}
					data-testid={`text-anim-picker-${side}`}
					className="h-[20px] min-w-0 flex-1 truncate rounded-pr-control bg-pr-field px-1.5 text-left text-pr-ui text-pr-text hover:bg-pr-hover disabled:opacity-40 data-[state=open]:bg-pr-pressed"
				>
					{label}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					sideOffset={4}
					collisionPadding={8}
					className="z-[var(--pr-z-popover)] max-h-[70vh] w-[360px] overflow-y-auto rounded-pr-menu border border-pr-menu-border bg-pr-menu p-1 shadow-pr-overlay"
					data-testid={`text-anim-popover-${side}`}
				>
					<PresetGrid
						side={side}
						value={value}
						onPick={(p) => {
							setOpen(false);
							onPick(p);
						}}
					/>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
