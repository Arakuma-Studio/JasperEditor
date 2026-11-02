// Spec 19 TL-094: the style check of the selection: the library's `lintAppearance` (TL-056) on each looked clip, with what
// only the clip knows (its size and text). The check is read off the package namespace so this file builds on either
// side of the library's merge; a build without it shows no badge rather than a false all-clear.
import * as project from '@jasper/project';
import type { Appearance, Command, Sequence } from '@jasper/project';
import type { LookedClip } from './selection.ts';

export type StyleSeverity = 'error' | 'warning' | 'info';

export type StyleIssue = {
	id: string;
	code: string;
	severity: StyleSeverity;
	message: string;
	rule: string;
	layerIds: string[];
	fixable: boolean;
	fix?: { label: string; commands: Command[] };
};

export type StyleReport = { issues: StyleIssue[]; unmeasured: string[] };

type StyleContext = {
	effectInstanceId?: string;
	time?: number;
	clipKind?: string;
	text?: string;
	sizePx?: number;
	frameHeight?: number;
};

type Lint = (a: Appearance, ctx?: StyleContext) => StyleReport;

const lintOf = (): Lint | undefined => (project as unknown as { lintAppearance?: Lint }).lintAppearance;

export const styleCheckAvailable = (): boolean => !!lintOf();

const RANK: Record<StyleSeverity, number> = { error: 0, warning: 1, info: 2 };

/** One report across the selected clips. An issue on several clips is one line, and its fix reaches each of them. */
export function styleReport(looked: readonly LookedClip[], seq: Sequence): StyleReport | null {
	const lint = lintOf();
	if (!lint) return null;
	const byKey = new Map<string, StyleIssue>();
	const unmeasured = new Set<string>();
	for (const l of looked) {
		const text = l.clip.kind === 'text' ? l.clip : null;
		const r = lint(l.appearance, {
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
