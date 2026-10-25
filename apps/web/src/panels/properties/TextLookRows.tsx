// spec 13 AS-030: the stroke list and the shadow of the selected text clips. Every row edits every selected clip in
// one History entry ("Stroke 1 Width (108 clips)"); differing values show mixed (–, a split swatch, Mixed) and a
// scrub over mixed numbers moves each clip by the same amount. Add / remove a stroke on every clip in one step.
import { type Clip, type Command, DEFAULT_TEXT_STROKE, MAX_TEXT_STROKES } from '@jasper/project';
import type { ReactNode } from 'react';
import { t } from '../../i18n/runtime.ts';
import { MiniButton } from './controls/fields.tsx';
import { TrashGlyph } from './controls/glyphs.tsx';
import type { PropertyRow, RowContext } from './controls/PropertyRow.tsx';
import type { Row } from './lib/model.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;
type RenderRow = (r: Row | null, extra?: Partial<Parameters<typeof PropertyRow>[0]>) => ReactNode;

export function StrokeList(props: {
	clips: TextClip[];
	ctx: RowContext;
	rowFor(key: string): Row | null;
	render: RenderRow;
}) {
	const { clips, ctx, rowFor, render } = props;
	const counts = clips.map((c) => c.content.style.strokes.length);
	const max = Math.max(0, ...counts);
	const ids = clips.map((c) => c.id);
	const setStyle = (what: string, patch: Record<string, unknown>) =>
		ctx.ops.apply(clips.length > 1 ? `${what} (${clips.length} clips)` : what, [
			{ type: 'text.setStyle', clipIds: ids, patch } as Command,
		]);
	return (
		<div data-testid="text-stroke-list">
			{Array.from({ length: max }, (_, i) => {
				const have = counts.filter((n) => n > i).length;
				return (
					<div key={i} data-testid={`text-stroke-${i}`}>
						<div className="flex h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-2">
							<span className="flex-1 truncate text-pr-ui text-pr-text">
								{have === clips.length ? t('Stroke {0}', i + 1) : t('Stroke {0} (on {1} of {2})', i + 1, have, clips.length)}
							</span>
							<MiniButton
								label={t('Remove stroke {0}', i + 1)}
								onClick={() => setStyle(`Remove Stroke ${i + 1}`, { strokes: { remove: [i] } })}
								data-testid={`text-stroke-remove-${i}`}
							>
								<TrashGlyph size={12} />
							</MiniButton>
						</div>
						{(['color', 'width', 'position'] as const).map((f) => render(rowFor(`text.stroke.${i}.${f}`), { indent: true }))}
					</div>
				);
			})}
			<div className="flex h-[var(--pr-row-h)] items-center pl-2">
				<button
					type="button"
					className="text-pr-small text-pr-accent hover:underline disabled:text-pr-dim disabled:no-underline"
					disabled={max >= MAX_TEXT_STROKES}
					title="Adds a stroke to every selected text clip"
					onClick={() => setStyle('Add Stroke', { strokes: { add: [DEFAULT_TEXT_STROKE] } })}
					data-testid="text-stroke-add"
				>
					{max ? 'Add Stroke' : 'Add a Stroke'}
				</button>
			</div>
		</div>
	);
}

export const SHADOW_KEYS = [
	'text.shadow',
	'text.shadowColor',
	'text.shadowOpacity',
	'text.shadowAngle',
	'text.shadowDistance',
	'text.shadowBlur',
	'text.shadowSpread',
] as const;
