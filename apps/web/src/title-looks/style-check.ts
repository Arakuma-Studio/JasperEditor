// Spec 19 TL-094: the style check of the selection: the library's `lintAppearance` (TL-056) on each looked clip, with what
// only the clip knows (its size and text).

import { type LintIssue, type LintReport, lintAppearance, type Sequence } from '@jasper/project';
import type { LookedClip } from './selection.ts';

export type StyleSeverity = LintIssue['severity'];
export type StyleIssue = LintIssue;
export type StyleReport = LintReport;

const RANK: Record<StyleSeverity, number> = { error: 0, warning: 1, info: 2 };

/** One report across the selected clips. An issue on several clips is one line, and its fix reaches each of them. */
export function styleReport(looked: readonly LookedClip[], seq: Sequence): StyleReport {
	const byKey = new Map<string, StyleIssue>();
	const unmeasured = new Set<StyleReport['unmeasured'][number]>();
	for (const l of looked) {
		const text = l.clip.kind === 'text' ? l.clip : null;
		const r = lintAppearance(l.appearance, {
			effectInstanceId: l.fx.id,
			clipKind: l.clip.kind,
			...(text ? { text: text.content.text, sizePx: text.content.style.sizePx } : {}),
			frameHeight: seq.settings.height,
		});
		for (const u of r.unmeasured) unmeasured.add(u);
		for (const i of r.issues) {
			const key = `${i.code}:${i.message}`;
			const hit = byKey.get(key);
			if (!hit) {
				byKey.set(key, i);
				continue;
			}
			if (hit.fix && i.fix)
				byKey.set(key, { ...hit, fix: { ...hit.fix, commands: [...hit.fix.commands, ...i.fix.commands] } });
		}
	}
	const issues = [...byKey.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
	return { issues, unmeasured: [...unmeasured] };
}
