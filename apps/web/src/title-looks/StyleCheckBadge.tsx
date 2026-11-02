// Spec 19 TL-094: the badge in the Look header counts what the style check found; it opens the list in place, and a fix is
// one click and one undo step. Checks that need the rendered picture and were not measured are listed as such, never as
// passed.
import { useSessionState } from '@jasper/session/react';
import type { EditorSession } from '@jasper/session';
import { Button, cx, toast } from '@jasper/ui';
import { useMemo, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import type { LookedClip } from './selection.ts';
import { type StyleIssue, styleReport } from './style-check.ts';

const TONE: Record<StyleIssue['severity'], string> = {
	error: 'text-pr-danger',
	warning: 'text-pr-warning',
	info: 'text-pr-muted',
};

const UNMEASURED: Record<string, string> = {
	'backdrop-contrast': 'Contrast with the picture behind the title is not measured here.',
};

export function StyleCheckBadge(props: {
	session: EditorSession;
	looked: readonly LookedClip[];
	readOnly?: boolean;
}) {
	const { session, looked } = props;
	const seqId = useSessionState((s) => s.activeSequenceId);
	const seq = useSessionState((s) => (seqId ? s.document.sequences[seqId] : undefined));
	const [open, setOpen] = useState(false);
	const report = useMemo(() => (seq ? styleReport(looked, seq) : null), [looked, seq]);
	if (!report) return null;
	const counted = report.issues.filter((i) => i.severity !== 'info');
	const worst = report.issues[0]?.severity;
	const text =
		counted.length === 0
			? t('Style check')
			: counted.length === 1
				? t('1 issue')
				: t('{0} issues', counted.length);
	const fix = (i: StyleIssue) => {
		if (!i.fix) return;
		const r = session.apply({ label: t(i.fix.label), origin: 'user', commands: i.fix.commands });
		if (!r.ok)
			toast({ kind: 'error', title: t('The fix was refused'), detail: r.errors.map((e) => e.message).join('; ') });
	};
	return (
		<>
			<button
				type="button"
				aria-expanded={open}
				className={cx(
					'shrink-0 rounded-pr-pill border border-pr-border-subtle px-1.5 text-pr-small hover:border-pr-border-strong',
					counted.length ? TONE[worst ?? 'info'] : 'text-pr-muted',
				)}
				onClick={() => setOpen(!open)}
				data-testid="look-style-badge"
				data-count={counted.length}
			>
				{text}
			</button>
			{open ? (
				// The header's row wraps it below the name.
				<div className="order-last w-full basis-full py-1" data-testid="look-style-list">
					{report.issues.length === 0 ? (
						<p className="text-pr-small text-pr-muted">No issues with the look itself.</p>
					) : (
						<ul className="flex flex-col gap-1">
							{report.issues.map((i) => (
								<li key={i.id} className="flex items-start gap-1" data-issue={i.code} data-severity={i.severity}>
									<div className="min-w-0 flex-1">
										<p className={cx('text-pr-small', TONE[i.severity])}>{t(i.message)}</p>
										<p className="text-pr-small text-pr-dim">{t(i.rule)}</p>
									</div>
									{i.fix ? (
										<Button
											variant="quiet"
											disabled={props.readOnly}
											onClick={() => fix(i)}
											data-testid={`look-style-fix-${i.code}`}
										>
											{t(i.fix.label)}
										</Button>
									) : null}
								</li>
							))}
						</ul>
					)}
					{report.unmeasured.map((u) => (
						<p key={u} className="pt-1 text-pr-small text-pr-dim" data-testid={`look-style-unmeasured-${u}`}>
							{UNMEASURED[u] ? t(UNMEASURED[u]!) : u}
						</p>
					))}
				</div>
			) : null}
		</>
	);
}
