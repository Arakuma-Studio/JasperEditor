// Spec 19 TL-052 in the Looks tab: the title templates of the chosen category (or of a search), each a card that inserts
// its clips at the playhead. A 3D template says what it costs on its card (TL-078): it never bakes and exports on the
// Remotion path; the browser asks once more before inserting one (`Cost3DDialog`).
import { COST_CLASSES, type TemplateKind } from '@jasper/project';
import { cx } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';
import type { TemplateEntry } from './library.ts';

const KIND_LABELS: Record<TemplateKind, string> = {
	'lower-third': 'Lower Third',
	'full-screen': 'Full Screen',
	'end-card': 'End Card',
	'social-hook': 'Social Hook',
};

export function TemplateList(props: {
	templates: readonly TemplateEntry[];
	/** No looks share the space: the list takes it all. */
	fill: boolean;
	/** Why nothing can be inserted, or null. */
	disabledReason: string | null;
	onInsert(entry: TemplateEntry): void;
}) {
	return (
		<section
			aria-label={t('Title templates')}
			className={cx(
				'flex min-h-0 flex-col gap-0.5 overflow-auto',
				props.fill ? 'flex-1' : 'max-h-[40%] shrink-0',
			)}
			data-testid="looks-templates"
		>
			<div className="text-pr-small font-semibold text-pr-muted">
				{t('Templates')} · {props.templates.length}
			</div>
			<ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1">
				{props.templates.map((e) => (
					<li key={e.templateId}>
						<button
							type="button"
							disabled={!!props.disabledReason}
							title={props.disabledReason ?? t('Insert {0} at the playhead', e.name)}
							className="flex h-full w-full flex-col items-start gap-0.5 rounded-pr-control border border-pr-border-subtle bg-pr-field p-1.5 text-left hover:border-pr-focus disabled:opacity-60"
							onClick={() => props.onInsert(e)}
							data-testid={`looks-template-${e.templateId}`}
							data-cost={e.cost}
						>
							<span className="flex w-full items-baseline gap-1">
								<span className="min-w-0 flex-1 truncate font-semibold text-pr-strong">{e.name}</span>
								<span className="shrink-0 text-pr-small text-pr-muted">{t(KIND_LABELS[e.kind])}</span>
							</span>
							<span className="text-pr-small text-pr-text">{t(e.description)}</span>
							{e.cost !== 'fast' ? (
								<span className="text-pr-small text-pr-warning" data-testid="looks-template-cost">
									{t(COST_CLASSES[e.cost].label)}: {t(COST_CLASSES[e.cost].detail)}
								</span>
							) : null}
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
