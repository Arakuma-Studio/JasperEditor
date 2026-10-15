// Merging, scoring and density budgets of derived cues (spec 12 §2.2).
// - Cues within 2 frames merge: the primary is the heavier one (hero > support > ambient; then explicit, confidence,
//   size, earlier frame, key); the others' anchors go to `also` and their reasons are appended. Two members of the
//   same pattern group never merge with each other.
// - Score = confidence × weight × size × novelty (weights 1 / 0.7 / 0.4; size factor 0.5 + 0.5·√area; novelty
//   1 / (1 + 0.5·n) with n earlier cues of the same kind and first type within 2 s).
// - Budgets per density, applied greedily from the best score: minimum confidence, heroes (≤ 1 per 3 / 2 / 1.5 s,
//   a hero too close becomes a support cue; never two within 0.5 s), ≤ 1 / 2 / 3 cues in any 1 s window, the
//   caller's minimum gap and maximum count. A pattern group is one unit (its span counts once in a window).
//   Explicit `sfx:` marker cues skip the minimum confidence, rate and gap budgets (not the count).
import type { SoundWeight } from '../taxonomy.ts';
import type { CueCandidate, CueDensity, CueDeriveSource, DeriveCuesStats, DerivedCue } from './types.ts';

export const MERGE_FRAMES = 2;
export const DENSITY_BUDGETS: Readonly<
	Record<CueDensity, { heroEverySec: number; perSec: number; minConfidence: number }>
> = Object.freeze({
	sparse: { heroEverySec: 3, perSec: 1, minConfidence: 0.4 },
	balanced: { heroEverySec: 2, perSec: 2, minConfidence: 0.3 },
	rich: { heroEverySec: 1.5, perSec: 3, minConfidence: 0.15 },
});
/** No two heroes ever closer than this (seconds), whatever the density. */
export const HERO_MIN_SEC = 0.5;
export const WEIGHT_FACTOR: Readonly<Record<SoundWeight, number>> = { hero: 1, support: 0.7, ambient: 0.4 };
const WEIGHT_RANK: Readonly<Record<SoundWeight, number>> = { hero: 2, support: 1, ambient: 0 };
const NOVELTY_SEC = 2;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Primary of a merge: heavier first. */
function better(a: CueCandidate, b: CueCandidate): boolean {
	const d =
		WEIGHT_RANK[b.weight] - WEIGHT_RANK[a.weight] ||
		Number(!!b.explicit) - Number(!!a.explicit) ||
		b.confidence - a.confidence ||
		b.size - a.size ||
		a.frame - b.frame ||
		cmpStr(a.key, b.key);
	return d < 0;
}

/** Merges candidates within MERGE_FRAMES; `merged[source]` counts the absorbed ones. */
export function mergeCandidates(
	list: readonly CueCandidate[],
	onMerged: (from: CueDeriveSource) => void,
): CueCandidate[] {
	const sorted = [...list].sort((a, b) => a.frame - b.frame || cmpStr(a.key, b.key));
	const used = new Uint8Array(sorted.length);
	const out: CueCandidate[] = [];
	for (let i = 0; i < sorted.length; i++) {
		if (used[i]) continue;
		used[i] = 1;
		const cluster = [sorted[i]!];
		const groups = new Set<string>();
		if (sorted[i]!.group) groups.add(sorted[i]!.group!);
		for (let j = i + 1; j < sorted.length && sorted[j]!.frame - sorted[i]!.frame <= MERGE_FRAMES; j++) {
			const c = sorted[j]!;
			if (used[j] || (c.group && groups.has(c.group))) continue;
			used[j] = 1;
			cluster.push(c);
			if (c.group) groups.add(c.group);
		}
		if (cluster.length === 1) {
			out.push(cluster[0]!);
			continue;
		}
		let primary = cluster[0]!;
		for (const c of cluster) if (better(c, primary)) primary = c;
		const others = cluster.filter((c) => c !== primary);
		for (const o of others) onMerged(o.from);
		const reasons = others.slice(0, 3).map((o) => o.reason);
		out.push({
			...primary,
			confidence: Math.max(...cluster.map((c) => c.confidence)),
			size: Math.max(...cluster.map((c) => c.size)),
			also: [...(primary.also ?? []), ...others.flatMap((o) => [o.anchor, ...(o.also ?? [])])],
			reason: `${primary.reason}; also ${reasons.join('; ')}${others.length > 3 ? ` (+${others.length - 3} more)` : ''}`,
			explicit: cluster.some((c) => c.explicit),
		});
	}
	return out;
}

type Unit = {
	members: CueCandidate[];
	a: number;
	b: number;
	score: number;
	weight: SoundWeight;
	confidence: number;
	explicit: boolean;
	key: string;
	from: CueDeriveSource;
};

/** Scores (with novelty) and groups merged candidates into budget units (a pattern group = one unit). */
function units(list: readonly CueCandidate[], fps: number): Unit[] {
	const sorted = [...list].sort((a, b) => a.frame - b.frame || cmpStr(a.key, b.key));
	const window = NOVELTY_SEC * fps;
	const novelty = new Map<CueCandidate, number>();
	const seenGroups = new Map<string, number>();
	const recent: CueCandidate[] = [];
	for (const c of sorted) {
		if (c.group && seenGroups.has(c.group)) {
			novelty.set(c, seenGroups.get(c.group)!);
			continue;
		}
		while (recent.length && c.frame - recent[0]!.frame > window) recent.shift();
		const same = recent.filter(
			(r) =>
				r.kind === c.kind && (r.types[0] ?? '') === (c.types[0] ?? '') && (!c.group || r.group !== c.group),
		).length;
		const n = 1 / (1 + 0.5 * same);
		novelty.set(c, n);
		if (c.group) seenGroups.set(c.group, n);
		recent.push(c);
	}
	const byGroup = new Map<string, CueCandidate[]>();
	const out: Unit[] = [];
	for (const c of sorted) {
		if (c.group) {
			const g = byGroup.get(c.group);
			if (g) g.push(c);
			else byGroup.set(c.group, [c]);
		} else out.push(unitOf([c]));
	}
	for (const g of byGroup.values()) out.push(unitOf(g));
	return out;

	function unitOf(members: CueCandidate[]): Unit {
		let score = 0;
		let weight: SoundWeight = 'ambient';
		let confidence = 0;
		for (const m of members) {
			const s =
				m.confidence *
				WEIGHT_FACTOR[m.weight] *
				(0.5 + 0.5 * Math.sqrt(Math.min(1, Math.max(0, m.size)))) *
				novelty.get(m)!;
			score = Math.max(score, s);
			if (WEIGHT_RANK[m.weight] > WEIGHT_RANK[weight]) weight = m.weight;
			confidence = Math.max(confidence, m.confidence);
		}
		const first = members[0]!;
		return {
			members,
			a: first.frame,
			b: members[members.length - 1]!.frame,
			score,
			weight,
			confidence,
			explicit: members.some((m) => !!m.explicit),
			key: first.group ?? first.key,
			from: first.from,
		};
	}
}

/** Applies the density budget; returns the kept cues sorted by frame then key. */
export function applyBudgets(
	list: readonly CueCandidate[],
	o: { fps: number; density: CueDensity; minGapFrames: number; maxCues: number },
	stats: DeriveCuesStats,
): DerivedCue[] {
	const budget = DENSITY_BUDGETS[o.density];
	const W = Math.max(1, Math.round(o.fps));
	const heroGap = Math.max(Math.round(budget.heroEverySec * o.fps), Math.round(HERO_MIN_SEC * o.fps));
	const all = units(list, o.fps).sort((x, y) => y.score - x.score || x.a - y.a || cmpStr(x.key, y.key));
	const accepted: Unit[] = [];
	const heroes: number[] = [];
	let count = 0;
	const drop = (u: Unit, rule: 'rate' | 'gap' | 'maxCues' | 'confidence') => {
		stats.dropped[rule] += u.members.length;
		for (const m of u.members) stats.bySource[m.from].droppedByBudget++;
	};
	for (const u of all) {
		if (!u.explicit && u.confidence < budget.minConfidence) {
			drop(u, 'confidence');
			continue;
		}
		if (!u.explicit) {
			if (
				o.minGapFrames > 0 &&
				accepted.some((x) => x.a - u.b < o.minGapFrames && u.a - x.b < o.minGapFrames)
			) {
				drop(u, 'gap');
				continue;
			}
			if (windowCount(accepted, u, W) + 1 > budget.perSec) {
				drop(u, 'rate');
				continue;
			}
		}
		if (count + u.members.length > o.maxCues) {
			drop(u, 'maxCues');
			continue;
		}
		if (u.weight === 'hero') {
			const heroFrames = u.members.filter((m) => m.weight === 'hero').map((m) => m.frame);
			const clash = heroFrames.some((f) => heroes.some((h) => Math.abs(h - f) < heroGap));
			if (clash) {
				for (const m of u.members)
					if (m.weight === 'hero') {
						m.weight = 'support';
						stats.heroesDemoted++;
					}
				u.weight = 'support';
			} else heroes.push(...heroFrames);
		}
		accepted.push(u);
		count += u.members.length;
	}
	const kept: DerivedCue[] = [];
	for (const u of accepted)
		for (const m of u.members) {
			const { size: _size, explicit: _explicit, ...cue } = m;
			kept.push({ ...cue, score: round4(u.score) });
		}
	kept.sort((x, y) => x.frame - y.frame || cmpStr(x.key, y.key));
	return kept;
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Most accepted units intersecting one `W`-frame window that also intersects `u`. */
function windowCount(accepted: readonly Unit[], u: Unit, W: number): number {
	const near = accepted.filter((x) => x.a <= u.b + W - 1 && x.b >= u.a - W + 1);
	if (!near.length) return 0;
	const starts = new Set<number>([u.a - W + 1]);
	for (const x of near) {
		const s = x.a - W + 1;
		if (s >= u.a - W + 1 && s <= u.b) starts.add(s);
		if (x.b + 1 >= u.a - W + 1 && x.b + 1 <= u.b) starts.add(x.b + 1);
	}
	let best = 0;
	for (const s of starts) {
		const e = s + W - 1;
		let n = 0;
		for (const x of near) if (x.a <= e && x.b >= s) n++;
		if (n > best) best = n;
	}
	return best;
}
