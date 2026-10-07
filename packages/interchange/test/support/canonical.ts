// A canonical, id-free form of an interchange project for round-trip comparisons: media are named by path (or
// name), sequences by name, clips by track position; link ids become the sorted member list; keyframe ids go.
import type { IClip, IMedia, IProject, ISequence } from '../../src/model.ts';

export type CanonOptions = {
	/** Remove these clip fields before comparing (features the format does not carry). */
	dropClip?: readonly (keyof IClip)[];
	dropMedia?: readonly (keyof IMedia)[];
	dropSequence?: readonly (keyof ISequence)[];
	/** Remove empty tracks at the top of each list. */
	trimEmptyTracks?: boolean;
	/** Keep only the top sequence and the sequences it nests. */
	onlyTop?: boolean;
	/** Treat unity levels / centred pan / full opacity / zero gain as absent (formats write only changes). */
	dropDefaults?: boolean;
};

const stripKfIds = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(stripKfIds);
	if (v && typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (k === 'id' && 'interpolation' in (v as object)) continue;
			if (x === undefined) continue;
			// With keys, the static value is not used (the first key's value is).
			if (
				k === 'value' &&
				Array.isArray((v as { keyframes?: unknown }).keyframes) &&
				(v as { keyframes: unknown[] }).keyframes.length > 0
			)
				continue;
			o[k] = stripKfIds(x);
		}
		return o;
	}
	return v;
};

export function canonical(p: IProject, opts: CanonOptions = {}): unknown {
	const mediaKey = (id: string) => {
		const m = p.media[id];
		return m ? `media:${m.generator ? JSON.stringify(m.generator) : (m.path ?? m.name)}` : `missing:${id}`;
	};
	const seqKey = (id: string) => `seq:${p.sequences[id]?.name ?? id}`;
	const clipKey = new Map<string, string>();
	for (const s of Object.values(p.sequences))
		for (const kind of ['video', 'audio'] as const)
			for (const [ti, t] of s[kind].entries())
				for (const [ci, c] of t.clips.entries())
					clipKey.set(`${s.id}/${c.id}`, `${s.name}:${kind[0]}${ti + 1}:${ci}`);
	const used = new Set<string>();
	const seqs = opts.onlyTop ? reachable(p) : Object.keys(p.sequences);
	const out: Record<string, unknown> = {};
	for (const sid of seqs) {
		const s = p.sequences[sid];
		if (!s) continue;
		const links = new Map<string, string[]>();
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips)
				if (c.link) links.set(c.link, [...(links.get(c.link) ?? []), clipKey.get(`${s.id}/${c.id}`)!]);
		const tracks = (kind: 'video' | 'audio') => {
			const list = s[kind].map((t) => ({
				...t,
				clips: t.clips.map((c) => {
					const o: Record<string, unknown> = { ...c };
					delete o.id;
					if (c.source.type === 'media') {
						used.add(c.source.mediaId);
						o.source = mediaKey(c.source.mediaId);
					} else if (c.source.type === 'sequence') o.source = seqKey(c.source.sequenceId);
					if (c.link) o.link = [...(links.get(c.link) ?? [])].sort().join('+');
					if (!o.link) delete o.link;
					if (o.hold === null) delete o.hold;
					for (const k of opts.dropClip ?? []) delete o[k];
					if (opts.dropDefaults) {
						const isDef = (a: unknown, v: number) => {
							const x = a as { value?: unknown; keyframes?: unknown[] } | undefined;
							return !!x && x.value === v && !(x.keyframes ?? []).length;
						};
						if (isDef(o.volumeDb, 0)) delete o.volumeDb;
						if (isDef(o.pan, 0)) delete o.pan;
						if (isDef(o.opacity, 100)) delete o.opacity;
						if (o.gainDb === 0) delete o.gainDb;
						if (o.blendMode === 'normal') delete o.blendMode;
					}
					return stripKfIds(o);
				}),
				transitions: t.transitions.map((x) => {
					const o: Record<string, unknown> = { ...x };
					delete o.id;
					o.from = x.from ? (clipKey.get(`${s.id}/${x.from}`) ?? null) : null;
					o.to = x.to ? (clipKey.get(`${s.id}/${x.to}`) ?? null) : null;
					return stripKfIds(o);
				}),
			}));
			if (opts.trimEmptyTracks)
				while (
					list.length &&
					list[list.length - 1]!.clips.length === 0 &&
					list[list.length - 1]!.transitions.length === 0
				)
					list.pop();
			return list;
		};
		const so: Record<string, unknown> = { ...s, video: tracks('video'), audio: tracks('audio') };
		delete so.id;
		for (const k of opts.dropSequence ?? []) delete so[k];
		out[seqKey(sid)] = stripKfIds(so);
	}
	const media: Record<string, unknown> = {};
	for (const id of used) {
		const m = { ...p.media[id] } as Record<string, unknown>;
		delete m.id;
		for (const k of opts.dropMedia ?? []) delete m[k];
		media[mediaKey(id)] = stripKfIds(m);
	}
	return { sequences: out, media };
}

function reachable(p: IProject): string[] {
	const out: string[] = [];
	const visit = (id: string) => {
		if (out.includes(id)) return;
		const s = p.sequences[id];
		if (!s) return;
		out.push(id);
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) if (c.source.type === 'sequence') visit(c.source.sequenceId);
	};
	for (const t of p.top) visit(t);
	return out;
}
