// Properties rows of a text selection (spec 19 TL-110, TL-111): orientation, upright short runs, and Warp Text. The
// warp's numbers are the effect's own rows, so stopwatches and keyframes work here as in Effect Controls.
import { type Clip, isVerticalText, WARP_STYLE_LABELS, WARP_STYLES, type WarpStyle } from '@jasper/project';
import type { ReactNode } from 'react';
import { CheckboxField, SelectField } from '../panels/properties/controls/fields.tsx';
import type { RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import type { Row } from '../panels/properties/lib/model.ts';
import {
	textClipsOf,
	uprightCommands,
	verticalDisabledReason,
	warpEffectOf,
	warpStyleCommands,
	writingModeCommands,
} from './writing.ts';

const NONE = 'none';
const OPTIONS = [NONE, ...WARP_STYLES] as const;
const LABELS = ['None', ...WARP_STYLES.map((s) => WARP_STYLE_LABELS[s])];
const FX_PARAMS = ['orientation', 'bend', 'horizontalDistortion', 'verticalDistortion'] as const;

/** One value when every clip agrees, else null (a mixed field). */
function common<T>(list: readonly T[]): T | null {
	return list.length > 0 && list.every((v) => v === list[0]) ? list[0]! : null;
}

function FieldRow(props: { label: string; children: ReactNode }) {
	return (
		<div className="flex h-[var(--pr-row-h)] items-center gap-2 pr-1 pl-2">
			<span className="w-[92px] shrink-0 truncate text-pr-ui text-pr-text">{props.label}</span>
			{props.children}
		</div>
	);
}

export function TextLayoutRows(props: {
	clips: readonly Clip[];
	ctx: RowContext;
	rowFor(key: string): Row | null;
	render(r: Row | null): ReactNode;
}) {
	const { clips, ctx, rowFor, render } = props;
	const text = textClipsOf(clips);
	const vertical = common(text.map((c) => isVerticalText(c.content)));
	const upright = common(text.map((c) => c.content.tateChuYoko !== false));
	const blocked = verticalDisabledReason(clips);
	const styleOf = (c: Clip): string => {
		const fx = warpEffectOf(c) as { params?: { style?: { value?: unknown } } } | null;
		return fx ? String(fx.params?.style?.value ?? 'arc') : NONE;
	};
	const style = common(clips.map(styleOf));
	const single = clips.length === 1 ? warpEffectOf(clips[0]!) : null;
	return (
		<>
			<FieldRow label="Orientation">
				<SelectField
					value={vertical === null ? null : vertical ? 'vertical' : 'horizontal'}
					options={['horizontal', 'vertical'] as const}
					labels={['Horizontal', 'Vertical']}
					label="Orientation"
					data-testid="text-orientation"
					disabled={!!blocked && vertical !== true}
					onChange={(v) =>
						ctx.ops.apply(
							v === 'vertical' ? 'Vertical Text' : 'Horizontal Text',
							writingModeCommands(clips, v === 'vertical'),
						)
					}
				/>
			</FieldRow>
			{blocked && vertical !== true ? <p className="px-2 text-pr-small text-pr-muted">{blocked}</p> : null}
			{vertical !== false ? (
				<FieldRow label="Short runs">
					<CheckboxField
						value={upright}
						label="Short runs upright"
						onChange={(v) => ctx.ops.apply('Short Runs Upright', uprightCommands(clips, v))}
					>
						Upright (tate-chu-yoko)
					</CheckboxField>
				</FieldRow>
			) : null}
			<FieldRow label="Warp">
				<SelectField
					value={style}
					options={OPTIONS}
					labels={LABELS}
					label="Warp"
					data-testid="text-warp-style"
					onChange={(v) =>
						ctx.ops.apply(
							v === NONE ? 'Remove Warp' : 'Warp Text',
							warpStyleCommands(clips, v === NONE ? null : (v as WarpStyle)),
						)
					}
				/>
			</FieldRow>
			{single ? FX_PARAMS.map((p) => render(rowFor(`effects.${single.id}.${p}`))) : null}
		</>
	);
}
