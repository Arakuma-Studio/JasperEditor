// The toolbar over text selected in place (spec 19 TL-093): styles for the selected word or letter, as `content.runs`.
// Buttons keep the editor's focus and selection; the colour and finish fields need focus of their own, and hand it back.
// Everything here belongs to the entry's one History step. The look applies over the runs: size, weight, font and
// spacing change its shape field, so rims wrap the styled letters as one continuous outline; a colour shows where the
// look's face paints the clip's own picture (`source`), and a finish is the look's own, per letter.
import {
	type RunPatch,
	type TextContent,
	type TextStyle,
	TITLE_FINISHES,
	textRunAt,
	type Vec2,
} from '@jasper/project';
import type { ReactNode } from 'react';
import { t, withoutContext } from '../i18n/runtime.ts';

const SIZE_STEP = 1.2;
const to255 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
const hexOf = (c: readonly number[]) =>
	`#${c
		.slice(0, 3)
		.map((x) => to255(x).toString(16).padStart(2, '0'))
		.join('')}`;

export type RunState = {
	bold: boolean;
	italic: boolean;
	sizePx: number;
	fill: readonly number[];
	finish: string;
	/** The selection has overrides to clear. */
	styled: boolean;
};

/** What the selection shows now (of its first character). */
export function runStateOf(content: TextContent, sel: { start: number; end: number }): RunState {
	const run = textRunAt(content.runs, sel.start);
	const s = { ...content.style, ...run?.style } as TextStyle;
	return {
		bold: s.weight >= 600,
		italic: s.italic,
		sizePx: s.sizePx,
		fill: s.fill,
		finish: typeof run?.finish === 'string' ? run.finish : '',
		styled: (content.runs ?? []).some((r) => r.from < sel.end && r.to > sel.start),
	};
}

function Toggle(props: {
	label: string;
	pressed?: boolean;
	onPress(): void;
	action: string;
	children: ReactNode;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={props.label}
			title={props.label}
			aria-pressed={props.pressed}
			disabled={props.disabled}
			data-run-action={props.action}
			className="min-w-[24px] rounded-pr-control px-1.5 py-0.5 text-pr-small text-pr-text hover:bg-pr-hover aria-pressed:bg-pr-selected disabled:text-pr-dim"
			onClick={props.onPress}
		>
			{props.children}
		</button>
	);
}

export function RunToolbar(props: {
	at: Vec2;
	state: RunState;
	/** The clip has a look: per-letter finishes apply. */
	look: boolean;
	uiAttr: string;
	onPatch(patch: RunPatch | null): void;
	/** A field that took the focus is done: the editor gets it back. */
	onDone(): void;
	/** The focus left a field for somewhere else: a click away. */
	onLeave(): void;
}) {
	const { at, state, onPatch } = props;
	const leave = (e: { relatedTarget: EventTarget | null }) => {
		const to = e.relatedTarget as Element | null;
		if (!to?.closest?.(`[${props.uiAttr}]`) && !to?.closest?.('[data-testid="text-entry-input"]'))
			props.onLeave();
	};
	return (
		<div
			role="toolbar"
			aria-label={t('Text selection')}
			{...{ [props.uiAttr]: '' }}
			className="pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-pr-control border border-pr-menu-border bg-pr-menu p-0.5 shadow"
			style={{ left: at[0], top: at[1] - 6, transform: 'translate(-50%, -100%)' }}
			data-testid="text-run-toolbar"
			// Keep the editor's focus and selection while a button is pressed; fields take it themselves.
			onPointerDown={(e) => {
				if (!(e.target as Element).closest('input,select')) e.preventDefault();
			}}
			onMouseDown={(e) => {
				if (!(e.target as Element).closest('input,select')) e.preventDefault();
			}}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<Toggle
				label={withoutContext('Bold [text run]')}
				action="bold"
				pressed={state.bold}
				onPress={() => onPatch({ style: { weight: state.bold ? 400 : 700 } })}
			>
				<b>B</b>
			</Toggle>
			<Toggle
				label={withoutContext('Italic [text run]')}
				action="italic"
				pressed={state.italic}
				onPress={() => onPatch({ style: { italic: !state.italic } })}
			>
				<i>I</i>
			</Toggle>
			<Toggle
				label={t('Smaller')}
				action="smaller"
				onPress={() => onPatch({ style: { sizePx: Math.max(1, Math.round(state.sizePx / SIZE_STEP)) } })}
			>
				A−
			</Toggle>
			<Toggle
				label={t('Larger')}
				action="larger"
				onPress={() => onPatch({ style: { sizePx: Math.round(state.sizePx * SIZE_STEP) } })}
			>
				A+
			</Toggle>
			<input
				type="color"
				aria-label={t('Color of the selected text')}
				title={
					props.look
						? t('A look paints over this color unless its face uses the clip’s own picture')
						: t('Color of the selected text')
				}
				data-run-action="fill"
				className="mx-0.5 h-4 w-6 cursor-pointer"
				value={hexOf(state.fill)}
				onChange={(e) => {
					const v = e.target.value;
					const n = (i: number) => Number.parseInt(v.slice(i, i + 2), 16) / 255;
					onPatch({ style: { fill: [n(1), n(3), n(5), 1] } });
				}}
				onBlur={leave}
			/>
			{props.look ? (
				<select
					aria-label={t('Finish of the selected letters')}
					data-run-action="finish"
					className="max-w-[96px] rounded-pr-control bg-pr-menu px-0.5 text-pr-small text-pr-text"
					value={state.finish}
					onChange={(e) => {
						onPatch({ finish: e.target.value || null });
						props.onDone();
					}}
					onBlur={leave}
				>
					<option value="">{t('Look’s finish')}</option>
					{TITLE_FINISHES.map((f) => (
						<option key={f.id} value={f.id}>
							{f.label}
						</option>
					))}
				</select>
			) : null}
			<Toggle
				label={withoutContext('Clear [text run styles]')}
				action="clear"
				disabled={!state.styled}
				onPress={() => onPatch(null)}
			>
				{t('Clear')}
			</Toggle>
		</div>
	);
}
