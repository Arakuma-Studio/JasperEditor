// Spec 19 TL-102 / TL-056: the style lint as `title_check` rows. `lintAppearance` (`title-looks/lint.ts`) compares what the
// caller measured (`rendered`); this seam feeds it each measured frame and keeps the worst answer per issue. A build
// without the lint says so in an unverified row: a look that was not linted never reads as a clean one.

import type { Appearance, Clip, TitleCheckAt, TitleCheckRow } from '@jasper/project';
import * as project from '@jasper/project';

type Severity = 'error' | 'warning' | 'info';
type LintIssue = {
	id: string;
	severity: Severity;
	message: string;
	rule: string;
	measured?: number;
	expected?: string;
	fixable: boolean;
	fix?: { label: string; commands: unknown[] };
};
export type LintReport = { issues: LintIssue[]; unmeasured: readonly string[] };
export type LintFn = (a: Appearance, ctx: Record<string, unknown>) => LintReport;

/** The library's lint, resolved at run time so this file builds with or without it. */
const libraryLint = (project as unknown as { lintAppearance?: LintFn }).lintAppearance ?? null;

export type TitleLintInput = {
	appearance: Appearance;
	clip: Clip;
	effectInstanceId: string;
	at: TitleCheckAt;
	/** Write repairs as commands (off for a proposal: its clip has no id yet). */
	fixes: boolean;
	/** Content time of the frame judged (flicks). */
	time: number;
	sizePx: number | null;
	frameHeight: number;
	/** Mean L* just outside the title, per measured frame; empty until the renders are in. */
	backdrops: readonly number[];
};

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const STATUS: Record<Severity, TitleCheckRow['status']> = { error: 'fail', warning: 'warn', info: 'pass' };

export function titleLintRows(i: TitleLintInput, lint: LintFn | null = libraryLint): TitleCheckRow[] {
	if (!lint)
		return [
			{
				id: 'lint',
				kind: 'judgement',
				status: 'unverified',
				measured: null,
				expected: 'the TL-056 style lint',
				at: i.at,
				message: 'This build has no style lint, so the look was not linted.',
			},
		];
	const text = (i.clip as { content?: { text?: string } }).content?.text;
	const context = {
		...(i.fixes ? { effectInstanceId: i.effectInstanceId } : {}),
		time: i.time,
		clipKind: i.clip.kind,
		...(text !== undefined ? { text } : {}),
		...(i.sizePx !== null ? { sizePx: i.sizePx } : {}),
		frameHeight: i.frameHeight,
	};
	const reports = i.backdrops.length
		? i.backdrops.map((backdropL) =>
				lint(i.appearance, { ...context, rendered: { backdropL, frames: i.backdrops.length } }),
			)
		: [lint(i.appearance, context)];
	const worst = new Map<string, LintIssue>();
	for (const r of reports)
		for (const issue of r.issues) {
			const have = worst.get(issue.id);
			if (!have || RANK[issue.severity] < RANK[have.severity]) worst.set(issue.id, issue);
		}
	const rows: TitleCheckRow[] = [...worst.values()]
		.sort((a, b) => RANK[a.severity] - RANK[b.severity])
		.map((issue) => ({
			id: `lint-${issue.id}`,
			kind: issue.severity === 'error' ? 'format' : 'judgement',
			status: STATUS[issue.severity],
			measured: issue.measured ?? null,
			expected: issue.expected ?? issue.rule,
			at: i.at,
			message: issue.message,
			...(issue.fix
				? { fix: { label: issue.fix.label, commands: issue.fix.commands as Record<string, unknown>[] } }
				: issue.fixable
					? { fix: { label: 'A mechanical repair exists once the title is on the timeline.' } }
					: {}),
		}));
	for (const check of reports[0]?.unmeasured ?? [])
		rows.push({
			id: `lint-${check}`,
			kind: 'judgement',
			status: 'unverified',
			measured: null,
			expected: 'a measurement from rendered frames',
			at: i.at,
			message: `${check} needs the rendered frames, which are not in yet.`,
		});
	return rows;
}
