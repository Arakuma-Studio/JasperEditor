// Final Cut Pro 7 XML interchange (`xmeml` versions 4 and 5), the dialect Premiere Pro imports and exports
// (File ▸ Export ▸ Final Cut Pro XML) and DaVinci Resolve reads and writes.
//
// Read and written: `project`/`bin`/`children`/master `clip` structure (bins mirror the JasperEditor project),
// video and audio `track`s (enabled, locked), `clipitem` (start/end/in/out frames plus `pproTicksIn/Out` for
// tick-exact source times, enabled, labels, markers, links, `sourcetrack` channels), `file` (pathurl, rate,
// duration, timecode, media characteristics, definitions and references by id), nested sequences (inline or by
// id), `generatoritem`s (Slug/Black Video, Color, Bars and Tone, Transparent Video, Counting Leader),
// `transitionitem`s (alignment, Premiere transition names), and the filters Basic Motion (scale, rotation,
// center, anchor point), Opacity, Crop, Time Remap (constant speed, reverse, freeze), Audio Levels and Audio Pan,
// all with keyframes; `compositemode` blend modes. Other effects are written with their JasperEditor id and read
// back by id or by display name; anything unknown is reported.
//
// Coordinates (FilmCraft's reading of the xmeml description): Basic Motion `center` is relative to the frame
// centre as a fraction of the frame width/height (0,0 = centred); `centerOffset` (anchor) likewise relative to
// the source. Keyframe `when` values and clip markers are source frames (like `in`/`out`) at the clip's rate.
//
// Port of FilmCraft `crates/interchange/src/fcp7.rs` (MIT OR Apache-2.0), extended (bins and master clips on
// export, crop, ticks above 2^53, blend modes, generators, channel mapping, hold filters).
import {
	type Animatable,
	CUSTOM_FADE,
	clampFadeValue,
	type EffectInstance,
	type Interpolation,
	type Keyframe,
	type LabelColor,
	type Transform,
	type Vec2,
} from '@jasper/project';
import { blendFromFcp7, fcp7BlendName } from './blend.ts';
import {
	anim,
	Builder,
	dbToGain,
	describeClip,
	frameOf,
	gainToDb,
	labelFrom,
	labelName,
	type MulticamInfo,
	multicamHiddenTracks,
	multicamOf,
	newClip,
	sequenceDuration,
	sourceOut,
	unscaled,
} from './build.ts';
import { effectSpecOf, knownTransition, transitionFromName, transitionLabel } from './effects.ts';
import type {
	IBinEntry,
	IClip,
	IGenerator,
	IMarker,
	IMedia,
	IMulticamAngle,
	IProject,
	ISequence,
	ITrack,
	ITransition,
	Rate,
} from './model.ts';
import type { ExportOptions, ImportOptions } from './options.ts';
import { fileName, isAbsolutePath, kindFromExtension, pathToFileUrl, resolvePath } from './paths.ts';
import { premiereAudioTransition, premiereFadeShapeOf, premiereShapeType } from './premiere-audio-fades.ts';
import { InterchangeError, parseError, type Report } from './report.ts';
import {
	flicksPerFrame,
	flicksToFrames,
	flicksToTicks,
	formatTc,
	framesToFlicks,
	onFrame,
	parseTc,
	rateFromTimebase,
	ticksToFlicks,
	timebaseOf,
} from './time.ts';
import {
	boolStr,
	child,
	childBool,
	childInt,
	childNum,
	children,
	childText,
	descendants,
	elements,
	num,
	parseXml,
	pathText,
	XmlError,
	XmlWriter,
	type XNode,
	path as xmlPath,
} from './xml.ts';

const FORMAT = 'Final Cut Pro XML';
const MAX_NEST = 64;

export function sniffFcp7(head: string): boolean {
	return /<xmeml[\s>]/.test(head);
}

function readRate(n: XNode | null): Rate | null {
	const r = child(n, 'rate');
	const tb = childNum(r, 'timebase');
	if (!tb || tb <= 0) return null;
	return rateFromTimebase(tb, childBool(r, 'ntsc') ?? false);
}

function writeRate(w: XmlWriter, rate: Rate): void {
	const { timebase, ntsc } = timebaseOf(rate);
	w.open('rate').text('timebase', timebase).text('ntsc', boolStr(ntsc)).close();
}

function kf<T>(time: number, value: T, interpolation: Keyframe<T>['interpolation']): Keyframe<T> {
	return {
		id: `kf${time}`,
		time,
		value,
		interpolation,
		easeIn: { influence: 1 / 3, slope: interpolation === 'bezier' ? 0 : 1 },
		easeOut: { influence: 1 / 3, slope: interpolation === 'bezier' ? 0 : 1 },
	};
}

const GENERATORS: { kind: IGenerator['kind']; names: string[]; write: [string, string] }[] = [
	{ kind: 'black', names: ['slug', 'black video', 'black'], write: ['Slug', 'slug'] },
	{ kind: 'color', names: ['color', 'color matte', 'colour matte', 'matte'], write: ['Color', 'Color'] },
	{ kind: 'transparent', names: ['transparent video'], write: ['Transparent Video', 'transparentvideo'] },
	{
		kind: 'counting-leader',
		names: ['counting leader', 'universal counting leader'],
		write: ['Universal Counting Leader', 'countingleader'],
	},
	{
		kind: 'bars-and-tone',
		names: ['bars and tone', 'bars', 'smpte bars'],
		write: ['Bars and Tone', 'barsandtone'],
	},
];

function generatorFrom(name: string, id: string, report: Report): IGenerator {
	if (id.startsWith('jasper:')) {
		try {
			const g = JSON.parse(id.slice(7)) as IGenerator;
			if (g && typeof g.kind === 'string' && GENERATORS.some((x) => x.kind === g.kind)) return g;
		} catch {
			// fall through to the name
		}
	}
	const n = name.trim().toLowerCase();
	const ni = id.trim().toLowerCase();
	for (const g of GENERATORS)
		if (
			g.names.some((x) => n === x || n.startsWith(`${x} (`) || ni === x || ni === g.write[1].toLowerCase())
		) {
			switch (g.kind) {
				case 'color':
					return { kind: 'color', color: [0, 0, 0, 1] };
				case 'bars-and-tone':
					return { kind: 'bars-and-tone', toneHz: 1000, toneDb: -20 };
				default:
					return { kind: g.kind } as IGenerator;
			}
		}
	report.warn(`generator "${name}" is not supported; imported as Black Video`, {
		subject: { kind: 'media', name },
		instead: 'Black Video',
	});
	return { kind: 'black' };
}

function readColor(v: XNode): [number, number, number, number] {
	const c = (n: string, d: number) => Math.min(1, Math.max(0, (childNum(v, n) ?? d) / 255));
	return [c('red', 0), c('green', 0), c('blue', 0), c('alpha', 255)];
}

function writeColor(w: XmlWriter, c: readonly number[]): void {
	const b = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	w.open('value')
		.text('alpha', b(c[3] ?? 1))
		.text('red', b(c[0] ?? 0))
		.text('green', b(c[1] ?? 0))
		.text('blue', b(c[2] ?? 0))
		.close();
}

const nodeKey = (n: XNode, ids: Map<XNode, number>) => n.attrs.id ?? `#node${ids.get(n) ?? 0}`;

export function importFcp7(text: string, opts: ImportOptions, report: Report): IProject {
	let root: XNode;
	try {
		root = parseXml(text);
	} catch (e) {
		if (e instanceof XmlError) throw parseError(FORMAT, e.message);
		throw e;
	}
	if (root.name !== 'xmeml') throw parseError(FORMAT, 'the root element is not <xmeml>');
	const projectName =
		descendants(root)
			.filter((n) => n.name === 'project')
			.map((p) => childText(p, 'name'))
			.find((x) => !!x) ??
		opts.name ??
		'Imported XML';
	const imp = new Fcp7Importer(new Builder(projectName), opts, report, root);
	imp.walk(root, imp.b.p.root, true, 0);
	imp.resolveLinks();
	const p = imp.b.finish();
	if (!Object.keys(p.sequences).length && !Object.keys(p.media).length)
		throw new InterchangeError('EMPTY', 'the Final Cut Pro XML document contains no sequence or clip');
	return p;
}

type PendingLink = { seq: string; clip: string; refs: string[] };

class Fcp7Importer {
	readonly files = new Map<string, XNode>();
	readonly seqDefs = new Map<string, XNode>();
	readonly fileItems = new Map<string, string>();
	readonly seqItems = new Map<string, string>();
	readonly inProgress = new Set<string>();
	readonly links: PendingLink[] = [];
	readonly xmlClipIds = new Map<string, string>();
	readonly ids = new Map<XNode, number>();
	readonly multiclipDefs = new Map<string, XNode>();
	readonly multiclipSeqs = new Map<string, { sid: string; angles: string[] }>();

	constructor(
		readonly b: Builder,
		readonly opts: ImportOptions,
		readonly report: Report,
		root: XNode,
	) {
		let k = 0;
		for (const n of descendants(root)) {
			this.ids.set(n, k++);
			if (n.name === 'file' && elements(n).length && !this.files.has(this.key(n)))
				this.files.set(this.key(n), n);
			if (n.name === 'sequence' && child(n, 'media') && !this.seqDefs.has(this.key(n)))
				this.seqDefs.set(this.key(n), n);
			if (n.name === 'multiclip' && child(n, 'angle') && !this.multiclipDefs.has(this.key(n)))
				this.multiclipDefs.set(this.key(n), n);
		}
	}

	key(n: XNode): string {
		return nodeKey(n, this.ids);
	}

	/** `xmeml`, `project`, `bin` and `children` containers. */
	walk(n: XNode, bin: IBinEntry[], top: boolean, depth: number): void {
		if (depth > MAX_NEST) return;
		for (const c of elements(n)) {
			switch (c.name) {
				case 'project':
					this.walk(child(c, 'children') ?? c, bin, top, depth + 1);
					break;
				case 'children':
					this.walk(c, bin, top, depth + 1);
					break;
				case 'bin': {
					const label = labelFrom(pathText(c, ['labels', 'label2']));
					const b = this.b.bin(childText(c, 'name') || 'Bin', bin, label ?? undefined);
					this.walk(child(c, 'children') ?? c, b, top, depth + 1);
					break;
				}
				case 'sequence': {
					const id = this.sequence(c, bin, 0);
					if (id && top && !this.b.p.top.includes(id)) this.b.p.top.push(id);
					break;
				}
				case 'clip':
					this.masterClip(c, bin);
					break;
			}
		}
	}

	masterClip(n: XNode, bin: IBinEntry[]): void {
		const file = descendants(n).find((d) => d.name === 'file');
		if (file) {
			const id = this.file(file, childText(n, 'name'), bin);
			if (!id) return;
			const m = this.b.p.media[id]!;
			const label = labelFrom(pathText(n, ['labels', 'label2']));
			if (label) m.label = label;
			const rate = readRate(n) ?? m.video?.rate ?? { num: 24, den: 1 };
			if (!m.markers.length) m.markers = readMarkers(n, rate);
			return;
		}
		const s = descendants(n).find((d) => d.name === 'sequence');
		if (s) this.sequence(s, bin, 0);
	}

	/** The media of a `<file>` (definition or reference by id). */
	file(n: XNode, fallbackName: string | null, bin: IBinEntry[] | null): string | null {
		const key = this.key(n);
		const known = this.fileItems.get(key);
		if (known) return known;
		const def = elements(n).length ? n : this.files.get(key);
		if (!def) return null;
		const name = childText(def, 'name') || fallbackName || 'Untitled';
		const rate = readRate(def) ?? { num: 24, den: 1 };
		const media = child(def, 'media');
		const video = child(media, 'video');
		const audio = child(media, 'audio');
		const vsc = child(video, 'samplecharacteristics') ?? video;
		const asc = child(audio, 'samplecharacteristics') ?? audio;
		const pathUrl = childText(def, 'pathurl') || null;
		const tcNode = child(def, 'timecode');
		const tcRate = readRate(tcNode) ?? rate;
		const tcString = childText(tcNode, 'string');
		const tcFrame =
			childInt(tcNode, 'frame') ??
			(tcString
				? parseTc(tcString, tcRate, (childText(tcNode, 'displayformat') ?? '').toUpperCase() === 'DF')
				: null);
		const init = {
			name,
			duration: (() => {
				const d = childInt(def, 'duration');
				return d && d > 0 ? framesToFlicks(d, rate) : null;
			})(),
			...(video
				? {
						video: {
							width: childInt(vsc, 'width') ?? 1920,
							height: childInt(vsc, 'height') ?? 1080,
							rate: readRate(vsc) ?? rate,
							...(childText(vsc, 'alpha') && childText(vsc, 'alpha') !== 'none' ? { alpha: true } : {}),
						},
					}
				: {}),
			...(audio
				? {
						audio: {
							sampleRate: childInt(asc, 'samplerate') ?? 48000,
							channels: childInt(audio, 'channelcount') ?? 2,
							...(childInt(asc, 'depth') ? { bitDepth: childInt(asc, 'depth')! } : {}),
						},
					}
				: {}),
			...(tcFrame !== null && tcFrame >= 0
				? {
						timecode: {
							frames: tcFrame,
							rate: tcRate,
							dropFrame: (childText(tcNode, 'displayformat') ?? '').toUpperCase() === 'DF',
						},
					}
				: {}),
			reel: pathText(tcNode, ['reel', 'name']) || null,
			sizeBytes: null,
		};
		let kind: IMedia['kind'] | undefined;
		if (!video && !audio) {
			const k = kindFromExtension(pathUrl ?? name);
			kind = k;
			if (k === 'audio') Object.assign(init, { audio: { sampleRate: 48000, channels: 2 } });
			else Object.assign(init, { video: { width: 1920, height: 1080, rate } });
		} else if (video && !audio) kind = kindFromExtension(pathUrl ?? name) === 'image' ? 'image' : 'video';
		else if (!video) kind = 'audio';
		let id: string;
		if (pathUrl) {
			const isUrl = /^(https?|s3|gs):/i.test(pathUrl);
			const path = isUrl ? null : resolvePath(pathUrl, this.opts.baseDir);
			id = this.b.media(`file:${path ?? pathUrl}`, { ...init, kind, path, url: isUrl ? pathUrl : null }, bin);
		} else {
			this.report.warn(`file "${name}" has no pathurl; imported offline`, {
				subject: { kind: 'media', name },
				instead: 'an offline media item',
			});
			id = this.b.media(`fileid:${key}`, { ...init, kind, path: null, offline: true }, bin);
		}
		this.fileItems.set(key, id);
		return id;
	}

	/** The sequence of a `<sequence>` (definition or reference). */
	sequence(n: XNode, bin: IBinEntry[] | null, depth: number): string | null {
		const key = this.key(n);
		const known = this.seqItems.get(key);
		if (known) return known;
		const def = child(n, 'media') ? n : this.seqDefs.get(key);
		if (!def) return null;
		if (this.inProgress.has(key) || depth > MAX_NEST) {
			this.report.warn('a recursive nested sequence was ignored');
			return null;
		}
		this.inProgress.add(key);
		const rate = readRate(def) ?? { num: 24, den: 1 };
		const tc = child(def, 'timecode');
		const vfmt = xmlPath(def, ['media', 'video', 'format', 'samplecharacteristics']);
		const afmt = xmlPath(def, ['media', 'audio', 'format', 'samplecharacteristics']);
		const label = labelFrom(pathText(def, ['labels', 'label2']));
		const seq = this.b.sequence(
			{
				name: childText(def, 'name') || 'Sequence',
				rate,
				dropFrame: (childText(tc, 'displayformat') ?? '').toUpperCase() === 'DF',
				width: childInt(vfmt, 'width') ?? 1920,
				height: childInt(vfmt, 'height') ?? 1080,
				sampleRate: childInt(afmt, 'samplerate') ?? 48000,
				startTimecode: Math.max(0, childInt(tc, 'frame') ?? 0),
				...(label ? { label } : {}),
				markers: readMarkers(def, rate),
			},
			{ bin },
		);
		this.seqItems.set(key, seq.id);
		const inPt = childInt(def, 'in');
		const outPt = childInt(def, 'out');
		if (inPt !== null && inPt >= 0) seq.inPoint = framesToFlicks(inPt, rate);
		if (outPt !== null && outPt > 0) seq.outPoint = framesToFlicks(outPt, rate);
		const media = child(def, 'media');
		const frame = { width: seq.width, height: seq.height };
		for (const kind of ['video', 'audio'] as const) {
			const m = child(media, kind);
			children(m, 'track').forEach((tn, ti) => {
				this.b.ensureTracks(seq, kind, ti + 1);
				this.track(seq, kind, ti, tn, rate, frame, depth);
			});
		}
		this.b.ensureTracks(seq, 'video', 1);
		this.b.ensureTracks(seq, 'audio', 1);
		this.inProgress.delete(key);
		return seq.id;
	}

	/**
	 * The multi-camera source sequence of a `<multiclip>` (definition or reference by id): one video track per angle
	 * with picture and one audio track per angle with sound, each holding the angle's clip so that the angles' In
	 * points meet at time 0 (synctype 1; `start`/`end` of an angle clip place it explicitly).
	 */
	multiclip(n: XNode, seqRate: Rate): { sid: string; angles: string[] } | null {
		const key = this.key(n);
		const known = this.multiclipSeqs.get(key);
		if (known) return known;
		const def = this.multiclipDefs.get(key);
		if (!def) {
			this.report.warn('a multiclip the document does not define was skipped');
			return null;
		}
		const angleNodes = children(def, 'angle');
		type Cam = {
			name: string;
			media: IMedia;
			mid: string;
			inF: number;
			outF: number | null;
			start: number | null;
			end: number | null;
			rate: Rate;
		};
		const cams: (Cam | null)[] = angleNodes.map((a, i) => {
			const clip = child(a, 'clip');
			const file = clip ? descendants(clip).find((d) => d.name === 'file') : undefined;
			if (!clip || !file) return null;
			const cname = childText(clip, 'name') || `Camera ${i + 1}`;
			const mid = this.file(file, cname, this.b.p.root);
			if (!mid) return null;
			const media = this.b.p.media[mid]!;
			return {
				name: cname,
				media,
				mid,
				rate: readRate(clip) ?? media.video?.rate ?? seqRate,
				inF: Math.max(0, childInt(clip, 'in') ?? 0),
				outF: childInt(clip, 'out'),
				start: childInt(clip, 'start'),
				end: childInt(clip, 'end'),
			};
		});
		const firstVideo = cams.find((c) => c?.media.video);
		if (!firstVideo) {
			this.report.warn(
				`multiclip "${childText(def, 'name') ?? ''}" has no camera with picture; it was skipped`,
			);
			return null;
		}
		const seq = this.b.sequence(
			{
				name: childText(def, 'name') || 'Multi-Camera Source',
				rate: seqRate,
				dropFrame: false,
				width: firstVideo.media.video!.width,
				height: firstVideo.media.video!.height,
				sampleRate: firstVideo.media.audio?.sampleRate ?? 48000,
				startTimecode: 0,
			},
			{ bin: this.b.p.root },
		);
		const sync = childInt(def, 'synctype');
		const ids: string[] = [];
		// With start/end on every angle clip (JasperEditor): the In points meet at the latest start. Otherwise the
		// In points meet at the time that puts the earliest media start at 0.
		const live = cams.filter((c): c is Cam => !!c);
		const explicit = live.every((c) => c.start !== null && c.end !== null && c.start >= 0 && c.end > c.start);
		const meet = explicit
			? Math.max(0, ...live.map((c) => framesToFlicks(c.start!, seqRate)))
			: Math.max(0, ...live.map((c) => framesToFlicks(c.inF, c.rate)));
		const angles: NonNullable<ISequence['multicam']>['angles'] = [];
		for (const [i, cam] of cams.entries()) {
			const id = `angle${i + 1}`;
			ids.push(id);
			if (!cam) {
				this.report.warn(`angle ${i + 1} of multiclip "${seq.name}" has no media clip; it was skipped`);
				continue;
			}
			const inT = framesToFlicks(cam.inF, cam.rate);
			let startT: number;
			let srcIn: number;
			let dur: number;
			if (explicit) {
				startT = framesToFlicks(cam.start!, seqRate);
				srcIn = inT - (meet - startT);
				dur = framesToFlicks(cam.end!, seqRate) - startT;
			} else {
				startT = meet - inT;
				srcIn = 0;
				dur =
					cam.media.duration ??
					(cam.outF !== null && cam.outF > cam.inF ? framesToFlicks(cam.outF, cam.rate) : inT);
			}
			if (srcIn < 0) {
				startT -= srcIn;
				dur += srcIn;
				srcIn = 0;
			}
			if (cam.media.duration !== null) dur = Math.min(dur, cam.media.duration - srcIn);
			if (dur <= 0) continue;
			const place = (kind: 'video' | 'audio') => {
				const t = this.b.track();
				t.name = cam.name;
				t.clips.push(
					newClip({
						id: this.b.id('c'),
						name: cam.name,
						start: startT,
						duration: dur,
						sourceIn: srcIn,
						source: { type: 'media', mediaId: cam.mid },
					}),
				);
				seq[kind].push(t);
				return seq[kind].length - 1;
			};
			const video = cam.media.video ? place('video') : null;
			const audio = cam.media.audio ? [place('audio')] : [];
			const link = video !== null && audio.length ? this.b.id('l') : null;
			if (link) {
				seq.video[video!]!.clips[0]!.link = link;
				seq.audio[audio[0]!]!.clips[0]!.link = link;
			}
			angles.push({ id, name: cam.name, video, audio, enabled: true });
		}
		this.b.ensureTracks(seq, 'video', 1);
		this.b.ensureTracks(seq, 'audio', 1);
		seq.multicam = {
			angles,
			audio: 'switch',
			...(sync === 1
				? { sync: 'in' }
				: sync === 2
					? { sync: 'out' }
					: sync && sync >= 3
						? { sync: 'timecode' }
						: {}),
		};
		const r = { sid: seq.id, angles: ids };
		this.multiclipSeqs.set(key, r);
		return r;
	}

	track(
		seq: ISequence,
		kind: 'video' | 'audio',
		ti: number,
		tn: XNode,
		rate: Rate,
		frame: { width: number; height: number },
		depth: number,
	): void {
		const t = seq[kind][ti]!;
		t.enabled = childBool(tn, 'enabled') ?? true;
		t.locked = childBool(tn, 'locked') ?? false;
		const transNodes: XNode[] = [];
		for (const c of elements(tn)) {
			if (c.name === 'clipitem' || c.name === 'generatoritem') {
				const r = this.clipItem(c, kind, rate, frame, depth);
				if (!r) continue;
				const { clip, refs } = r;
				this.xmlClipIds.set(`${seq.id}/${this.key(c)}`, clip.id);
				if (refs.length) this.links.push({ seq: seq.id, clip: clip.id, refs });
				if (t.clips.some((o) => o.start < clip.start + clip.duration && clip.start < o.start + o.duration)) {
					this.report.warn(
						`clip item "${clip.name}" overlaps another on ${kind === 'video' ? 'V' : 'A'}${ti + 1}; it was moved to a new track`,
						{
							subject: { kind: 'clip', name: clip.name, frame: frameOf(clip.start, rate) },
							instead: 'a clip on the next free track',
						},
					);
					this.b.place(seq, kind, ti + 1, clip);
				} else t.clips.push(clip);
			} else if (c.name === 'transitionitem') transNodes.push(c);
		}
		t.clips.sort((a, b) => a.start - b.start);
		for (const c of transNodes) this.transition(t, kind, c, rate);
	}

	clipItem(
		c: XNode,
		kind: 'video' | 'audio',
		seqRate: Rate,
		frame: { width: number; height: number },
		depth: number,
	): { clip: IClip; refs: string[] } | null {
		const name = childText(c, 'name') ?? '';
		const rate = readRate(c) ?? seqRate;
		let source: IClip['source'];
		let multicam: IClip['multicam'];
		let srcFrame: { width: number; height: number } = frame;
		if (c.name === 'generatoritem') {
			const eff = child(c, 'effect');
			const gname = childText(eff, 'name') || name;
			const gid = childText(eff, 'effectid') ?? '';
			const g = generatorFrom(gname, gid, this.report);
			if (g.kind === 'color') {
				const v = descendants(eff ?? c).find((d) => d.name === 'value' && child(d, 'red'));
				if (v) g.color = readColor(v);
			}
			const mid = this.b.media(
				`gen:${JSON.stringify(g)}`,
				{
					name: name || GENERATORS.find((x) => x.kind === g.kind)!.write[0],
					kind: 'generator',
					generator: g,
					video: { ...frame, rate: seqRate },
				},
				this.b.p.root,
			);
			source = { type: 'media', mediaId: mid };
		} else if (child(c, 'multiclip')) {
			const mc = this.multiclip(child(c, 'multiclip')!, seqRate);
			if (!mc) return null;
			const s = this.b.p.sequences[mc.sid]!;
			srcFrame = { width: s.width, height: s.height };
			source = { type: 'sequence', sequenceId: mc.sid };
			const own = children(child(c, 'multiclip'), 'angle');
			const angleNodes = own.length
				? own
				: children(this.multiclipDefs.get(this.key(child(c, 'multiclip')!)) ?? null, 'angle');
			const flag = kind === 'video' ? 'activevideoangle' : 'activeaudioangle';
			const active = Math.max(
				0,
				angleNodes.findIndex((a) => childBool(a, flag) === true),
			);
			multicam = { enabled: true, angle: mc.angles[active] ?? mc.angles[0]! };
		} else if (child(c, 'file')) {
			const mid = this.file(child(c, 'file')!, name, this.b.p.root);
			if (!mid) {
				this.report.warn(
					`clip item "${name}" refers to a file the document does not define; it was skipped`,
					{
						subject: { kind: 'clip', name },
					},
				);
				return null;
			}
			const m = this.b.p.media[mid]!;
			if (m.video) srcFrame = { width: m.video.width, height: m.video.height };
			source = { type: 'media', mediaId: mid };
		} else if (child(c, 'sequence')) {
			const sid = this.sequence(child(c, 'sequence')!, this.b.p.root, depth + 1);
			if (!sid) return null;
			const s = this.b.p.sequences[sid]!;
			srcFrame = { width: s.width, height: s.height };
			source = { type: 'sequence', sequenceId: sid };
		} else {
			this.report.warn(`clip item "${name}" has no media reference; imported offline`, {
				subject: { kind: 'clip', name },
				instead: 'an offline media item',
			});
			const mid = this.b.media(
				`offline:${name}`,
				{
					name: name || 'Offline',
					kind: kind === 'audio' ? 'audio' : 'video',
					path: null,
					offline: true,
					...(kind === 'video'
						? { video: { ...frame, rate: seqRate } }
						: { audio: { sampleRate: 48000, channels: 2 } }),
				},
				this.b.p.root,
			);
			source = { type: 'media', mediaId: mid };
		}

		const start = childInt(c, 'start') ?? -1;
		const end = childInt(c, 'end') ?? -1;
		const inF = childInt(c, 'in') ?? 0;
		const outF = childInt(c, 'out') ?? inF;
		const ticks = (tag: string, frames: number) => {
			const t = childText(c, tag);
			if (t) {
				const r = ticksToFlicks(t);
				if (r) {
					if (!r.exact)
						this.report.info('Premiere tick values off the flick grid were rounded to the nearest flick');
					return r.flicks;
				}
			}
			return framesToFlicks(frames, rate);
		};
		const srcIn = ticks('pproTicksIn', inF);
		const srcOut = ticks('pproTicksOut', outF);

		// Speed from the Time Remap filter (or the in/out vs start/end ratio).
		let speed = 1;
		let reverse = false;
		let hold = false;
		let remap = false;
		let variable = false;
		let blending = false;
		let graph: { when: number; value: number; smooth: boolean }[] = [];
		for (const eff of children(c, 'filter')
			.map((f) => child(f, 'effect'))
			.filter((e): e is XNode => !!e)) {
			if ((childText(eff, 'effectid') ?? '').toLowerCase() !== 'timeremap') continue;
			remap = true;
			for (const p of children(eff, 'parameter')) {
				const pid = (childText(p, 'parameterid') ?? '').toLowerCase();
				if (pid === 'speed') {
					const v = childNum(p, 'value') ?? 100;
					if (v === 0) hold = true;
					else {
						speed = Math.abs(v) / 100;
						reverse ||= v < 0;
					}
				} else if (pid === 'reverse') reverse ||= childBool(p, 'value') ?? false;
				else if (pid === 'variablespeed')
					variable = (childBool(p, 'value') ?? false) || (childNum(p, 'value') ?? 0) !== 0;
				else if (pid === 'frameblending') blending = childBool(p, 'value') ?? false;
				else if (pid === 'graphdict')
					graph = children(p, 'keyframe')
						.map((k) => ({
							when: childNum(k, 'when') ?? Number.NaN,
							value: childNum(k, 'value') ?? Number.NaN,
							smooth: (pathText(k, ['interpolation', 'name']) ?? 'linear') !== 'linear',
						}))
						.filter((k) => Number.isFinite(k.when) && Number.isFinite(k.value))
						.sort((a, b) => a.when - b.when);
			}
		}
		// variable speed (Time Remap graph) → a time map; the clip axis then runs at 100 %.
		const timeMap =
			variable && graph.length >= 2 && !hold
				? graph.map((k) => ({
						time: framesToFlicks(k.when, rate) - srcIn,
						value: Math.round(k.value * flicksPerFrame(rate)),
						interp: (k.smooth ? 'smooth' : 'linear') as 'smooth' | 'linear',
					}))
				: null;
		if (variable && !timeMap && !hold)
			this.report.warn(`variable speed on clip "${name}" has no time graph; a constant speed was used`, {
				subject: { kind: 'clip', name },
				instead: 'a constant speed',
			});
		const srcLen = Math.abs(srcOut - srcIn);
		let startT: number;
		let dur: number;
		const holdLen = framesToFlicks(Math.max(0, outF - inF), rate);
		if (start >= 0 && end >= 0) {
			startT = framesToFlicks(start, seqRate);
			dur = framesToFlicks(end, seqRate) - startT;
		} else if (start >= 0) {
			startT = framesToFlicks(start, seqRate);
			dur = hold ? holdLen : unscaled(srcLen, speed);
		} else if (end >= 0) {
			dur = hold ? holdLen : unscaled(srcLen, speed);
			startT = framesToFlicks(end, seqRate) - dur;
		} else {
			this.report.warn(`clip item "${name}" has neither start nor end; it was skipped`, {
				subject: { kind: 'clip', name },
			});
			return null;
		}
		if (dur <= 0 || startT < 0) return null;
		if (!remap && !hold && srcLen > 0 && srcLen !== dur && !timeMap)
			speed = Math.round((srcLen / dur) * 10000) / 10000;
		const clip = newClip({
			id: this.b.id('c'),
			name: name || 'Clip',
			start: startT,
			duration: dur,
			sourceIn: Math.min(srcIn, srcOut),
			source,
			speed,
			reverse,
			...(hold ? { hold: srcIn, speed: 1, reverse: false } : {}),
			...(timeMap ? { timeMap, sourceIn: srcIn, speed: 1, reverse: false } : {}),
			...(blending ? { frameSampling: 'frame-blending' as const } : {}),
			enabled: childBool(c, 'enabled') ?? true,
			...(multicam ? { multicam } : {}),
		});
		const label = labelFrom(pathText(c, ['labels', 'label2']));
		if (label) clip.label = label;
		const mode = childText(c, 'compositemode');
		if (mode) {
			const b = blendFromFcp7(mode);
			if (b) {
				if (b !== 'normal') clip.blendMode = b;
			} else
				this.report.warn(`composite mode "${mode}" of clip "${name}" is not supported`, {
					subject: { kind: 'clip', name },
					instead: 'Normal',
				});
		}
		clip.markers = readMarkers(c, rate);
		if (kind === 'audio') {
			const st = child(c, 'sourcetrack');
			const ti = childInt(st, 'trackindex');
			const m = source.type === 'media' ? this.b.p.media[source.mediaId] : undefined;
			const chans = m?.audio?.channels ?? 2;
			if (ti && ti >= 1 && (chans > 2 || ti > 1)) clip.channels = { streamIndex: 0, map: [ti - 1] };
		}
		for (const f of children(c, 'filter')) this.filter(clip, f, rate, frame, srcFrame, kind);
		const refs = children(c, 'link')
			.map((l) => childText(l, 'linkclipref'))
			.filter((x): x is string => !!x);
		return { clip, refs };
	}

	filter(
		clip: IClip,
		f: XNode,
		rate: Rate,
		frame: { width: number; height: number },
		src: { width: number; height: number },
		kind: 'video' | 'audio',
	): void {
		const e = child(f, 'effect');
		if (!e) return;
		const enabled = childBool(f, 'enabled') ?? true;
		const id = childText(e, 'effectid') ?? '';
		const name = childText(e, 'name') || id;
		const params = children(e, 'parameter');
		const find = (pid: string) =>
			params.find(
				(p) =>
					(childText(p, 'parameterid') ?? '').toLowerCase() === pid.toLowerCase() ||
					(childText(p, 'name') ?? '').toLowerCase() === pid.toLowerCase(),
			) ?? null;
		const where = { kind: 'effect' as const, name };
		const fw = frame.width;
		const fh = frame.height;
		switch (id.toLowerCase()) {
			case 'timeremap':
				return;
			case 'basic': {
				const t: Transform = clip.transform ?? {
					position: anim<Vec2>([fw / 2, fh / 2]),
					anchor: anim<Vec2>([src.width / 2, src.height / 2]),
					scale: anim(100),
					scaleWidth: anim(100),
					uniformScale: true,
					rotation: anim(0),
					flipH: false,
					flipV: false,
				};
				const sc = find('scale');
				if (sc) {
					t.scale = readParam(sc, (v) => v, rate);
					t.scaleWidth = JSON.parse(JSON.stringify(t.scale));
				}
				const rot = find('rotation');
				if (rot) t.rotation = readParam(rot, (v) => v, rate);
				const ctr = find('center');
				if (ctr)
					t.position = readPoint(ctr, (x, y) => [round9(fw / 2 + x * fw), round9(fh / 2 + y * fh)], rate);
				const off = find('centerOffset');
				if (off)
					t.anchor = readPoint(
						off,
						(x, y) => [src.width / 2 + x * src.width, src.height / 2 + y * src.height],
						rate,
					);
				clip.transform = t;
				if (!enabled)
					this.report.warn(`a disabled Basic Motion on clip "${clip.name}" was imported enabled`, {
						subject: where,
					});
				return;
			}
			case 'opacity': {
				const p = find('opacity');
				if (p) clip.opacity = readParam(p, (v) => v, rate);
				return;
			}
			case 'audiolevels': {
				const p = find('level');
				if (p) clip.volumeDb = readParam(p, (v) => round9(gainToDb(v)), rate);
				return;
			}
			case 'audiopan': {
				const p = find('pan');
				if (p) clip.pan = readParam(p, (v) => round9(v * 100), rate);
				return;
			}
			case 'crop': {
				const out: EffectInstance['params'] = {};
				for (const k of ['left', 'right', 'top', 'bottom'] as const) {
					const p = find(k);
					if (p) out[k] = readParam(p, (v) => v, rate);
				}
				const fe = find('edgefeather');
				if (fe) out.feather = readParam(fe, (v) => v, rate);
				clip.effects.push({
					id: this.b.id('fx'),
					effectId: 'jasper.crop',
					effectVersion: 1,
					enabled,
					params: out,
				});
				return;
			}
		}
		const spec = effectSpecOf(id, kind) ?? effectSpecOf(name, kind);
		if (!spec) {
			this.report.warn(`effect "${name}" on clip "${clip.name}" is not supported and was skipped`, {
				subject: where,
			});
			return;
		}
		const out: EffectInstance['params'] = {};
		for (const ps of spec.params) {
			const p = find(ps.name) ?? find(ps.label);
			if (!p) continue;
			switch (ps.type) {
				case 'number':
					out[ps.name] = readParam(p, (v) => v, rate);
					break;
				case 'vec2':
					out[ps.name] = readPoint(p, (x, y) => [x, y], rate);
					break;
				case 'boolean':
					out[ps.name] = anim(childBool(p, 'value') ?? false);
					break;
				case 'color': {
					const v = child(p, 'value');
					if (v) out[ps.name] = anim(readColor(v));
					break;
				}
				case 'enum':
				case 'string':
					out[ps.name] = anim(childText(p, 'value') ?? '');
					break;
				default:
					break;
			}
		}
		clip.effects.push({
			id: this.b.id('fx'),
			effectId: spec.id,
			effectVersion: spec.version,
			enabled,
			params: out,
		});
	}

	transition(t: ITrack, kind: 'video' | 'audio', c: XNode, seqRate: Rate): void {
		const rate = readRate(c) ?? seqRate;
		const start = childInt(c, 'start') ?? 0;
		const end = childInt(c, 'end') ?? start;
		const s = framesToFlicks(start, rate);
		const e = framesToFlicks(end, rate);
		if (e <= s) return;
		const eff = child(c, 'effect');
		const name = childText(eff, 'name') || childText(eff, 'effectid') || 'Cross Dissolve';
		const audio = kind === 'audio';
		// The name, else the effect id (a localised Premiere writes its display name, e.g. "Potencia constante").
		const eid = childText(eff, 'effectid');
		let effectId =
			knownTransition(name, audio) ??
			(eid ? knownTransition(eid, audio) : null) ??
			transitionFromName(name, audio, this.report);
		let params: ITransition['params'] = {};
		if (audio) {
			// Premiere's fade shape (FadeShapeType / FadeShapeValue / CrossfadeSymmetry) as transition parameters.
			const param = (...ids: string[]): string | undefined => {
				for (const x of children(eff, 'parameter'))
					if (ids.includes((childText(x, 'parameterid') ?? '').toLowerCase()))
						return childText(x, 'value') ?? undefined;
				return undefined;
			};
			const r = premiereAudioTransition(
				effectId,
				{
					type: param('fadeshapetype', 'fadeshape'),
					value: param('fadeshapevalue', 'fadevalue'),
					symmetry: param('crossfadesymmetry', 'symmetry'),
				},
				this.report,
				{ name, frame: start },
			);
			effectId = r.effectId;
			params = r.params;
			if (effectId === CUSTOM_FADE) {
				const outType = premiereShapeType(param('outfadeshape'));
				const outValue = Number(param('outfadevalue'));
				if (outType) params.outFadeShape = { value: outType, keyframes: [] };
				if (param('outfadevalue') !== undefined && Number.isFinite(outValue))
					params.outFadeValue = { value: clampFadeValue(outValue), keyframes: [] };
			}
		}
		const align = (childText(c, 'alignment') ?? '').toLowerCase();
		let from: IClip | undefined;
		let to: IClip | undefined;
		if (align !== 'start-black')
			from = t.clips
				.filter((x) => x.start + x.duration >= s && x.start + x.duration <= e)
				.sort((a, b) => b.start - a.start)[0];
		if (align !== 'end-black')
			to = t.clips.filter((x) => x.start >= s && x.start <= e).sort((a, b) => a.start - b.start)[0];
		if (from && to && from.start + from.duration !== to.start) {
			if (align === 'start-black' || (!align && to.start === s)) from = undefined;
			else to = undefined;
		}
		if (!from && !to) {
			this.report.warn(`transition "${name}" at frame ${start} has no adjacent clip; it was skipped`, {
				subject: { kind: 'transition', name, frame: start },
			});
			return;
		}
		const cut = from ? from.start + from.duration : to!.start;
		const alignment: ITransition['alignment'] =
			align === 'center'
				? 'center'
				: align === 'start' || align === 'start-black'
					? 'start-at-cut'
					: align === 'end' || align === 'end-black'
						? 'end-at-cut'
						: cut === s
							? 'start-at-cut'
							: cut === e
								? 'end-at-cut'
								: 'center';
		t.transitions.push({
			id: this.b.id('t'),
			effectId,
			from: from?.id ?? null,
			to: to?.id ?? null,
			start: s,
			duration: e - s,
			alignment,
			params,
		});
		t.transitions.sort((a, b) => a.start - b.start);
	}

	resolveLinks(): void {
		const groupOf = new Map<string, string>();
		for (const pl of this.links) {
			const members = [
				...new Set([
					pl.clip,
					...pl.refs.map((r) => this.xmlClipIds.get(`${pl.seq}/${r}`)).filter((x): x is string => !!x),
				]),
			];
			if (members.length < 2) continue;
			const existing = members.map((m) => groupOf.get(`${pl.seq}/${m}`)).find((x) => !!x);
			const g = existing ?? this.b.id('l');
			for (const m of members) groupOf.set(`${pl.seq}/${m}`, g);
		}
		for (const [k, g] of groupOf) {
			const [sid, cid] = k.split('/') as [string, string];
			const s = this.b.p.sequences[sid];
			for (const t of [...(s?.video ?? []), ...(s?.audio ?? [])]) {
				const c = t.clips.find((x) => x.id === cid);
				if (c) c.link = g;
			}
		}
	}
}

function interpOf(k: XNode): Interpolation {
	const n = (pathText(k, ['interpolation', 'name']) ?? '').toLowerCase();
	if (n === 'hold') return 'hold';
	if (n === 'bezier' || n === 'fcpcurve' || n === 'ease' || n === 'smooth') return 'bezier';
	return 'linear';
}

function keyTime(k: XNode, rate: Rate): number {
	return framesToFlicks(childInt(k, 'when') ?? 0, rate);
}

function readParam(p: XNode, map: (v: number) => number, rate: Rate): Animatable<number> {
	const v = childNum(p, 'value') ?? 0;
	const out: Animatable<number> = { value: map(v), keyframes: [] };
	for (const k of children(p, 'keyframe')) {
		const kv = childNum(k, 'value') ?? v;
		out.keyframes.push(kf(keyTime(k, rate), map(kv), interpOf(k)) as Keyframe<number>);
	}
	finishKeys(out);
	return out;
}

function readXY(v: XNode | null): [number, number] {
	return [childNum(v, 'horiz') ?? 0, childNum(v, 'vert') ?? 0];
}

function readPoint(p: XNode, map: (x: number, y: number) => Vec2, rate: Rate): Animatable<Vec2> {
	const [x, y] = readXY(child(p, 'value'));
	const out: Animatable<Vec2> = { value: map(x, y), keyframes: [] };
	for (const k of children(p, 'keyframe')) {
		const [kx, ky] = child(k, 'value') ? readXY(child(k, 'value')) : [x, y];
		out.keyframes.push(kf(keyTime(k, rate), map(kx, ky), interpOf(k)) as Keyframe<Vec2>);
	}
	finishKeys(out);
	return out;
}

/** Sorts keys, drops duplicate times (the later wins) and makes the static value the first key's. */
function finishKeys<T>(a: Animatable<T>): void {
	a.keyframes.sort((x, y) => x.time - y.time);
	const out: Keyframe<T>[] = [];
	for (const k of a.keyframes) {
		if (out.length && out[out.length - 1]!.time === k.time) out[out.length - 1] = k;
		else out.push(k);
	}
	for (const k of out) k.id = `kf${k.time}`;
	a.keyframes = out;
	if (out[0]) a.value = out[0].value;
}

function readMarkers(n: XNode, rate: Rate): IMarker[] {
	const out: IMarker[] = [];
	for (const m of children(n, 'marker')) {
		const inF = childInt(m, 'in') ?? 0;
		const outF = childInt(m, 'out') ?? -1;
		const start = framesToFlicks(Math.max(0, inF), rate);
		out.push({
			start,
			duration: outF > inF ? framesToFlicks(outF, rate) - start : 0,
			name: childText(m, 'name') ?? '',
			comment: childText(m, 'comment') ?? '',
			color: labelFrom(childText(m, 'color')) ?? markerColor(childText(m, 'color')) ?? 'green',
		});
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}

/** Premiere's marker colour names (Green, Red, Purple, Orange, Yellow, White, Blue, Cyan). */
function markerColor(s: string | null): LabelColor | null {
	switch ((s ?? '').trim().toLowerCase()) {
		case 'red':
			return 'rose';
		case 'orange':
			return 'mango';
		case 'white':
			return 'lavender';
		case 'cyan':
			return 'caribbean';
		case 'purple':
			return 'purple';
		default:
			return null;
	}
}

export function exportFcp7(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): string {
	if (!p.sequences[sequenceId]) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const x = new Fcp7Exporter(p, opts, report);
	return x.run(sequenceId);
}

type ClipRef = { xid: string; kind: 'video' | 'audio'; track: number; index: number };

/** One camera of a multi-camera source written as an xmeml multiclip angle: one media clip. */
type MulticlipAngle = {
	angle: IMulticamAngle;
	media: IMedia;
	/**
	 * The angle clip's In point: its media at the latest angle start, where all cameras meet (In-point sync,
	 * synctype 1); `start` + `end` (source-sequence frames) place the clips exactly for readers that keep them.
	 */
	inT: number;
	/** The clip on the source sequence (flicks). */
	start: number;
	duration: number;
};

/** A track of a nested sequence as one multi-camera clip sees it (the other angles' tracks disabled). */
type SequenceView = { key: string; kind: 'video' | 'audio'; hidden: ReadonlySet<number> };

class Fcp7Exporter {
	readonly w = new XmlWriter({ doctype: 'xmeml' });
	readonly fileIds = new Map<string, string>();
	readonly seqIds = new Map<string, string>();
	readonly masterIds = new Map<string, string>();
	readonly writing = new Set<string>();
	readonly written = new Set<string>();
	readonly multiclips = new Map<string, MulticlipAngle[] | null>();
	nextClip = 1;

	constructor(
		readonly p: IProject,
		readonly opts: ExportOptions,
		readonly report: Report,
	) {}

	run(sequenceId: string): string {
		const w = this.w;
		w.open('xmeml', [['version', this.opts.xmemlVersion === 5 ? 5 : 4]]);
		const exported = new Set<string>();
		const visit = (sid: string) => {
			if (exported.has(sid)) return;
			exported.add(sid);
			const s = this.p.sequences[sid];
			for (const t of [...(s?.video ?? []), ...(s?.audio ?? [])])
				for (const c of t.clips) if (c.source.type === 'sequence') visit(c.source.sequenceId);
		};
		visit(sequenceId);
		const usedMedia = new Set<string>();
		for (const sid of exported)
			for (const t of [...this.p.sequences[sid]!.video, ...this.p.sequences[sid]!.audio])
				for (const c of t.clips) if (c.source.type === 'media') usedMedia.add(c.source.mediaId);
		// Multi-camera sources every use of which is written as a multiclip are not written as sequences too.
		const multiclipOnly = new Set<string>();
		const plainUse = new Set<string>();
		for (const sid of exported)
			for (const kind of ['video', 'audio'] as const)
				for (const t of this.p.sequences[sid]![kind])
					for (const c of t.clips) {
						if (c.source.type !== 'sequence') continue;
						const info = multicamOf(this.p, c);
						if (info && this.multiclipAngles(info) && !(kind === 'audio' && info.mc.audio === 'all'))
							multiclipOnly.add(c.source.sequenceId);
						else plainUse.add(c.source.sequenceId);
					}
		for (const id of plainUse) multiclipOnly.delete(id);
		const hasBins = this.p.root.some((e) => e.type === 'bin');
		if (hasBins) {
			// A project: the bins holding the exported sequences and their (file) media as master clips.
			w.open('project')
				.text('name', this.opts.name ?? this.p.name)
				.open('children');
			const placed = new Set<string>();
			const entries = (list: IBinEntry[], depth: number) => {
				for (const e of list) {
					if (e.type === 'bin') {
						if (depth > MAX_NEST || !hasContent(e.children, exported, usedMedia)) continue;
						w.open('bin').text('name', e.name);
						if (e.label) w.open('labels').text('label2', labelName(e.label)).close();
						w.open('children');
						entries(e.children, depth + 1);
						w.close().close();
					} else if (
						e.type === 'sequence' &&
						exported.has(e.id) &&
						!placed.has(e.id) &&
						(e.id === sequenceId || !multiclipOnly.has(e.id))
					) {
						placed.add(e.id);
						this.writeSequence(e.id, e.id === sequenceId);
					} else if (e.type === 'media' && usedMedia.has(e.id) && !placed.has(e.id)) {
						placed.add(e.id);
						this.writeMasterClip(e.id);
					}
				}
			};
			entries(this.p.root, 0);
			if (!placed.has(sequenceId)) this.writeSequence(sequenceId, true);
			w.close().close();
		} else this.writeSequence(sequenceId, true);
		w.close();
		return w.finish();
	}

	seqId(id: string): string {
		let v = this.seqIds.get(id);
		if (!v) {
			v = `sequence-${this.seqIds.size + 1}`;
			this.seqIds.set(id, v);
		}
		return v;
	}

	masterId(id: string): string {
		let v = this.masterIds.get(id);
		if (!v) {
			v = `masterclip-${this.masterIds.size + 1}`;
			this.masterIds.set(id, v);
		}
		return v;
	}

	writeTimecode(frames: number, rate: Rate, df: boolean, reel?: string | null): void {
		const w = this.w;
		w.open('timecode');
		writeRate(w, rate);
		w.text('string', formatTc(frames, rate, df))
			.text('frame', frames)
			.text('displayformat', df ? 'DF' : 'NDF');
		if (reel) w.open('reel').text('name', reel).close();
		w.close();
	}

	writeMasterClip(mediaId: string): void {
		const m = this.p.media[mediaId];
		if (!m || m.generator) return;
		const w = this.w;
		const rate = m.video?.rate ?? { num: 24, den: 1 };
		w.open('clip', [['id', this.masterId(mediaId)]]);
		w.text('name', m.name);
		w.text('duration', m.duration !== null ? flicksToFrames(m.duration, rate) : 0);
		writeRate(w, rate);
		if (m.label) w.open('labels').text('label2', labelName(m.label)).close();
		const kind = m.video ? 'video' : 'audio';
		w.open('media')
			.open(kind)
			.open('track')
			.open('clipitem', [['id', `${this.masterId(mediaId)}-item`]]);
		w.text('name', m.name);
		this.writeFile(mediaId, rate);
		w.close().close().close().close();
		writeMarkers(w, m.markers, rate);
		w.close();
	}

	writeSequence(id: string, top: boolean, view?: SequenceView): void {
		const w = this.w;
		const key = view ? `${id}#${view.key}` : id;
		const sid = this.seqId(key);
		const s = this.p.sequences[id];
		if (!s || this.written.has(key) || this.writing.has(id)) {
			w.empty('sequence', [['id', sid]]);
			return;
		}
		this.writing.add(id);
		const rate = s.rate;
		const df = s.dropFrame;
		w.open('sequence', [['id', sid]]);
		w.text('name', top && this.opts.name ? this.opts.name : s.name);
		w.text('duration', flicksToFrames(sequenceDuration(s), rate));
		writeRate(w, rate);
		this.writeTimecode(s.startTimecode, rate, df);
		if (s.inPoint != null) w.text('in', flicksToFrames(s.inPoint, rate));
		if (s.outPoint != null) w.text('out', flicksToFrames(s.outPoint, rate));
		if (s.label) w.open('labels').text('label2', labelName(s.label)).close();
		w.open('media');
		const refs = new Map<string, ClipRef>();
		for (const kind of ['video', 'audio'] as const)
			for (const [ti, t] of s[kind].entries())
				for (const [ci, c] of t.clips.entries())
					refs.set(c.id, { xid: `clipitem-${this.nextClip++}`, kind, track: ti + 1, index: ci + 1 });
		const linkMembers = new Map<string, string[]>();
		const groups = new Set<string>();
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) {
				if (c.link) linkMembers.set(c.link, [...(linkMembers.get(c.link) ?? []), c.id]);
				if (c.group) groups.add(c.group);
			}
		if (groups.size)
			this.report.info(
				`${groups.size} clip group(s) of "${s.name}" have no Final Cut Pro XML equivalent and were not written`,
				{
					subject: { kind: 'sequence', id, name: s.name },
					instead: 'ungrouped clips',
				},
			);
		for (const kind of ['video', 'audio'] as const) {
			w.open(kind).open('format').open('samplecharacteristics');
			if (kind === 'video') {
				writeRate(w, rate);
				w.text('width', s.width).text('height', s.height).text('anamorphic', 'FALSE');
				w.text(
					'pixelaspectratio',
					!s.pixelAspect || s.pixelAspect.num === s.pixelAspect.den ? 'square' : 'custom',
				);
				w.text('fielddominance', 'none');
			} else w.text('depth', 16).text('samplerate', s.sampleRate);
			w.close().close();
			s[kind].forEach((t, ti) => {
				w.open('track');
				const order: [number, 0 | 1, number][] = [
					...t.clips.map((c, i): [number, 0 | 1, number] => [c.start, 1, i]),
					...t.transitions.map((x, i): [number, 0 | 1, number] => [x.start, 0, i]),
				].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
				for (const [, k, i] of order) {
					if (k === 1) {
						const c = t.clips[i]!;
						const links = c.link
							? (linkMembers.get(c.link) ?? []).map((m) => refs.get(m)!).filter(Boolean)
							: [];
						this.writeClip(c, kind, s, refs.get(c.id)!.xid, links);
					} else this.writeTransition(t.transitions[i]!, kind, rate);
				}
				const shown = !(view && view.kind === kind && view.hidden.has(ti));
				w.text('enabled', boolStr(t.enabled && shown)).text('locked', boolStr(t.locked));
				w.close();
				if (
					kind === 'audio' &&
					(t.volumeDb?.keyframes.length ||
						(t.volumeDb && t.volumeDb.value !== 0) ||
						t.pan?.keyframes.length ||
						(t.pan && t.pan.value !== 0))
				)
					this.report.warn(`the volume and pan of track A${ti + 1} are not carried by Final Cut Pro XML`, {
						subject: { kind: 'track', name: t.name ?? `A${ti + 1}` },
						instead: 'the clips at unity track level',
					});
			});
			w.close();
		}
		w.close();
		writeMarkers(w, s.markers, rate);
		w.close();
		if (s.captions?.length)
			this.report.warn(`the caption tracks of "${s.name}" are not carried by Final Cut Pro XML`, {
				subject: { kind: 'sequence', id, name: s.name },
				instead: 'nothing (export the captions as a sidecar file)',
			});
		this.writing.delete(id);
		this.written.add(key);
	}

	/**
	 * The cameras of a multi-camera source as multiclip angles, when every angle is one media clip at normal speed
	 * whose media covers the source's time 0 (and its audio tracks hold nothing else); null otherwise.
	 */
	multiclipAngles(info: MulticamInfo): MulticlipAngle[] | null {
		const s = info.seq;
		if (this.multiclips.has(s.id)) return this.multiclips.get(s.id)!;
		const plain = (c: IClip) =>
			c.source.type === 'media' && c.speed === 1 && !c.reverse && (c.hold ?? null) === null;
		const angles: MulticlipAngle[] = [];
		let ok = true;
		const ordered = [...info.mc.angles.filter((a) => a.enabled), ...info.mc.angles.filter((a) => !a.enabled)];
		for (const a of ordered) {
			const main = a.video !== null ? s.video[a.video] : s.audio[a.audio[0] ?? -1];
			const c = main?.clips.length === 1 && !main.transitions.length ? main.clips[0]! : null;
			const m = c && plain(c) ? this.p.media[(c.source as { mediaId: string }).mediaId] : undefined;
			if (!c || !m || m.generator) {
				ok = false;
				break;
			}
			const same = a.audio.every((i) => {
				const t = s.audio[i];
				if (!t || t === main) return true;
				if (t.transitions.length) return false;
				return t.clips.every(
					(x) =>
						plain(x) &&
						(x.source as { mediaId: string }).mediaId === m.id &&
						x.start === c.start &&
						x.sourceIn === c.sourceIn,
				);
			});
			if (!same) {
				ok = false;
				break;
			}
			angles.push({ angle: a, media: m, inT: c.sourceIn, start: c.start, duration: c.duration });
		}
		// In-point sync: every angle's In is its media at the latest angle start (all cameras must overlap there).
		const t = Math.max(0, ...angles.map((x) => x.start));
		for (const x of angles) {
			if (t >= x.start + x.duration) ok = false;
			x.inT += t - x.start;
		}
		const out = ok && angles.some((x) => x.angle.video !== null) ? angles : null;
		this.multiclips.set(s.id, out);
		return out;
	}

	/** The `<multiclip>` of a multi-camera clip item (Apple's xmeml: name, collapsed, synctype, angle+). */
	writeMulticlip(info: MulticamInfo, angles: MulticlipAngle[]): void {
		const w = this.w;
		const rate = info.seq.rate;
		const first = info.mc.angles.find((a) => a.video !== null) ?? null;
		const audioAngle = info.mc.audio === 'camera1' ? first : info.angle;
		w.open('multiclip', [['id', `multiclip-${this.seqId(info.seq.id).slice('sequence-'.length)}`]]);
		w.text('name', info.seq.name);
		w.text('collapsed', 'TRUE');
		// The angle In points below are aligned at multiclip time 0, whatever the source's own sync method was.
		w.text('synctype', 1);
		for (const [i, a] of angles.entries()) {
			w.open('angle');
			w.text('activevideoangle', boolStr(a.angle.id === info.angle?.id && a.angle.video !== null));
			w.text('activeaudioangle', boolStr(a.angle.id === audioAngle?.id));
			const m = a.media;
			const mrate = m.video?.rate ?? rate;
			w.open('clip', [['id', `${this.seqId(info.seq.id)}-angle-${i + 1}`]]);
			w.text('name', a.angle.name);
			const t = Math.max(0, ...angles.map((x) => x.start));
			const out = a.inT - (t - a.start) + a.duration;
			w.text('duration', flicksToFrames(Math.max(m.duration ?? 0, out), mrate));
			writeRate(w, mrate);
			w.text('in', flicksToFrames(a.inT, mrate)).text('out', flicksToFrames(out, mrate));
			w.text('masterclipid', this.masterId(m.id));
			this.writeFile(m.id, rate);
			w.text('start', flicksToFrames(a.start, rate)).text('end', flicksToFrames(a.start + a.duration, rate));
			w.close().close();
		}
		w.close();
	}

	/** The source of a nested-sequence clip item: a multiclip, the nest as its angle sees it, or the nest. */
	writeNested(c: IClip, kind: 'video' | 'audio', outer: ISequence): void {
		const sid = (c.source as { sequenceId: string }).sequenceId;
		const info = multicamOf(this.p, c);
		if (!info) {
			this.writeSequence(sid, false);
			return;
		}
		const angles = this.multiclipAngles(info);
		const allAudio = kind === 'audio' && info.mc.audio === 'all';
		if (angles && !allAudio) {
			this.writeMulticlip(info, angles);
			return;
		}
		const hidden = multicamHiddenTracks(this.p, c, kind)!;
		this.report.info(
			`multi-camera clip "${c.name}" is written as a nested sequence ${kind === 'video' ? `showing its angle "${info.angle?.name ?? ''}"` : 'playing its audible cameras'}: ${allAudio ? 'the source mixes every camera (no multiclip equivalent)' : 'an angle of its source is not one media clip covering the source start'}`,
			{
				subject: { kind: 'clip', id: c.id, name: c.name, frame: frameOf(c.start, outer.rate) },
				instead: 'a nested sequence with the other cameras’ tracks disabled',
			},
		);
		this.writeSequence(sid, false, {
			key: `${kind}:${[...hidden].sort((a, b) => a - b).join(',')}`,
			kind,
			hidden,
		});
	}

	writeTransition(x: ITransition, kind: 'video' | 'audio', rate: Rate): void {
		const w = this.w;
		if (!onFrame(x.start, rate) || !onFrame(x.duration, rate))
			this.report.info('sub-frame transition positions were rounded to frames');
		const align =
			!x.from && x.to
				? 'start-black'
				: x.from && !x.to
					? 'end-black'
					: x.alignment === 'center'
						? 'center'
						: x.alignment === 'start-at-cut'
							? 'start'
							: 'end';
		w.open('transitionitem');
		writeRate(w, rate);
		w.text('start', flicksToFrames(x.start, rate)).text('end', flicksToFrames(x.start + x.duration, rate));
		w.text('alignment', align);
		const name = transitionLabel(x.effectId);
		w.open('effect').text('name', name).text('effectid', name);
		w.text('effectcategory', kind === 'audio' ? 'Crossfade' : 'Dissolve')
			.text('effecttype', 'transition')
			.text('mediatype', kind);
		if (x.effectId === CUSTOM_FADE) {
			// Premiere's fade shape fields; an asymmetrical crossfade's fade out as JasperEditor parameters.
			const shape = premiereFadeShapeOf(x.params);
			const out = premiereFadeShapeOf({
				fadeShape: x.params.outFadeShape ?? { value: 'cosine', keyframes: [] },
				fadeValue: x.params.outFadeValue ?? { value: 19, keyframes: [] },
			});
			const param = (id: string, label: string, value: number | string) =>
				w.open('parameter').text('parameterid', id).text('name', label).text('value', value).close();
			param('FadeShapeType', 'Fade Shape', shape.FadeShapeType);
			param('FadeShapeValue', 'Fade Value', shape.FadeShapeValue);
			param('CrossfadeSymmetry', 'Crossfade Symmetry', shape.CrossfadeSymmetry);
			if (shape.CrossfadeSymmetry === 1) {
				param('outFadeShape', 'Fade Out Shape', out.FadeShapeType === 1 ? 'cosine' : 'linear');
				param('outFadeValue', 'Fade Out Value', out.FadeShapeValue);
			}
		}
		w.close().close();
	}

	writeClip(c: IClip, kind: 'video' | 'audio', s: ISequence, xid: string, links: ClipRef[]): void {
		const w = this.w;
		const rate = s.rate;
		const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: frameOf(c.start, rate) };
		if (!onFrame(c.start, rate) || !onFrame(c.duration, rate))
			this.report.info('sub-frame clip positions were rounded to frames', { subject: where });
		const m = c.source.type === 'media' ? this.p.media[c.source.mediaId] : undefined;
		const generator = m?.generator ?? null;
		if (generator && kind === 'audio') {
			this.report.warn(
				`${describeClip(c, rate)} (the sound of ${m!.name}) has no Final Cut Pro XML equivalent`,
				{
					subject: where,
					instead: 'a clip item without media',
				},
			);
		}
		if (c.source.type === 'none')
			this.report.warn(`${describeClip(c, rate)} has no Final Cut Pro XML equivalent`, {
				subject: where,
				instead: 'a clip item without media (offline in other applications)',
			});
		const tag = generator && kind === 'video' ? 'generatoritem' : 'clipitem';
		const hold = c.hold ?? null;
		const srcIn = hold ?? c.sourceIn;
		const srcOut = hold !== null ? srcIn + c.duration : sourceOut(c);
		w.open(tag, [['id', xid]]);
		if (c.source.type === 'media' && m && !generator) w.text('masterclipid', this.masterId(m.id));
		w.text('name', c.name);
		w.text('enabled', boolStr(c.enabled));
		const mediaDur =
			c.source.type === 'sequence'
				? sequenceDuration(this.p.sequences[c.source.sequenceId]!)
				: (m?.duration ?? srcOut);
		w.text('duration', flicksToFrames(Math.max(mediaDur, srcOut), rate));
		writeRate(w, rate);
		w.text('start', flicksToFrames(c.start, rate)).text('end', flicksToFrames(c.start + c.duration, rate));
		w.text('in', flicksToFrames(srcIn, rate)).text('out', flicksToFrames(srcOut, rate));
		w.text('pproTicksIn', flicksToTicks(srcIn)).text('pproTicksOut', flicksToTicks(srcOut));
		if (generator && kind === 'video') this.writeGenerator(generator);
		else if (c.source.type === 'sequence') this.writeNested(c, kind, s);
		else if (m && !generator) this.writeFile(m.id, rate);
		if (kind === 'audio' && m && !generator) {
			w.open('sourcetrack')
				.text('mediatype', 'audio')
				.text('trackindex', (c.channels?.map[0] ?? 0) + 1)
				.close();
			if (c.channels && c.channels.map.length > 1 && c.channels.map[1] !== c.channels.map[0]! + 1)
				this.report.info(`the channel mapping of clip "${c.name}" is written as its first channel`, {
					subject: where,
				});
		}
		if (c.blendMode && c.blendMode !== 'normal') {
			const n = fcp7BlendName(c.blendMode);
			if (n) w.text('compositemode', n);
			else
				this.report.warn(
					`blend mode ${c.blendMode} of clip "${c.name}" is not available in Final Cut Pro XML`,
					{
						subject: where,
						instead: 'Normal',
					},
				);
		}
		this.writeFilters(c, kind, s, m);
		for (const l of links) {
			w.open('link')
				.text('linkclipref', l.xid)
				.text('mediatype', l.kind)
				.text('trackindex', l.track)
				.text('clipindex', l.index)
				.close();
		}
		if (c.label) w.open('labels').text('label2', labelName(c.label)).close();
		writeMarkers(w, c.markers, rate);
		w.close();
	}

	writeGenerator(g: IGenerator): void {
		const w = this.w;
		const def = GENERATORS.find((x) => x.kind === g.kind)!;
		w.open('effect')
			.text('name', def.write[0])
			.text('effectid', g.kind === 'bars-and-tone' ? `jasper:${JSON.stringify(g)}` : def.write[1]);
		w.text('effectcategory', 'Matte').text('effecttype', 'generator').text('mediatype', 'video');
		if (g.kind === 'color') {
			w.open('parameter').text('parameterid', 'fillcolor').text('name', 'Color');
			writeColor(w, g.color);
			w.close();
		}
		w.close();
	}

	writeFile(mediaId: string, seqRate: Rate): void {
		const w = this.w;
		const known = this.fileIds.get(mediaId);
		if (known) {
			w.empty('file', [['id', known]]);
			return;
		}
		const fid = `file-${this.fileIds.size + 1}`;
		this.fileIds.set(mediaId, fid);
		const m = this.p.media[mediaId]!;
		const frate = m.video?.rate ?? seqRate;
		w.open('file', [['id', fid]]);
		w.text('name', m.name || (m.path ? fileName(m.path) : 'Untitled'));
		if (m.path) w.text('pathurl', isAbsolutePath(m.path) ? pathToFileUrl(m.path, true) : m.path);
		else if (m.url) w.text('pathurl', m.url);
		else
			this.report.warn(`media "${m.name}" has no file path`, {
				subject: { kind: 'media', id: mediaId, name: m.name },
				instead: 'a file without pathurl (offline)',
			});
		writeRate(w, frate);
		if (m.duration !== null) w.text('duration', flicksToFrames(m.duration, frate));
		const tc = m.timecode;
		this.writeTimecode(
			tc ? flicksToFrames(framesToFlicks(tc.frames, tc.rate), frate) : 0,
			frate,
			!!tc?.dropFrame,
			m.reel,
		);
		w.open('media');
		if (m.video) {
			w.open('video').open('samplecharacteristics');
			writeRate(w, frate);
			w.text('width', m.video.width).text('height', m.video.height).text('anamorphic', 'FALSE');
			w.text(
				'pixelaspectratio',
				!m.video.pixelAspect || m.video.pixelAspect.num === m.video.pixelAspect.den ? 'square' : 'custom',
			);
			w.text('fielddominance', 'none');
			if (m.video.alpha) w.text('alpha', 'straight');
			w.close().close();
		}
		if (m.audio) {
			w.open('audio').open('samplecharacteristics');
			if (m.audio.bitDepth) w.text('depth', m.audio.bitDepth);
			w.text('samplerate', m.audio.sampleRate).close();
			w.text('channelcount', m.audio.channels).close();
		}
		w.close();
		w.close();
	}

	writeFilters(c: IClip, kind: 'video' | 'audio', s: ISequence, m: IMedia | undefined): void {
		const rate = s.rate;
		const fw = s.width;
		const fh = s.height;
		let src = { width: fw, height: fh };
		if (m?.video) src = { width: m.video.width, height: m.video.height };
		if (c.source.type === 'sequence') {
			const inner = this.p.sequences[c.source.sequenceId];
			if (inner) src = { width: inner.width, height: inner.height };
		}
		const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: frameOf(c.start, rate) };
		if (kind === 'video') {
			const t = c.transform;
			if (t && !isDefaultMotion(t, fw, fh, src)) {
				if (!t.uniformScale && (t.scaleWidth.value !== t.scale.value || t.scaleWidth.keyframes.length))
					this.report.warn(`non-uniform scale of clip "${c.name}" is not supported by Basic Motion`, {
						subject: where,
						instead: 'uniform scale (the Scale value)',
					});
				if (t.flipH || t.flipV)
					this.report.warn(`the flip of clip "${c.name}" is not carried by Basic Motion`, {
						subject: where,
						instead: 'no flip',
					});
				this.openEffect('Basic Motion', 'basic', 'motion', 'motion', 'video', true);
				this.numParam('scale', 'Scale', 0, 1000, t.scale, rate, (v) => v);
				this.numParam('rotation', 'Rotation', -8640, 8640, t.rotation, rate, (v) => v);
				this.pointParam('center', 'Center', t.position, rate, ([x, y]) => [
					(x - fw / 2) / fw,
					(y - fh / 2) / fh,
				]);
				this.pointParam('centerOffset', 'Anchor Point', t.anchor, rate, ([x, y]) => [
					(x - src.width / 2) / src.width,
					(y - src.height / 2) / src.height,
				]);
				this.closeEffect();
			}
			if (c.opacity && (c.opacity.value !== 100 || c.opacity.keyframes.length)) {
				this.openEffect('Opacity', 'opacity', 'motion', 'motion', 'video', true);
				this.numParam('opacity', 'opacity', 0, 100, c.opacity, rate, (v) => v);
				this.closeEffect();
			}
			const blend = boolStr(!!c.frameSampling && c.frameSampling !== 'frame-sampling');
			if (c.frameSampling === 'optical-flow')
				this.report.info(
					`Optical Flow of clip "${c.name}" is written as frame blending (FCP7 XML has no optical flow)`,
					{
						subject: where,
					},
				);
			if (c.timeMap && c.timeMap.length >= 2 && c.hold == null) {
				// variable speed as the Time Remap graph (`graphdict`): <when> = the clip's content time
				// in frames (the keyframe convention of this writer), <value> = the source frame shown.
				const m = c.timeMap;
				const first = (m[1]!.value - m[0]!.value) / Math.max(1, m[1]!.time - m[0]!.time);
				this.openEffect('Time Remap', 'timeremap', 'motion', 'motion', 'video', true);
				this.simpleParam('variablespeed', 'variablespeed', 'TRUE');
				this.simpleParam('speed', 'speed', num(Math.round(first * 10000) / 100));
				this.simpleParam('reverse', 'reverse', 'FALSE');
				this.simpleParam('frameblending', 'frameblending', blend);
				const w = this.w;
				w.open('parameter').text('parameterid', 'graphdict').text('name', 'Time Graph');
				for (const p of m) {
					w.open('keyframe')
						.text('when', flicksToFrames(c.sourceIn + p.time * c.speed, rate, 'round'))
						.text('value', exactNum(Math.round((p.value / flicksPerFrame(rate)) * 1000) / 1000));
					if (p.interp === 'smooth') w.open('interpolation').text('name', 'FCPCurve').close();
					w.close();
				}
				w.close();
				this.closeEffect();
			} else if (c.speed !== 1 || c.reverse || c.hold != null) {
				this.openEffect('Time Remap', 'timeremap', 'motion', 'motion', 'video', true);
				this.simpleParam('variablespeed', 'variablespeed', '0');
				this.simpleParam('speed', 'speed', num(c.hold != null ? 0 : c.speed * 100));
				this.simpleParam('reverse', 'reverse', boolStr(c.reverse));
				this.simpleParam('frameblending', 'frameblending', blend);
				this.closeEffect();
			}
		} else {
			if (c.gainDb)
				this.report.info(`the clip gain of "${c.name}" was folded into its Audio Levels`, { subject: where });
			const g = c.gainDb ?? 0;
			if ((c.volumeDb && (c.volumeDb.value !== 0 || c.volumeDb.keyframes.length)) || g) {
				this.openEffect('Audio Levels', 'audiolevels', 'audiolevels', 'audiolevels', 'audio', true);
				this.numParam('level', 'Level', 0, 3.98109, c.volumeDb ?? anim(0), rate, (v) => dbToGain(v + g));
				this.closeEffect();
			}
			if (c.pan && (c.pan.value !== 0 || c.pan.keyframes.length)) {
				this.openEffect('Audio Pan', 'audiopan', 'audiopan', 'audiopan', 'audio', true);
				this.numParam('pan', 'Pan', -1, 1, c.pan, rate, (v) => v / 100);
				this.closeEffect();
			}
			if (c.speed !== 1 || c.reverse) {
				this.openEffect('Time Remap', 'timeremap', 'motion', 'motion', 'audio', true);
				this.simpleParam('speed', 'speed', num(c.speed * 100));
				this.simpleParam('reverse', 'reverse', boolStr(c.reverse));
				this.closeEffect();
			}
		}
		for (const e of c.effects) this.genericEffect(c, e, kind, rate);
	}

	openEffect(
		name: string,
		id: string,
		category: string,
		type: string,
		media: string,
		enabled: boolean,
	): void {
		this.w.open('filter');
		if (!enabled) this.w.text('enabled', 'FALSE');
		this.w
			.open('effect')
			.text('name', name)
			.text('effectid', id)
			.text('effectcategory', category)
			.text('effecttype', type)
			.text('mediatype', media);
	}

	closeEffect(): void {
		this.w.close().close();
	}

	simpleParam(id: string, name: string, value: string): void {
		this.w.open('parameter').text('parameterid', id).text('name', name).text('value', value).close();
	}

	interp(i: Interpolation): void {
		if (i === 'linear') return;
		this.w
			.open('interpolation')
			.text('name', i === 'hold' ? 'hold' : 'FCPCurve')
			.close();
		if (i !== 'hold')
			this.report.info('Bezier keyframe easing is written as FCP curve keyframes (handles not kept)');
	}

	numParam(
		id: string,
		name: string,
		min: number,
		max: number,
		a: Animatable<number>,
		rate: Rate,
		map: (v: number) => number,
	): void {
		const w = this.w;
		w.open('parameter')
			.text('parameterid', id)
			.text('name', name)
			.text('valuemin', num(min))
			.text('valuemax', num(max));
		w.text('value', exactNum(map(a.value)));
		for (const k of a.keyframes) {
			if (!onFrame(k.time, rate)) this.report.info('sub-frame keyframes were rounded to frames');
			w.open('keyframe')
				.text('when', flicksToFrames(k.time, rate))
				.text('value', exactNum(map(k.value)));
			this.interp(k.interpolation);
			w.close();
		}
		w.close();
	}

	pointParam(
		id: string,
		name: string,
		a: Animatable<Vec2>,
		rate: Rate,
		map: (v: Vec2) => [number, number],
	): void {
		const w = this.w;
		w.open('parameter').text('parameterid', id).text('name', name);
		const [x, y] = map(a.value);
		w.open('value').text('horiz', exactNum(x)).text('vert', exactNum(y)).close();
		for (const k of a.keyframes) {
			const [kx, ky] = map(k.value);
			w.open('keyframe').text('when', flicksToFrames(k.time, rate));
			w.open('value').text('horiz', exactNum(kx)).text('vert', exactNum(ky)).close();
			this.interp(k.interpolation);
			w.close();
		}
		w.close();
	}

	genericEffect(c: IClip, e: IClip['effects'][number], kind: 'video' | 'audio', rate: Rate): void {
		const where = { kind: 'effect' as const, id: e.id, name: e.effectId, frame: frameOf(c.start, rate) };
		if (e.effectId === 'jasper.crop') {
			this.openEffect('Crop', 'crop', 'motion', 'motion', 'video', e.enabled);
			for (const k of ['left', 'right', 'top', 'bottom'] as const) {
				const a = (e.params[k] as Animatable<number> | undefined) ?? anim(0);
				this.numParam(k, k[0]!.toUpperCase() + k.slice(1), 0, 100, a, rate, (v) => v);
			}
			const fe = e.params.feather as Animatable<number> | undefined;
			if (fe) this.numParam('edgefeather', 'Edge Feather', 0, 1000, fe, rate, (v) => v);
			this.closeEffect();
			return;
		}
		const spec = effectSpecOf(e.effectId);
		if (!spec) {
			this.report.warn(`unknown effect "${e.effectId}" on clip "${c.name}" was not exported`, {
				subject: where,
				instead: 'nothing',
			});
			return;
		}
		this.report.info(
			`effect "${spec.label}" on clip "${c.name}" is written as a filter with its JasperEditor id; other applications ignore it`,
			{
				subject: { ...where, name: spec.label },
				instead: `a "${spec.label}" filter (JasperEditor id ${spec.id})`,
			},
		);
		this.openEffect(spec.label, spec.id, spec.category, 'filter', kind, e.enabled);
		for (const ps of spec.params) {
			const a = e.params[ps.name];
			if (!a) continue;
			const v = a.value;
			if (typeof v === 'number')
				this.numParam(
					ps.name,
					ps.label,
					ps.range?.min ?? -1e6,
					ps.range?.max ?? 1e6,
					a as Animatable<number>,
					rate,
					(x) => x,
				);
			else if (Array.isArray(v) && v.length === 2) {
				this.pointParam(ps.name, ps.label, a as Animatable<Vec2>, rate, (p) => [p[0], p[1]]);
			} else if (typeof v === 'boolean') this.simpleParam(ps.name, ps.label, boolStr(v));
			else if (typeof v === 'string') this.simpleParam(ps.name, ps.label, v);
			else if (Array.isArray(v) && v.length === 4) {
				this.w.open('parameter').text('parameterid', ps.name).text('name', ps.label);
				writeColor(this.w, v as number[]);
				this.w.close();
			} else
				this.report.warn(
					`parameter "${ps.label}" of effect "${spec.label}" on clip "${c.name}" cannot be written to Final Cut Pro XML`,
					{
						subject: where,
						instead: 'the parameter default',
					},
				);
		}
		this.closeEffect();
	}
}

function hasContent(list: IBinEntry[], seqs: Set<string>, media: Set<string>): boolean {
	const stack = [...list];
	let n = 0;
	while (stack.length && n++ < 100_000) {
		const e = stack.pop()!;
		if (e.type === 'bin') stack.push(...e.children);
		else if (e.type === 'sequence' ? seqs.has(e.id) : media.has(e.id)) return true;
	}
	return false;
}

function isDefaultMotion(
	t: Transform,
	fw: number,
	fh: number,
	src: { width: number; height: number },
): boolean {
	const anim = [t.position, t.anchor, t.scale, t.rotation, t.scaleWidth].some((a) => a.keyframes.length);
	return (
		!anim &&
		Math.abs(t.position.value[0] - fw / 2) < 1e-9 &&
		Math.abs(t.position.value[1] - fh / 2) < 1e-9 &&
		Math.abs(t.anchor.value[0] - src.width / 2) < 1e-9 &&
		Math.abs(t.anchor.value[1] - src.height / 2) < 1e-9 &&
		t.scale.value === 100 &&
		t.rotation.value === 0 &&
		(t.uniformScale || t.scaleWidth.value === 100) &&
		!t.flipH &&
		!t.flipV
	);
}

function writeMarkers(w: XmlWriter, markers: readonly IMarker[], rate: Rate): void {
	for (const m of markers) {
		w.open('marker').text('comment', m.comment).text('name', m.name);
		const i = flicksToFrames(m.start, rate);
		w.text('in', i).text('out', m.duration > 0 ? flicksToFrames(m.start + m.duration, rate) : -1);
		w.text('color', labelName(m.color));
		w.close();
	}
}

/** Shortest decimal that reads back as the same double (no exponent). */
function exactNum(v: number): string {
	if (!Number.isFinite(v)) return '0';
	if (Number.isInteger(v)) return String(v);
	const s = String(v);
	if (!/e/i.test(s)) return s;
	return v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** Rounds a converted value to 1e-9 (undoes float noise of the unit conversions). */
function round9(v: number): number {
	const r = Math.round(v * 1e9) / 1e9;
	return Object.is(r, -0) ? 0 : r;
}
