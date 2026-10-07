// Small builders of interchange projects for hand-written tests (FilmCraft's test support, adapted).
import type { Keyframe } from '@jasper/project';
import type {
	IClip,
	IMarker,
	IMedia,
	IProject,
	ISequence,
	ITrack,
	ITransition,
	Rate,
} from '../../src/model.ts';
import { framesToFlicks } from '../../src/time.ts';

export function project(name = 'p'): IProject {
	return { name, root: [], media: {}, sequences: {}, top: [] };
}

let n = 0;
export function media(
	p: IProject,
	path: string,
	video: boolean,
	audio: boolean,
	rate: Rate,
	seconds = 600,
): string {
	const id = `m${++n}`;
	const m: IMedia = {
		id,
		name: path.split('/').pop()!,
		kind: video ? 'video' : 'audio',
		path,
		duration: seconds * 705_600_000,
		...(video ? { video: { width: 1920, height: 1080, rate } } : {}),
		...(audio ? { audio: { sampleRate: 48000, channels: 2 } } : {}),
		markers: [],
	};
	p.media[id] = m;
	p.root.push({ type: 'media', id });
	return id;
}

export function generator(p: IProject, name: string, g: IMedia['generator']): string {
	const id = `g${++n}`;
	p.media[id] = {
		id,
		name,
		kind: 'generator',
		path: null,
		duration: null,
		video: { width: 1920, height: 1080, rate: { num: 25, den: 1 } },
		generator: g!,
		markers: [],
	};
	return id;
}

export function sequence(p: IProject, name: string, rate: Rate, dropFrame = false): string {
	const id = `s${++n}`;
	const s: ISequence = {
		id,
		name,
		rate,
		dropFrame,
		width: 1920,
		height: 1080,
		sampleRate: 48000,
		startTimecode: 0,
		video: [],
		audio: [],
		markers: [],
	};
	p.sequences[id] = s;
	p.root.push({ type: 'sequence', id });
	p.top.push(id);
	return id;
}

export const track = (): ITrack => ({ name: null, enabled: true, locked: false, clips: [], transitions: [] });

export function clip(
	p: IProject,
	sid: string,
	kind: 'video' | 'audio',
	t: number,
	mediaId: string,
	start: number,
	len: number,
	srcIn: number,
): IClip {
	const s = p.sequences[sid]!;
	while (s[kind].length <= t) s[kind].push(track());
	const F = framesToFlicks(1, s.rate);
	const c: IClip = {
		id: `c${++n}`,
		name: p.media[mediaId]?.name ?? 'Clip',
		start: start * F,
		duration: len * F,
		sourceIn: srcIn * F,
		speed: 1,
		reverse: false,
		enabled: true,
		source: { type: 'media', mediaId },
		markers: [],
		effects: [],
	};
	s[kind][t]!.clips.push(c);
	s[kind][t]!.clips.sort((a, b) => a.start - b.start);
	return c;
}

export function transition(
	p: IProject,
	sid: string,
	kind: 'video' | 'audio',
	t: number,
	effectId: string,
	from: IClip | null,
	to: IClip | null,
	start: number,
	len: number,
	alignment: ITransition['alignment'],
): void {
	const s = p.sequences[sid]!;
	const F = framesToFlicks(1, s.rate);
	s[kind][t]!.transitions.push({
		id: `t${++n}`,
		effectId,
		from: from?.id ?? null,
		to: to?.id ?? null,
		start: start * F,
		duration: len * F,
		alignment,
		params: {},
	});
}

export function link(...clips: IClip[]): void {
	const l = `l${++n}`;
	for (const c of clips) c.link = l;
}

export function key(
	time: number,
	value: number,
	interpolation: Keyframe<number>['interpolation'] = 'linear',
): Keyframe<number> {
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation,
		easeIn: { influence: 1 / 3, slope: 1 },
		easeOut: { influence: 1 / 3, slope: 1 },
	};
}

export function marker(
	start: number,
	duration: number,
	name: string,
	comment: string,
	color: IMarker['color'],
): IMarker {
	return { start, duration, name, comment, color };
}

/** Per track: clip [start, duration, sourceIn, media path] and transitions [start, duration, effect, from?, to?, alignment] (frames). */
export function structure(p: IProject, sid: string, kind: 'video' | 'audio') {
	const s = p.sequences[sid]!;
	const F = framesToFlicks(1, s.rate);
	return s[kind]
		.map((t) => ({
			clips: t.clips.map((c) => [
				c.start / F,
				c.duration / F,
				c.sourceIn / F,
				c.source.type === 'media' ? p.media[c.source.mediaId]!.path : c.source.type,
			]),
			transitions: t.transitions.map((x) => [
				x.start / F,
				x.duration / F,
				x.effectId,
				!!x.from,
				!!x.to,
				x.alignment,
			]),
		}))
		.filter((t) => t.clips.length || t.transitions.length);
}

export function links(p: IProject, sid: string): string[][] {
	const s = p.sequences[sid]!;
	const by = new Map<string, string[]>();
	for (const [ti, t] of [...s.video, ...s.audio].entries())
		for (const [ci, c] of t.clips.entries())
			if (c.link) by.set(c.link, [...(by.get(c.link) ?? []), `${ti}:${ci}`]);
	return [...by.values()].map((v) => v.sort()).sort((a, b) => a.join().localeCompare(b.join()));
}
