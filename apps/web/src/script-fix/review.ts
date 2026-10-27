// Transcript fixes in the Review panel (spec 17 SC-082 … SC-084; docs/wp-notes/script-correction.md "Editor UI"):
// where a fix row sits on the timeline, ▶ of its source audio, per-group decisions, and the patch report after Apply
// ("142 fixes applied · 3 subtitles not updated: edited by hand", "Show skipped subtitles" selects them). The rows
// themselves are drawn by the Review panel with `FixRowLine` (FixRow.tsx); this module holds what the panel, the
// review actions and the Transcript tab share.
import type { EngineClient } from '@jasper/engine-client';
import type { ProjectDocument, Sequence } from '@jasper/project';
import type { EditorSession, ReviewItem } from '@jasper/session';
import { toast } from '@jasper/ui';
import { createStore } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import { mediaKeyOf } from '../import/assets.ts';
import {
	FIX_FEATURE,
	type FixPatchReport,
	fixFrame,
	fixMetaOf,
	patchReportOf,
	patchReportText,
} from './model.ts';
import { playSourceWindow, sourcePlayStore } from './source-audio.ts';

/** Whether a proposal feature is Fix Transcript's. */
export const isFixFeature = (feature: string | null | undefined) => feature === FIX_FEATURE;

/** The sequence frame of each fix row (null: not heard in the sequence), for `buildReviewModel`. */
export function fixFrameResolver(
	feature: string | null | undefined,
	seq: Sequence | undefined,
): ((item: Pick<ReviewItem, 'meta'>) => number | null) | undefined {
	if (!isFixFeature(feature) || !seq) return undefined;
	return (item) => {
		const m = fixMetaOf(item.meta);
		return m ? fixFrame(seq, m) : null;
	};
}

/** ▶ a fix: its source recording from 1 s before to 1 s after the fixed words. */
export function playFixItem(
	session: EditorSession,
	item: Pick<ReviewItem, 'id' | 'meta' | 'label'>,
): boolean {
	const m = fixMetaOf(item.meta);
	const doc = session.getCommitted() as ProjectDocument;
	const engine = session.engine as EngineClient | undefined;
	const fail = (why: string) => {
		toast({ kind: 'warning', title: t('Cannot play the fix'), detail: why, dedupeKey: 'fix-play' });
		return false;
	};
	if (!m) return fail(t('The item has no time in the recording'));
	const key = mediaKeyOf(doc.media[m.mediaId]);
	if (!key) return fail(t('The recording is not in the engine’s media store (offline or not imported)'));
	if (!engine || typeof engine.mediaUrl !== 'function') return fail(t('The engine is not connected'));
	const ok = playSourceWindow(item.id, engine.mediaUrl(key), m.start, m.end);
	if (!ok) return fail(sourcePlayStore.getState().error ?? t('Playback did not start'));
	return true;
}

// ── The patch report after Apply (SC-084) ───────────────────────────────────────────────────────────────────────

export type FixReportNotice = { proposalId: string; report: FixPatchReport; text: string; n: number };

/** The last Apply's report of each window (the Review panel shows it while that proposal is open). */
export const fixReportStore = createStore<{ notice: FixReportNotice | null }>(() => ({ notice: null }));

export function dismissFixReport(): void {
	fixReportStore.setState({ notice: null });
}

/**
 * After an Apply of a fix proposal: the report of its transaction, kept for the Review panel's notice, plus the toast
 * fields (title and the "Show skipped subtitles" action) the Apply toast uses.
 */
export function noteFixReport(
	session: EditorSession,
	proposalId: string,
	results: readonly unknown[],
	fixes: number,
): { title: string; action: { label: string; run(): void } | null } {
	const report = patchReportOf(results, fixes);
	const text = patchReportText(report);
	fixReportStore.setState((s) => ({ notice: { proposalId, report, text, n: (s.notice?.n ?? 0) + 1 } }));
	return {
		title: text,
		action: report.skipped.length
			? { label: t('Show skipped subtitles'), run: () => void showSkippedSubtitles(session, report) }
			: null,
	};
}

/**
 * Selects the subtitles a fix left unchanged (in their sequence, opening it when another is active). Skipped clips
 * of other sequences are named in a notice; clips deleted since are left out.
 */
export function showSkippedSubtitles(session: EditorSession, report: FixPatchReport): number {
	const doc = session.getCommitted() as ProjectDocument;
	const bySeq = new Map<string, string[]>();
	for (const s of report.skipped) {
		if (!doc.sequences[s.sequenceId]?.clips[s.clipId]) continue;
		const list = bySeq.get(s.sequenceId);
		if (list) list.push(s.clipId);
		else bySeq.set(s.sequenceId, [s.clipId]);
	}
	if (!bySeq.size) {
		toast({ kind: 'info', title: t('The skipped subtitles are no longer in the project') });
		return 0;
	}
	const active = session.getState().activeSequenceId;
	const target = active && bySeq.has(active) ? active : [...bySeq.keys()][0]!;
	if (target !== active) session.openSequence(target);
	const ids = bySeq.get(target)!;
	session.select('timeline', ids, 'replace', { primary: ids[0]!, linked: false });
	const others = [...bySeq.entries()].filter(([k]) => k !== target).reduce((n, [, v]) => n + v.length, 0);
	if (others)
		toast({
			kind: 'info',
			title: t('{0} more skipped subtitles are in other sequences', others),
		});
	return ids.length;
}
