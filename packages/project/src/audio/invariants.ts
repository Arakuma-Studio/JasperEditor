// Invariants and load-time repairs of the audio-mix data (INV-MIX): submix tracks are audio-kind tracks without
// clips; outputs and sends name existing submixes without feedback (a submix only feeds a later submix); at most
// MAX_SENDS sends; lane keys are known; loudness settings are in range.
import { STRIP_LANES } from '../schema/audio.ts';
import type { Sequence, Track } from '../schema/sequence.ts';
import { MAX_SENDS } from './strip.ts';

export type MixIssue = { message: string; path: string[] };

/** Problems with the mixer data of one sequence (`where` = path prefix of the sequence). */
export function audioMixIssues(seq: Sequence, where: string[]): MixIssue[] {
	const out: MixIssue[] = [];
	const subs = (seq.submixTracks ?? []) as Track[];
	const subIndex = new Map(subs.map((t, i) => [t.id, i]));
	for (const t of subs) {
		if (t.kind !== 'audio')
			out.push({ message: `Submix ${t.id} has kind ${t.kind}`, path: [...where, 'submixTracks', t.id] });
		if (Object.values(seq.clips).some((c) => c.trackId === t.id))
			out.push({ message: `Submix ${t.id} holds clips`, path: [...where, 'submixTracks', t.id] });
	}
	const check = (t: Track, srcSub: number) => {
		const path = [...where, 'tracks', t.id, 'mixer'];
		const m = t.mixer;
		if (!m) return;
		const routeOk = (target: string) => {
			const ti = subIndex.get(target);
			return ti !== undefined && ti > srcSub;
		};
		if (m.output !== undefined && m.output !== null && !routeOk(m.output))
			out.push({ message: `Track ${t.id} outputs to ${m.output}, which is not a later submix`, path });
		const sends = m.sends ?? [];
		if (sends.length > MAX_SENDS)
			out.push({ message: `Track ${t.id} has more than ${MAX_SENDS} sends`, path });
		const ids = new Set<string>();
		for (const s of sends) {
			if (ids.has(s.id)) out.push({ message: `Duplicate send id ${s.id}`, path });
			ids.add(s.id);
			if (!routeOk(s.target))
				out.push({
					message: `Send ${s.id} of ${t.id} targets ${s.target}, which is not a later submix`,
					path,
				});
		}
		for (const k of Object.keys(m.lanes ?? {}))
			if (!(STRIP_LANES as readonly string[]).includes(k))
				out.push({ message: `Unknown mixer lane ${k} on ${t.id}`, path });
	};
	for (const t of seq.audioTracks) check(t, -1);
	subs.forEach((t, i) => {
		check(t, i);
	});
	return out;
}

/** Conservative repair: drops invalid outputs (→ the Mix), sends and lanes, and clips on submixes are kept out. */
export function repairAudioMix(
	seq: Sequence,
	note: (action: string, entity: string, detail: string) => void,
): void {
	const subs = (seq.submixTracks ?? []) as Track[];
	const subIndex = new Map(subs.map((t, i) => [t.id, i]));
	const fix = (t: Track, srcSub: number) => {
		const m = t.mixer;
		if (!m) return;
		const ok = (target: string) => {
			const ti = subIndex.get(target);
			return ti !== undefined && ti > srcSub;
		};
		if (m.output !== undefined && m.output !== null && !ok(m.output)) {
			delete m.output;
			note('reroute', t.id, 'output pointed to a missing or earlier submix; routed to the Mix');
		}
		if (m.sends) {
			const seen = new Set<string>();
			const kept = m.sends.filter((s) => {
				const good = ok(s.target) && !seen.has(s.id);
				seen.add(s.id);
				return good;
			});
			if (kept.length !== m.sends.length)
				note('drop-send', t.id, 'removed sends to missing or earlier submixes');
			m.sends = kept.slice(0, MAX_SENDS);
		}
		if (m.lanes)
			for (const k of Object.keys(m.lanes))
				if (!(STRIP_LANES as readonly string[]).includes(k)) {
					delete m.lanes[k];
					note('drop-lane', t.id, `removed unknown mixer lane ${k}`);
				}
	};
	for (const t of seq.audioTracks) fix(t, -1);
	subs.forEach((t, i) => {
		if (t.kind !== 'audio') (t as { kind: string }).kind = 'audio';
		fix(t, i);
	});
}
