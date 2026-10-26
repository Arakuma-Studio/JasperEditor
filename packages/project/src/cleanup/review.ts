// Reviewing a cleanup analysis (spec 14 TC-041…TC-043, TC-050): shared by the editor's Clean Up mode and the MCP tools
// so both apply exactly the same edit — which media a finding belongs to, where it plays in the sequence, which
// rejections Apply remembers (and forgets), and the Apply transaction itself (`cleanup.apply` over the plan's ranges
// plus `cleanup.configure` for the rejections: one undo step). Pure.
import type { Command } from '../commands/schemas/index.ts';
import type { Sequence } from '../schema/sequence.ts';
import { flicksPerFrame } from '../time.ts';
import type { CleanupFinding } from './schema.ts';
import { type CleanupAnalysis, type CleanupDecisions, type CleanupMediaReport, isAccepted } from './sequence.ts';

/** The fingerprint prefix of a media's findings (`findingFingerprint`: sanitised media id, `~`, stream, `~`). */
const mediaPrefix = (m: Pick<CleanupMediaReport, 'mediaId' | 'stream'>) =>
	`${m.mediaId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}~${m.stream}~`;

/** The media report a finding belongs to (findings are per media; the fingerprint names it), or null. */
export function cleanupFindingMedia(
	analysis: Pick<CleanupAnalysis, 'media'>,
	f: Pick<CleanupFinding, 'fingerprint'>,
): CleanupMediaReport | null {
	return analysis.media.find((m) => f.fingerprint.startsWith(mediaPrefix(m))) ?? null;
}

/**
 * Where a finding plays in the sequence: sequence frames `[start, end)` through the first speech clip of its media
 * that plays (part of) it, clamped to that clip; null when no clip of the analysis plays it.
 */
export function cleanupFindingFrames(
	seq: Pick<Sequence, 'clips' | 'settings'>,
	analysis: Pick<CleanupAnalysis, 'media'>,
	f: Pick<CleanupFinding, 'fingerprint' | 'range'>,
): { start: number; end: number; clipId: string } | null {
	const m = cleanupFindingMedia(analysis, f);
	if (!m) return null;
	const F = flicksPerFrame(seq.settings.frameRate);
	for (const id of m.clipIds) {
		const c = seq.clips[id];
		if (c?.kind !== 'audio') continue;
		const mediaEnd = c.sourceIn + c.duration * F;
		if (f.range.end <= c.sourceIn || f.range.start >= mediaEnd) continue;
		const a = Math.max(f.range.start, c.sourceIn);
		const b = Math.min(f.range.end, mediaEnd);
		const start = c.start + Math.floor((a - c.sourceIn) / F);
		const end = Math.max(start + 1, c.start + Math.ceil((b - c.sourceIn) / F));
		return { start, end, clipId: c.id };
	}
	return null;
}

/**
 * What Apply remembers in `Sequence.cleanup.rejected`: the fingerprints of findings rejected explicitly (by id /
 * fingerprint, or by kind without an item accept) that are not remembered yet; and what it forgets: remembered
 * fingerprints whose findings are accepted now.
 */
export function cleanupRejectionChanges(
	analysis: Pick<CleanupAnalysis, 'findings'>,
	d: CleanupDecisions,
	remembered: ReadonlySet<string>,
): { reject: string[]; unreject: string[] } {
	const reject = new Set<string>();
	const unreject = new Set<string>();
	const has = (list: readonly string[] | undefined, f: CleanupFinding) =>
		!!list && (list.includes(f.id) || list.includes(f.fingerprint));
	for (const f of analysis.findings) {
		const explicit = has(d.reject, f) || (!has(d.accept, f) && !!d.rejectKinds?.includes(f.kind));
		if (explicit && !remembered.has(f.fingerprint)) reject.add(f.fingerprint);
		if (remembered.has(f.fingerprint) && isAccepted(f, d, remembered)) unreject.add(f.fingerprint);
	}
	return { reject: [...reject], unreject: [...unreject] };
}

/**
 * The Apply transaction of an analysis (TC-031, TC-043): the rejections to remember / forget (`cleanup.configure`)
 * and the cuts (one `cleanup.apply` over `plan.ranges` with the plan's fade and J / L offset). Empty when there is
 * nothing to cut or remember.
 */
export function cleanupApplyCommands(
	sequenceId: string,
	analysis: Pick<CleanupAnalysis, 'findings' | 'plan'>,
	d: CleanupDecisions,
	remembered: ReadonlySet<string>,
	opts: { mode?: 'extract' | 'lift' | 'mute' | 'markers'; rememberRejections?: boolean } = {},
): Command[] {
	const plan = analysis.plan;
	const out: Command[] = [];
	if (opts.rememberRejections !== false) {
		const { reject, unreject } = cleanupRejectionChanges(analysis, d, remembered);
		if (reject.length || unreject.length)
			out.push({
				type: 'cleanup.configure',
				sequenceId,
				...(reject.length ? { reject } : {}),
				...(unreject.length ? { unreject } : {}),
			});
	}
	if (plan.ranges.length)
		out.push({
			type: 'cleanup.apply',
			sequenceId,
			clipIds: plan.clipIds,
			ranges: plan.ranges.map((r) => ({ start: r.start, end: r.end })),
			mode: opts.mode ?? 'extract',
			fadeMs: plan.fadeMs,
			jlFrames: (opts.mode ?? 'extract') === 'extract' ? plan.jlFrames : 0,
		});
	return out;
}
