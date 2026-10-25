// Link Media ▸ Relink others automatically (docs/wp-notes/link-media.md §3): after one offline file is located, the
// folder relationship between its old and new paths says where the others moved. Pure planning — the engine checks
// the candidate files and verifies them.
import {
	formatPath,
	joinSegments,
	type ParsedPath,
	parsePath,
	pathBaseName,
	sameRoot,
	sameSegment,
} from './paths.ts';

/** A located file: its last known path (any operating system) and where it is now (a path of the engine host). */
export type RelinkAnchor = {
	from: string;
	to: string;
	/** The asset's project-relative path, when the project recorded one (Premiere `RelativePath`). */
	relativePath?: string | null;
};

/**
 * Old folder prefix → new folder prefix. Derived by aligning the old and new parent folders on their longest common
 * suffix: `D:\Media\Day 1\a.mov` → `/Volumes/Mac/Media/Day 1/a.mov` maps `D:\` to `/Volumes/Mac/`.
 */
export type PathMapping = { from: ParsedPath; to: ParsedPath; commonSuffix: number };

/** Where a project-relative path starts on the new drive: `ups` levels above the (unknown) project folder. */
export type RelativeBase = { base: ParsedPath; ups: number };

const isAbsoluteParsed = (p: ParsedPath) => p.style !== 'relative';

export function deriveMapping(oldPath: string, newPath: string): PathMapping | null {
	const o = parsePath(oldPath);
	const n = parsePath(newPath);
	if (!isAbsoluteParsed(o) || !isAbsoluteParsed(n) || !o.segments.length || !n.segments.length) return null;
	const od = o.segments.slice(0, -1);
	const nd = n.segments.slice(0, -1);
	let k = 0;
	while (k < od.length && k < nd.length && sameSegment(od[od.length - 1 - k]!, nd[nd.length - 1 - k]!)) k++;
	const from: ParsedPath = { style: o.style, root: o.root, segments: od.slice(0, od.length - k) };
	const to: ParsedPath = { style: n.style, root: n.root, segments: nd.slice(0, nd.length - k) };
	// Nothing moved: the mapping would only point back at the missing location.
	if (
		sameRoot(from, to) &&
		from.segments.length === to.segments.length &&
		from.segments.every((s, i) => sameSegment(s, to.segments[i]!))
	)
		return null;
	return { from, to, commonSuffix: k };
}

/** `oldPath` moved by `m`, or null when it is not under the mapping's old prefix. */
export function applyMapping(m: PathMapping, oldPath: string): string | null {
	const o = parsePath(oldPath);
	if (!sameRoot(o, m.from) || o.segments.length <= m.from.segments.length) return null;
	for (let i = 0; i < m.from.segments.length; i++)
		if (!sameSegment(o.segments[i]!, m.from.segments[i]!)) return null;
	return formatPath(joinSegments(m.to, o.segments.slice(m.from.segments.length)));
}

/** Leading `..` count and the rest of a relative path. */
function splitRelative(rel: string): { ups: number; tail: string[] } | null {
	const r = parsePath(rel);
	if (r.style !== 'relative') return null;
	let ups = 0;
	while (ups < r.segments.length && r.segments[ups] === '..') ups++;
	const tail = r.segments.slice(ups);
	return tail.length ? { ups, tail } : null;
}

/** The new location of the folder `ups` levels above the project folder, from a located file's relative path. */
export function deriveRelativeBase(relativePath: string, newPath: string): RelativeBase | null {
	const r = splitRelative(relativePath);
	const n = parsePath(newPath);
	if (!r || !isAbsoluteParsed(n) || n.segments.length < r.tail.length) return null;
	const off = n.segments.length - r.tail.length;
	for (let i = 0; i < r.tail.length; i++) if (!sameSegment(n.segments[off + i]!, r.tail[i]!)) return null;
	return { base: { style: n.style, root: n.root, segments: n.segments.slice(0, off) }, ups: r.ups };
}

/**
 * Another asset's relative path resolved from a relative base. Needs at least as many `..` as the located file's
 * path had (fewer would need the project folder's own name, which only the old absolute paths know — the mapping step
 * covers those).
 */
export function resolveRelative(b: RelativeBase, relativePath: string): string | null {
	const r = splitRelative(relativePath);
	if (!r || r.ups < b.ups) return null;
	const up = r.ups - b.ups;
	if (up > b.base.segments.length) return null;
	return formatPath({
		style: b.base.style,
		root: b.base.root,
		segments: [...b.base.segments.slice(0, b.base.segments.length - up), ...r.tail],
	});
}

/** The new folder of a located file. */
export function anchorFolder(a: RelinkAnchor): string | null {
	const n = parsePath(a.to);
	if (!isAbsoluteParsed(n) || !n.segments.length) return null;
	return formatPath({ ...n, segments: n.segments.slice(0, -1) });
}

export type RelinkPlanContext = {
	mappings: PathMapping[];
	relativeBases: RelativeBase[];
	/** New folders of the located files (same-name check, then the bounded search). */
	folders: string[];
};

/** Mappings (most specific old prefix first, later anchors first on ties), relative bases and folders, deduplicated. */
export function planContext(anchors: readonly RelinkAnchor[]): RelinkPlanContext {
	const mappings: PathMapping[] = [];
	const relativeBases: RelativeBase[] = [];
	const folders: string[] = [];
	const seen = new Set<string>();
	const key = (m: PathMapping) =>
		`${m.from.style}|${m.from.root}|${m.from.segments.join('/')}→${formatPath(m.to)}`.toLowerCase();
	for (let i = anchors.length - 1; i >= 0; i--) {
		const a = anchors[i]!;
		const m = deriveMapping(a.from, a.to);
		if (m && !seen.has(key(m))) {
			seen.add(key(m));
			mappings.push(m);
		}
		if (a.relativePath) {
			const b = deriveRelativeBase(a.relativePath, a.to);
			if (b && !relativeBases.some((x) => x.ups === b.ups && formatPath(x.base) === formatPath(b.base)))
				relativeBases.push(b);
		}
		const f = anchorFolder(a);
		if (f && !folders.includes(f)) folders.push(f);
	}
	mappings.sort((a, b) => b.from.segments.length - a.from.segments.length);
	return { mappings, relativeBases, folders };
}

export type RelinkStep = 'mapping' | 'relative' | 'same-folder' | 'search';

/** One offline asset to find: its last known path and its project-relative path (either may be missing). */
export type RelinkTargetPaths = { name: string; oldPath: string | null; relativePath: string | null };

export type PlannedStep =
	| { step: 'mapping' | 'relative'; paths: string[] }
	| { step: 'same-folder'; folders: string[]; name: string }
	| { step: 'search'; roots: string[]; name: string };

/**
 * Where to look for one asset, in order: the located file's folder mapping applied to its old path; its relative
 * path from the located file's project base; a file of the same name in a located file's folder; a bounded search
 * under those folders. Every candidate is verified; the first step with verified candidates decides.
 */
export function plannedSteps(t: RelinkTargetPaths, ctx: RelinkPlanContext): PlannedStep[] {
	const out: PlannedStep[] = [];
	const name = (t.oldPath && pathBaseName(t.oldPath)) || t.name;
	if (t.oldPath) {
		const paths = unique(ctx.mappings.map((m) => applyMapping(m, t.oldPath!)));
		if (paths.length) out.push({ step: 'mapping', paths });
	}
	if (t.relativePath) {
		const paths = unique(ctx.relativeBases.map((b) => resolveRelative(b, t.relativePath!)));
		if (paths.length) out.push({ step: 'relative', paths });
	}
	if (ctx.folders.length && name) {
		out.push({ step: 'same-folder', folders: [...ctx.folders], name });
		out.push({ step: 'search', roots: [...ctx.folders], name });
	}
	return out;
}

function unique(xs: (string | null)[]): string[] {
	const out: string[] = [];
	for (const x of xs) if (x && !out.includes(x)) out.push(x);
	return out;
}

/** A candidate file after verification. */
export type VerifiedCandidate = {
	path: string;
	/** Every selected match property holds. */
	ok: boolean;
	/** The same bytes as the asset (its fingerprint is known and equal). */
	sameContent: boolean;
};

export type CandidateDecision =
	| { kind: 'link'; path: string }
	| { kind: 'ambiguous'; paths: string[] }
	| { kind: 'none' };

/**
 * One step's decision: a single verified file links; several verified files are ambiguous — unless exactly one of
 * them has the asset's own bytes — and are reported, never guessed.
 */
export function decideCandidates(cands: readonly VerifiedCandidate[]): CandidateDecision {
	const ok = cands.filter((c) => c.ok);
	const paths = [...new Set(ok.map((c) => c.path))];
	if (paths.length === 1) return { kind: 'link', path: paths[0]! };
	if (paths.length === 0) return { kind: 'none' };
	const same = [...new Set(ok.filter((c) => c.sameContent).map((c) => c.path))];
	if (same.length === 1) return { kind: 'link', path: same[0]! };
	return { kind: 'ambiguous', paths };
}
