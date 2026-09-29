// Engine affinity per clip and per frame range (S01:SES-010, S02:TL-022, ARCHITECTURE §10.4).
import type { EngineId } from '../registry/kinds.ts';
import type { RenderSnapshot } from './snapshot.ts';

export type AffinityRange = { start: number; end: number; engines: EngineId[] };

export function engineAffinity(snapshot: RenderSnapshot): {
	clips: Record<string, EngineId>;
	ranges: AffinityRange[];
} {
	const clips: Record<string, EngineId> = {};
	const cuts = new Set<number>([snapshot.range.start, snapshot.range.end]);
	const all = snapshot.videoTracks.flatMap((t) => t.clips);
	for (const c of all) {
		clips[c.clipId] = c.engine;
		cuts.add(Math.max(snapshot.range.start, c.start));
		cuts.add(Math.min(snapshot.range.end, c.start + c.duration));
	}
	for (const a of snapshot.audioClips) clips[a.clipId] = 'native';
	const sorted = [...cuts].sort((a, b) => a - b);
	const ranges: AffinityRange[] = [];
	for (let i = 0; i + 1 < sorted.length; i++) {
		const start = sorted[i]!;
		const end = sorted[i + 1]!;
		if (end <= start) continue;
		const engines = new Set<EngineId>();
		for (const c of all) if (c.start < end && c.start + c.duration > start) engines.add(c.engine);
		const list = [...engines].sort();
		const prev = ranges[ranges.length - 1];
		if (prev && prev.end === start && prev.engines.join() === list.join()) prev.end = end;
		else ranges.push({ start, end, engines: list });
	}
	return { clips, ranges };
}
