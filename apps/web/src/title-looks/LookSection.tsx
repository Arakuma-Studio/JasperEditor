// Spec 19 TL-089: Properties ▸ Look: three tiers over one model. The header tunes a few things (colourway, Intensity, the
// look's quick controls); Appearance below opens the whole stack, and it stays away until there is a look to show.
import type { Clip } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button, cx, openDialog } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { PropertyRow, type RowContext } from '../panels/properties/controls/PropertyRow.tsx';
import { Section } from '../panels/properties/controls/Section.tsx';
import { AppearanceList } from './AppearanceList.tsx';
import { APPLY_LOOK_DIALOG } from './ApplyLookDialog.tsx';
import { setColorway } from './actions.ts';
import { colorwayFill } from './LookCard.tsx';
import { colorwaysFor, detachLook, removeLook, resetLook, saveLook } from './look-actions.ts';
import { colorwayPreviewCommands, endPreview, schedulePreview } from './preview.ts';
import { intensityRow, quickRows } from './rows.ts';
import { StyleCheckBadge } from './StyleCheckBadge.tsx';
import { lookSelection, overrideCount, sharedStack } from './selection.ts';

/** Words for how the selection relates to its look. */
function linkStatus(sel: ReturnType<typeof lookSelection>): string {
	const { looked, look, mixed } = sel;
	if (mixed) return t('Different looks');
	if (!look) return t('Not linked to a look');
	const changes = looked.reduce((n, l) => n + overrideCount(l.appearance), 0);
	if (changes === 0) return t('Matches the look');
	return changes === 1 ? t('1 change from the look') : t('{0} changes from the look', changes);
}

export function LookSections(props: {
	session: EditorSession;
	clips: readonly Clip[];
	ctx: RowContext;
	readOnly?: boolean;
}) {
	const { session, clips, ctx, readOnly } = props;
	const { doc, seq, frame } = ctx;
	const sel = lookSelection(doc, clips);
	useEffect(() => () => endPreview(session), [session]);
	const [status, setStatus] = useState<string | null>(null);
	const apply = () => void openDialog(APPLY_LOOK_DIALOG, { session });
	if (sel.capable.length === 0) return null;
	if (sel.looked.length === 0)
		return (
			<Section id="properties.look" title="Look">
				<div className="flex items-center gap-2 pr-1 pl-2" data-testid="look-none">
					<span className="min-w-0 flex-1 truncate text-pr-small text-pr-muted">No look on this clip</span>
					<Button variant="secondary" disabled={readOnly} onClick={apply} data-testid="look-apply">
						Apply Look…
					</Button>
				</div>
			</Section>
		);

	const ids = sel.looked.map((l) => l.clip.id);
	const linked = sel.looked.some((l) => l.appearance.lookId !== undefined);
	const anyOverride = sel.looked.some((l) => overrideCount(l.appearance) > 0);
	const intensity = intensityRow(doc, seq, sel.looked, frame, session.ctx.registries.effects);
	const stack = sharedStack(sel.looked);
	const quick = stack ? quickRows(doc, seq, stack, sel.look, frame) : [];
	const colorways = colorwaysFor(sel.look);
	const current = sel.looked.every((l) => l.appearance.colorwayId === sel.looked[0]!.appearance.colorwayId)
		? sel.looked[0]!.appearance.colorwayId
		: undefined;
	const name = sel.mixed ? t('Mixed') : (sel.look?.name ?? t('Custom look'));

	return (
		<>
			<Section id="properties.look" title="Look">
				<div data-testid="look-header">
					<div className="flex min-h-[var(--pr-row-h)] flex-wrap items-center gap-1 pr-1 pl-2">
						<span
							className="min-w-0 flex-1 truncate text-pr-ui text-pr-strong"
							data-testid="look-name"
							title={name}
						>
							{name}
						</span>
						<StyleCheckBadge session={session} looked={sel.looked} readOnly={readOnly} />
					</div>
					<p className="px-2 text-pr-small text-pr-muted" data-testid="look-status">
						{status ?? linkStatus(sel)}
					</p>
					{colorways.length ? (
						<fieldset
							className="flex flex-wrap items-center gap-[3px] px-2 py-1"
							aria-label="Colourways"
							data-testid="look-colorways-strip"
							onPointerLeave={() => {
								endPreview(session);
								setStatus(null);
							}}
						>
							{colorways.map((c) => (
								<button
									key={c.id}
									type="button"
									aria-label={c.name}
									title={c.name}
									aria-pressed={current === c.id}
									disabled={readOnly}
									className={cx(
										'size-[16px] shrink-0 rounded-pr-pill border',
										current === c.id ? 'border-pr-focus' : 'border-pr-border-strong',
									)}
									style={{ background: colorwayFill(c as never) }}
									onPointerEnter={() => {
										setStatus(c.name);
										schedulePreview(session, {
											label: c.name,
											commands: colorwayPreviewCommands(ids, c),
										});
									}}
									onClick={() => {
										endPreview(session);
										setColorway(session, ids, c);
									}}
									data-colorway={c.id}
								/>
							))}
						</fieldset>
					) : null}
					{intensity ? <PropertyRow row={intensity} ctx={ctx} /> : null}
					{quick.map((q) => (
						<PropertyRow key={q.row.id} row={q.row} ctx={ctx} />
					))}
					<div className="flex flex-wrap gap-1 px-2 py-1">
						<Button variant="quiet" disabled={readOnly} onClick={apply} data-testid="look-change">
							Change Look…
						</Button>
						<Button
							variant="quiet"
							disabled={readOnly || !linked || !anyOverride}
							disabledReason={linked ? 'The clip matches its look.' : 'The clip is not linked to a look.'}
							onClick={() => resetLook(session)}
							data-testid="look-reset"
						>
							Reset
						</Button>
						<Button
							variant="quiet"
							disabled={readOnly || !linked}
							disabledReason="The clip is not linked to a look."
							onClick={() => detachLook(session)}
							data-testid="look-detach"
						>
							Detach
						</Button>
						<Button
							variant="quiet"
							disabled={readOnly}
							onClick={() => void saveLook(session)}
							data-testid="look-save"
						>
							Save Look…
						</Button>
						<Button
							variant="quiet"
							disabled={readOnly}
							onClick={() => removeLook(session)}
							data-testid="look-remove"
						>
							Remove
						</Button>
					</div>
				</div>
			</Section>
			<Section id="properties.appearance" title="Appearance">
				<AppearanceList looked={sel.looked} ctx={ctx} readOnly={readOnly} />
			</Section>
		</>
	);
}
