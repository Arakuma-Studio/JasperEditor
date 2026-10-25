// spec 13 AS-032: Properties ▸ Text Style — the project text style the selected text clips are linked to ("Mixed" when
// they differ), apply / detach / reset to style / redefine from a clip, New Style from Selection…, and the project's
// styles with their usage counts (select clips, rename, delete). Edits of a style reach every linked clip in one step.
import type { Clip, ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button } from '@jasper/ui';
import { useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { MiniButton, SelectField } from '../panels/properties/controls/fields.tsx';
import { CaretGlyph, TrashGlyph } from '../panels/properties/controls/glyphs.tsx';
import {
	applyStyle,
	deleteStyle,
	detachSelection,
	newStyleFromSelection,
	redefineStyle,
	renameStyle,
	resetSelection,
	selectStyleClips,
} from './actions.ts';
import { isTextClip, STYLE_FIELD_LABELS, selectionLink, styleRows } from './model.ts';

const clipsText = (n: number) => (n === 1 ? t('1 clip') : t('{0} clips', n));

export function TextStyleSection(props: {
	session: EditorSession;
	doc: ProjectDocument;
	clips: readonly Clip[];
	primary: Clip | null;
	readOnly?: boolean;
}) {
	const { session, doc, clips } = props;
	const [listOpen, setListOpen] = useState(false);
	const text = clips.filter(isTextClip);
	if (!text.length) return null;
	const link = selectionLink(doc, text);
	const rows = styleRows(doc);
	const primary = props.primary && isTextClip(props.primary) ? props.primary : text[text.length - 1]!;
	const primaryDeviates = link.style ? link.fields.has(primary.id) : false;
	const disabled = props.readOnly;
	const rowCls = 'flex min-h-[var(--pr-row-h)] items-center gap-2 pr-1 pl-2';
	const value = link.mixed ? null : (link.style?.id ?? '');
	return (
		<div data-testid="text-style-section">
			<div className={rowCls}>
				<span className="w-[34%] shrink-0 text-pr-ui text-pr-muted">Style</span>
				<SelectField
					value={value}
					options={['', ...rows.map((r) => r.style.id)]}
					labels={[t('None'), ...rows.map((r) => r.style.name)]}
					label="Text style"
					disabled={disabled}
					className="min-w-0 flex-1"
					onChange={(id) => (id ? applyStyle(session, id, text) : detachSelection(session))}
					data-testid="text-style-select"
				/>
			</div>
			{link.linked.length ? (
				<p className="px-2 pb-1 text-pr-small text-pr-muted" data-testid="text-style-status">
					{link.deviating.length
						? t(
								'{0} differ from the style: {1}',
								clipsText(link.deviating.length),
								[...new Set([...link.fields.values()].flat())]
									.slice(0, 4)
									.map((f) => STYLE_FIELD_LABELS[f] ?? f)
									.join(', '),
							)
						: link.linked.length === text.length
							? 'Matches the style'
							: t('{0} of {1} linked', link.linked.length, text.length)}
				</p>
			) : null}
			<div className="flex flex-wrap gap-1 px-2 pb-1">
				<Button
					variant="secondary"
					disabled={disabled}
					onClick={() => void newStyleFromSelection(session)}
					data-testid="text-style-new"
				>
					New Style from Selection…
				</Button>
				{link.linked.length ? (
					<>
						<Button
							variant="quiet"
							disabled={disabled || !link.deviating.length}
							disabledReason={link.deviating.length ? undefined : 'The clips match their style.'}
							onClick={() => resetSelection(session)}
							data-testid="text-style-reset"
						>
							Reset to Style
						</Button>
						<Button
							variant="quiet"
							disabled={disabled}
							onClick={() => detachSelection(session)}
							data-testid="text-style-detach"
						>
							Detach
						</Button>
					</>
				) : null}
				{link.style ? (
					<Button
						variant="quiet"
						disabled={disabled || !primaryDeviates}
						disabledReason={
							primaryDeviates ? undefined : 'Change this clip first; the style then takes its look.'
						}
						onClick={() => redefineStyle(session, link.style!.id, primary)}
						data-testid="text-style-redefine"
					>
						Update Style from Clip
					</Button>
				) : null}
			</div>
			{rows.length ? (
				<div className="pb-1">
					<button
						type="button"
						className="flex h-[var(--pr-row-h)] w-full items-center gap-1 pl-2 text-left text-pr-ui text-pr-muted hover:text-pr-text"
						aria-expanded={listOpen}
						onClick={() => setListOpen(!listOpen)}
						data-testid="text-style-list-toggle"
					>
						<CaretGlyph open={listOpen} size={10} />
						{t('Project Text Styles ({0})', rows.length)}
					</button>
					{listOpen ? (
						<ul className="flex flex-col" data-testid="text-style-list">
							{rows.map((r) => (
								<li key={r.style.id} className="flex h-[var(--pr-row-h)] items-center gap-1 pr-1 pl-5">
									<span className="min-w-0 flex-1 truncate text-pr-ui text-pr-text" title={r.style.name}>
										{r.style.name}
									</span>
									<button
										type="button"
										className="shrink-0 text-pr-small text-pr-muted hover:text-pr-text"
										title="Select the clips of the active sequence linked to this style"
										onClick={() => selectStyleClips(session, r.style.id)}
										data-testid={`text-style-uses-${r.style.id}`}
									>
										{clipsText(r.uses)}
									</button>
									<Button
										variant="quiet"
										disabled={disabled}
										onClick={() => void renameStyle(session, r.style.id)}
										data-testid={`text-style-rename-${r.style.id}`}
									>
										Rename…
									</Button>
									<MiniButton
										label={`Delete text style ${r.style.name}`}
										disabled={disabled}
										onClick={() => void deleteStyle(session, r.style.id)}
										data-testid={`text-style-delete-${r.style.id}`}
									>
										<TrashGlyph size={12} />
									</MiniButton>
								</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</div>
	);
}
