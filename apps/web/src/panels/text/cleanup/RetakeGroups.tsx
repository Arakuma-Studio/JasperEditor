// Clean Up retake groups (spec 14 TC-041): every line said several times, its takes side by side, the kept take ticked
// (by default the last complete one, or the one the script prefers); a click keeps another take and the plan follows.
import type { EditorSession } from '@jasper/session';
import { t } from '../../../i18n/runtime.ts';
import { type CleanupUiState, cleanupFor } from './controller.ts';
import { clockText } from './model.ts';

const S = 705_600_000;

export function RetakeGroups({ session, st }: { session: EditorSession; st: CleanupUiState }) {
	const c = cleanupFor(session);
	const a = st.analysis!;
	if (!a.groups.length)
		return (
			<p className="m-0 px-2 py-2 text-pr-small text-pr-muted" data-testid="text.cleanup.retakes.empty">
				No line was said more than once.
			</p>
		);
	return (
		<div className="min-h-0 flex-1 overflow-auto px-2 py-1" data-testid="text.cleanup.retakes">
			{a.groups.map((g, gi) => {
				const line = g.takes.find((x) => x.scriptLine !== undefined)?.scriptLine;
				const lineText = line !== undefined ? a.script?.find((l) => l.index === line)?.text : undefined;
				return (
					<section
						key={g.id}
						className="mb-2 rounded-pr-control border border-pr-border-subtle"
						aria-label={t('Retake group {0}', gi + 1)}
						data-testid={`text.cleanup.group.${g.id}`}
					>
						<header className="border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-[2px] text-pr-small text-pr-muted">
							{line !== undefined
								? t('Script line {0}: {1}', line + 1, lineText ?? '')
								: t('{0} takes of one line', g.takes.length)}
						</header>
						<div className="flex gap-1 overflow-x-auto p-1" role="radiogroup" aria-label={t('Take to keep')}>
							{g.takes.map((take, ti) => {
								const kept = g.chosen === ti;
								return (
									// biome-ignore lint/a11y/useSemanticElements: a take card is a radio of its group (it holds several lines of text)
									<button
										key={`${g.id}-${take.range.start}-${take.words[0]}`}
										type="button"
										role="radio"
										aria-checked={kept}
										className={`flex w-48 shrink-0 flex-col gap-[2px] rounded-pr-control border p-1 text-left text-pr-small ${kept ? 'border-pr-accent bg-pr-selected' : 'border-pr-border-subtle hover:bg-pr-hover'}`}
										onClick={() => c.chooseTake(g.id, ti)}
										title={kept ? t('Kept take') : t('Keep this take instead')}
										data-testid={`text.cleanup.group.${g.id}.take.${ti}`}
										data-kept={kept ? 'true' : undefined}
									>
										<span className="flex items-center gap-1 text-pr-muted">
											<span aria-hidden="true" className={kept ? 'text-pr-success' : ''}>
												{kept ? '✓' : '○'}
											</span>
											{t('Take {0}', ti + 1)} · {clockText(take.range.start / S)}
											{take.meanProb !== null ? ` · ${Math.round(take.meanProb * 100)} %` : ''}
										</span>
										<span className={`line-clamp-3 ${kept ? 'text-pr-text' : 'text-pr-muted line-through'}`}>
											{take.text}
										</span>
										<span className={take.complete ? 'text-pr-muted' : 'text-pr-warning'}>
											{take.complete ? t('Complete') : t('Cut off')}
											{take.coverage !== undefined
												? ` · ${t('{0} % of the line', Math.round(take.coverage * 100))}`
												: ''}
										</span>
									</button>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);
}
