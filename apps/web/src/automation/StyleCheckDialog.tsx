// Sequence ▸ Automate ▸ Style Check (spec 15 EA-013, EA-040): the sequence against a recipe's targets (default the
// project's active recipe) — cuts per minute, cuts with a kit, punch-ins per minute and their start, Ken Burns share,
// dead air (measured by the engine with the voice analyses already made), subtitles starting on speech cuts and
// crossing none, music level — each with its value, target and status; a deviation lists "look here" timecodes that
// move the playhead there. Check Again measures the current edit. Read-only: nothing in the project changes.
import type { StyleCheckMetricDto, StyleCheckResponse } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { Button, Dialog, type HostedDialogProps, registerDialog, Select } from '@jasper/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogClose } from '../extensions/dialog.ts';
import { t, translateName } from '../i18n/runtime.ts';
import { Row } from './fields.tsx';
import { runStyleCheck, type StyleEngine } from './style-run.ts';
import { defaultRecipeId, recipeChoices, useStyleLibrary } from './style-store.ts';

export const STYLE_CHECK_DIALOG = 'automation.styleCheck';

let registered = false;
export function registerStyleCheckDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(STYLE_CHECK_DIALOG, StyleCheckDialog);
}

const name = (s: string) => translateName(s) ?? s;

const STATUS: Record<StyleCheckMetricDto['status'], { text: string; mark: string; tone: string }> = {
	ok: { text: 'On target', mark: '✓', tone: 'text-pr-text' },
	off: { text: 'Off target', mark: '!', tone: 'text-pr-warning' },
	unmeasured: { text: 'Not measured', mark: '–', tone: 'text-pr-muted' },
	unchecked: { text: 'No target', mark: '·', tone: 'text-pr-dim' },
};

/** "17.9 /min", "95 %", "−33 dB"… */
export function formatValue(m: Pick<StyleCheckMetricDto, 'unit'>, v: number | null | undefined): string {
	if (v === null || v === undefined) return '—';
	if (m.unit === 'share' || m.unit === 'fraction') return `${Math.round(v * 100)} %`;
	if (m.unit === 'per-minute') return t('{0} /min', Math.round(v * 10) / 10);
	if (m.unit === 'seconds-per-minute') return t('{0} s/min', Math.round(v * 100) / 100);
	return t('{0} dB', Math.round(v * 10) / 10);
}

export function formatTarget(m: StyleCheckMetricDto): string {
	const tg = m.target;
	if (!tg) return '—';
	if (m.id === 'subtitleOnCut') return t('≥ {0}, {1} crossing', formatValue(m, tg.min), tg.max ?? 0);
	if (tg.max !== undefined && tg.value === undefined) return t('≤ {0}', formatValue(m, tg.max));
	if (tg.value !== undefined) {
		const tol = tg.tolerance ?? 0;
		const tolText =
			m.unit === 'share' || m.unit === 'fraction'
				? `${Math.round(tol * 100)} %`
				: String(Math.round(tol * 10) / 10);
		return `${formatValue(m, tg.value)} ± ${tolText}`;
	}
	return '—';
}

export type StyleCheckDialogProps = {
	session: EditorSession;
	engine: StyleEngine;
	sequenceId: string;
	recipeId?: string;
};

export function StyleCheckDialog(props: HostedDialogProps<StyleCheckDialogProps>) {
	const { open, finish } = useDialogClose(props.close);
	const { session, sequenceId, engine } = props;
	const doc = useStoreSelector(session.store, (s) => s.document);
	const seq = doc.sequences[sequenceId];
	const lib = useStyleLibrary();
	const choices = useMemo(() => recipeChoices(doc, lib), [doc, lib]);
	const vertical = !!seq && seq.settings.height > seq.settings.width;
	const [recipeId, setRecipeId] = useState(() => props.recipeId ?? defaultRecipeId(doc, vertical));
	const [result, setResult] = useState<StyleCheckResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const abort = useRef<AbortController | null>(null);

	const check = useCallback(async () => {
		abort.current?.abort();
		const ac = new AbortController();
		abort.current = ac;
		setBusy(true);
		setError(null);
		try {
			const r = await runStyleCheck(engine, session.projectId, { sequenceId, recipeId }, ac.signal);
			if (!ac.signal.aborted) setResult(r);
		} catch (e) {
			if (!ac.signal.aborted) {
				setResult(null);
				setError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			if (!ac.signal.aborted) setBusy(false);
		}
	}, [engine, session.projectId, sequenceId, recipeId]);
	useEffect(() => {
		void check();
	}, [check]);
	useEffect(() => () => abort.current?.abort(), []);

	const seek = (frame: number) => session.transport.seek(frame);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					abort.current?.abort();
					finish();
				}
			}}
			title={t('Style Check')}
			size="medium"
			primaryLabel={t('Close')}
			onPrimary={() => true}
			data-testid="style-check-dialog"
		>
			{seq ? (
				<div className="flex flex-col gap-3 text-pr-ui">
					<p className="text-pr-small text-pr-muted">
						{t('Compares the sequence with the recipe’s targets. Click a timecode to look there.')}
					</p>
					<Row label={t('Recipe')} testId="style-check-recipe">
						<Select
							label={t('Recipe')}
							value={recipeId}
							onValueChange={setRecipeId}
							options={choices.map((c) => ({ value: c.id, label: name(c.name), disabled: !c.recipe }))}
						/>
						<Button
							variant="quiet"
							disabled={busy}
							onClick={() => void check()}
							data-testid="style-check-again"
						>
							{busy ? t('Checking…') : t('Check Again')}
						</Button>
					</Row>
					{error ? (
						<span className="text-pr-small text-pr-warning" data-testid="style-check-error">
							{error}
						</span>
					) : null}
					{result ? (
						<>
							<span className="text-pr-small text-pr-text" data-testid="style-check-counts">
								{t(
									'{0} on target · {1} off · {2} not measured',
									result.counts.ok,
									result.counts.off,
									result.counts.unmeasured,
								)}
							</span>
							<ul className="flex flex-col gap-2" data-testid="style-check-metrics">
								{result.metrics
									.filter((m) => m.status !== 'unchecked')
									.map((m) => {
										const st = STATUS[m.status];
										return (
											<li
												key={m.id}
												className="flex flex-col gap-0.5"
												data-testid={`style-check-${m.id}`}
												data-status={m.status}
											>
												<span className={`flex gap-2 text-pr-small ${st.tone}`}>
													<span className="w-[14px] shrink-0 text-center" aria-hidden="true">
														{st.mark}
													</span>
													<span className="w-[180px] shrink-0">{name(m.label)}</span>
													<span className="w-[90px] shrink-0 pr-tabular">{formatValue(m, m.value)}</span>
													<span className="text-pr-muted">
														{t('Target')} {formatTarget(m)}
													</span>
													<span className="sr-only">{t(st.text)}</span>
												</span>
												<span className="pl-[22px] text-pr-small text-pr-muted">{m.message}</span>
												{m.lookHere.length ? (
													<span
														className="flex flex-wrap gap-1 pl-[22px]"
														data-testid={`style-check-look-${m.id}`}
													>
														{m.lookHere.slice(0, 12).map((l) => (
															<Button
																key={`${l.frame}-${l.note}`}
																variant="quiet"
																title={l.note}
																onClick={() => seek(l.frame)}
																data-testid="style-check-look"
															>
																{l.timecode}
															</Button>
														))}
														{m.lookHere.length > 12 ? (
															<span className="text-pr-small text-pr-dim">
																{t('+{0} more', m.lookHere.length - 12)}
															</span>
														) : null}
													</span>
												) : null}
											</li>
										);
									})}
							</ul>
							{result.warnings.map((w) => (
								<span key={w.code + w.message} className="text-pr-small text-pr-muted">
									{w.message}
								</span>
							))}
						</>
					) : busy ? (
						<span className="text-pr-small text-pr-muted">{t('Checking…')}</span>
					) : null}
				</div>
			) : (
				<p className="text-pr-small text-pr-muted">{t('Open a sequence first')}</p>
			)}
		</Dialog>
	);
}
