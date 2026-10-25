// Why a review item is stale or invalid, in the user's language (spec 12 §2.7 Review "stale handling"; Phase 3
// verification): the model's structured `StaleProblem` (what moved where, which requirement, what failed) said with
// timecodes and the cue kind's own label, never an entity id. Without a structured problem (a reason the engine
// stored), the English reason is translated when it matches a model template, else shown as it is.
import type { Sequence, StaleProblem } from '@jasper/project';
import type { ReviewItem } from '@jasper/session';
import { t, translateName, withoutContext } from '../i18n/runtime.ts';
import { CUE_KIND_LABELS } from '../sound/cues/model.ts';
import { seqTimecode } from '../sound/design-model.ts';

/** The problem of a stale / invalid item as one sentence (null when it has none). */
export function problemText(
	item: Pick<ReviewItem, 'state' | 'reason' | 'problem'>,
	seq: Pick<Sequence, 'settings'> | undefined,
): string | null {
	if (item.state !== 'stale' && item.state !== 'invalid') return null;
	if (item.problem) return describeProblem(item.problem, seq);
	if (item.reason) return translateName(item.reason) ?? item.reason;
	return item.state === 'stale' ? t('Changed since it was proposed') : t('Does not apply');
}

/** A stale problem as one sentence ("Cut cue at 00:00:03:00 moved to 00:00:03:10"). */
export function describeProblem(p: StaleProblem, seq: Pick<Sequence, 'settings'> | undefined): string {
	const tc = (f: number | undefined) => (f === undefined ? '' : seq ? seqTimecode(seq, f) : String(f));
	if (p.type === 'requires')
		return p.state === 'invalid'
			? t('Needs “{0}”, which does not apply', p.label)
			: t('Needs “{0}”, which changed since it was proposed', p.label);
	if (p.type === 'conflict') {
		const issue = translateName(p.issue) ?? p.issue;
		return issue ? t('Does not apply any more: {0}', issue) : t('Does not apply any more');
	}
	const at = p.at !== undefined;
	if (p.entity === 'cue') {
		// the kind's own label (looked up explicitly: the sentence is built here, not by the label transform)
		const label = p.cueKind ? (CUE_KIND_LABELS as Record<string, string>)[p.cueKind] : undefined;
		const kind = label ? withoutContext(t(label)) : (p.cueKind ?? null);
		if (p.change === 'deleted')
			return kind && at
				? t('{0} cue at {1} was deleted', kind, tc(p.at))
				: at
					? t('Cue at {0} was deleted', tc(p.at))
					: t('Its cue was deleted');
		if (p.change === 'frame' && p.to !== undefined && at)
			return kind
				? t('{0} cue at {1} moved to {2}', kind, tc(p.at), tc(p.to))
				: t('Cue at {0} moved to {1}', tc(p.at), tc(p.to));
		return kind && at ? t('{0} cue at {1} changed', kind, tc(p.at)) : t('Its cue changed');
	}
	if (p.entity === 'cut') {
		// spec 15 EA-003: a decoration anchored on a cut (its two clips no longer meet where they did)
		if (p.change === 'frame' && p.to !== undefined && at)
			return t('Cut at {0} moved to {1}', tc(p.at), tc(p.to));
		if (p.change === 'deleted') return at ? t('Cut at {0} is gone', tc(p.at)) : t('Its cut is gone');
		return at ? t('Cut at {0} is between other clips now', tc(p.at)) : t('Its cut changed');
	}
	if (p.entity === 'marker') {
		if (p.change === 'deleted')
			return p.name && at
				? t('Marker “{0}” at {1} was deleted', p.name, tc(p.at))
				: at
					? t('Marker at {0} was deleted', tc(p.at))
					: t('Its marker was deleted');
		if (p.change === 'frame' && p.to !== undefined && at)
			return p.name
				? t('Marker “{0}” at {1} moved to {2}', p.name, tc(p.at), tc(p.to))
				: t('Marker at {0} moved to {1}', tc(p.at), tc(p.to));
		return t('Its marker changed');
	}
	if (p.entity === 'clip') {
		const name = p.name ?? t('Clip');
		if (p.change === 'deleted')
			return at ? t('Clip at {0} was deleted', tc(p.at)) : t('A clip it uses was deleted');
		if (!at) return t('A clip it uses changed');
		if (p.change === 'track') return t('“{0}” at {1} moved to another track', name, tc(p.at));
		if (p.change === 'start' && p.to !== undefined)
			return t('“{0}” at {1} moved to {2}', name, tc(p.at), tc(p.to));
		if (p.change === 'length') return t('“{0}” at {1} was trimmed', name, tc(p.at));
		return t('“{0}” at {1} was trimmed or retimed', name, tc(p.at));
	}
	const gone = p.change === 'deleted';
	switch (p.entity) {
		case 'transition':
			return gone ? t('A transition it uses was deleted') : t('A transition it uses changed');
		case 'track':
			return gone ? t('A track it uses was deleted') : t('A track it uses changed');
		case 'media':
			return gone ? t('A media file it uses was deleted') : t('A media file it uses changed');
		case 'item':
			return gone ? t('A project item it uses was deleted') : t('A project item it uses changed');
		case 'sequence':
			return gone ? t('Its sequence was deleted') : t('Its sequence changed');
		default:
			return gone ? t('Something it uses was deleted') : t('Something it uses changed');
	}
}
