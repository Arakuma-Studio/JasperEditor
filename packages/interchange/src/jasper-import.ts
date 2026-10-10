// Interchange model → a JasperEditor project fragment (the import side): bins, media items (resolved assets or
// offline placeholders), synthetic sources, sequences with tracks, clips, transitions, links and markers. The
// fragment is applied by the `project.importTimeline` command (one undoable transaction).
import {
	type Animatable,
	type Clip,
	createRandomIdSource,
	defaultLabelForMedia,
	defaultTransform,
	type FontRef,
	type IdSource,
	isAllowedSequenceRate,
	isRemapped,
	isValidId,
	type LabelColor,
	type LinkGroup,
	type MediaAsset,
	type MediaStream,
	type MulticamAngle,
	type MulticamSource,
	makeSequenceSettings,
	nearestAllowedRate,
	type ProjectItem,
	remapFitDuration,
	type Sequence,
	type SyntheticSource,
	type TimedClip,
	type Track,
	type Transcript,
	type Transform,
	type Transition,
	timeMapToRemap,
	transitionSpec,
} from '@jasper/project';
import type { IBinEntry, IClip, IMedia, IProject, ISequence, ITrack, Rate } from './model.ts';
import { extension, fileName } from './paths.ts';
import type { Report } from './report.ts';
import {
	flicksPerFrame,
	flicksToFrames,
	formatTc,
	framesToFlicks,
	parseTc,
	supportsDropFrame,
} from './time.ts';

/** A media file the document references that is not (yet) linked: the fragment holds an offline placeholder. */
export type MissingMedia = {
	/** Asset id in the fragment (`med_…`). */
	mediaId: string;
	name: string;
	/** Path the document gives (absolute after resolution), or null. */
	path: string | null;
	kind: MediaAsset['kind'];
	durationFlicks: number | null;
	/** Why it is offline. */
	reason: 'no-path' | 'not-found' | 'offline-in-document' | 'unresolved';
};

export type JasperFragment = {
	name: string;
	/** Bins (with their children), media items, synthetic items and sequence items. */
	items: ProjectItem[];
	/** The fragment's top-level entries (added to the destination bin, in order). */
	rootItems: string[];
	media: MediaAsset[];
	synthetics: SyntheticSource[];
	sequences: Sequence[];
	fonts: FontRef[];
	transcripts: Transcript[];
	/** Sequence ids of the document's timelines (nested ones excluded). */
	topSequences: string[];
	/** Caption tracks to add to the fragment's sequences (applied with `caption.import`; times in frames). */
	captions: FragmentCaptions[];
	missing: MissingMedia[];
};

export type FragmentCaptions = {
	sequenceId: string;
	name: string | null;
	language?: string;
	cues: { start: number; end: number; text: string; speaker?: string | null; settings?: string }[];
};

export type ToJasperOptions = {
	ids?: IdSource;
	now?: string;
	/** Assets the caller resolved (registered files), by IR media id. The rest become offline placeholders. */
	assets?: Readonly<Record<string, MediaAsset>>;
	/** IR media ids the caller looked for on disk and did not find (reported as `not-found`). */
	notFound?: ReadonlySet<string>;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const anim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

/** FNV-1a of a string (placeholder fingerprints are stable per document reference). */
function hash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** The offline placeholder asset of an interchange media reference. */
export function placeholderAsset(
	m: IMedia,
	id: string,
	now: string,
	usage: { video: boolean; audio: boolean },
	fallback: { width: number; height: number; rate: Rate },
): MediaAsset {
	const kind: MediaAsset['kind'] =
		m.kind === 'generator' ? 'video' : m.kind === 'audio' && usage.video ? 'video' : m.kind;
	const streams: MediaStream[] = [];
	const wantVideo =
		kind !== 'audio' && (!!m.video || usage.video || kind === 'image' || kind === 'animated-image');
	if (wantVideo) {
		const v = m.video ?? { width: fallback.width, height: fallback.height, rate: fallback.rate };
		streams.push({
			index: 0,
			type: 'video',
			codec: v.codec ?? '',
			width: Math.max(1, Math.round(v.width) || fallback.width),
			height: Math.max(1, Math.round(v.height) || fallback.height),
			pixelAspect: v.pixelAspect ? { ...v.pixelAspect } : { num: 1, den: 1 },
			frameRate: { ...v.rate },
			pixelFormat: '',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
			browserDecodable: null,
		});
	}
	if ((m.audio || usage.audio) && kind !== 'image' && kind !== 'animated-image') {
		const a = m.audio ?? { sampleRate: 48000, channels: 2 };
		const n = Math.max(1, a.streams ?? 1);
		for (let k = 0; k < n; k++)
			streams.push({
				index: streams.length,
				type: 'audio',
				codec: '',
				sampleRate: Math.max(1, Math.round(a.sampleRate) || 48000),
				channels: Math.max(1, Math.round(a.channels) || 2),
				channelLayout: (a.channels ?? 2) === 1 ? 'mono' : (a.channels ?? 2) === 2 ? 'stereo' : '',
			});
	}
	const tc = m.timecode ? formatTc(m.timecode.frames, m.timecode.rate, m.timecode.dropFrame) : null;
	return {
		id,
		kind,
		fingerprint: `pending:interchange:${hash(`${m.path ?? ''}|${m.name}|${m.url ?? ''}`)}`,
		originalName: m.path ? fileName(m.path) : m.name,
		sizeBytes: Math.max(0, Math.round(m.sizeBytes ?? 0)),
		container: m.path ? extension(m.path) : '',
		probe: {
			durationFlicks: kind === 'image' ? null : (m.duration ?? null),
			startTimecode: tc,
			streams,
			rotationDegrees: 0,
			hasAlpha: !!m.video?.alpha,
			variableFrameRate: false,
		},
		locators: [
			...(m.path ? [{ type: 'path' as const, path: m.path, relativeToProject: null }] : []),
			...(m.url ? [{ type: 'url' as const, url: m.url }] : []),
		],
		derivation: null,
		importedAt: now,
	};
}

function syntheticOf(m: IMedia, id: string): SyntheticSource | null {
	const j = m.jasper?.synthetic as SyntheticSource | undefined;
	if (j && typeof j === 'object' && typeof j.kind === 'string') return { ...clone(j), id } as SyntheticSource;
	const g = m.generator;
	if (!g) return null;
	switch (g.kind) {
		case 'black':
			return { id, kind: 'black-video' };
		case 'transparent':
			return { id, kind: 'transparent' };
		case 'color':
			return { id, kind: 'color-matte', color: [...g.color] as [number, number, number, number] };
		case 'bars-and-tone':
			return { id, kind: 'bars-and-tone', toneHz: g.toneHz, toneDb: g.toneDb };
		case 'counting-leader':
			return { id, kind: 'counting-leader', style: {} };
	}
}

/** Convert an interchange project into a JasperEditor fragment. */
/**
 * EDL / ALE sources have absolute timecodes; their importers guess each file's start timecode (`jasper.timecodeGuess`).
 * When the engine linked the real file, its probed start timecode replaces the guess and every clip using it is
 * shifted so it shows the same source frames.
 */
function rebaseGuessedTimecodes(p0: IProject, assets: ToJasperOptions['assets'], report: Report): IProject {
	const shift = new Map<string, number>();
	for (const m of Object.values(p0.media)) {
		if (!m.jasper?.timecodeGuess || !m.timecode) continue;
		const a = assets?.[m.id];
		if (!a?.probe.startTimecode) continue;
		const real = parseTc(a.probe.startTimecode, m.timecode.rate);
		if (real === null) continue;
		const d = framesToFlicks(m.timecode.frames, m.timecode.rate) - framesToFlicks(real, m.timecode.rate);
		if (d !== 0) {
			shift.set(m.id, d);
			report.info(
				`"${m.name}" starts at timecode ${a.probe.startTimecode}; its clips were placed from that timecode`,
				{
					subject: { kind: 'media', id: m.id, name: m.name },
				},
			);
		}
	}
	if (!shift.size) return p0;
	const p = clone(p0);
	for (const s of Object.values(p.sequences))
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) {
				const d = c.source.type === 'media' ? shift.get(c.source.mediaId) : undefined;
				if (!d) continue;
				c.sourceIn += d;
				if (c.hold != null) c.hold += d;
				for (const m of c.markers) m.start += d;
			}
	return p;
}

export function toJasper(p0: IProject, opts: ToJasperOptions, report: Report): JasperFragment {
	const p = rebaseGuessedTimecodes(p0, opts.assets, report);
	const ids = opts.ids ?? createRandomIdSource();
	const now = opts.now ?? new Date().toISOString();
	const frag: JasperFragment = {
		name: p.name,
		items: [],
		rootItems: [],
		media: [],
		synthetics: [],
		sequences: [],
		fonts: [],
		transcripts: [],
		topSequences: [],
		captions: [],
		missing: [],
	};

	// ---- which media are used where (placeholders get the streams their clips need)
	const usage = new Map<string, { video: boolean; audio: boolean }>();
	for (const s of Object.values(p.sequences))
		for (const kind of ['video', 'audio'] as const)
			for (const t of s[kind])
				for (const c of t.clips)
					if (c.source.type === 'media') {
						const u = usage.get(c.source.mediaId) ?? { video: false, audio: false };
						u[kind] = true;
						usage.set(c.source.mediaId, u);
					}
	const firstSeq = Object.values(p.sequences)[0];
	const fallback = {
		width: firstSeq?.width ?? 1920,
		height: firstSeq?.height ?? 1080,
		rate: firstSeq?.rate ?? { num: 24, den: 1 },
	};

	// ---- media and synthetics
	const assetOf = new Map<string, MediaAsset>();
	const synOf = new Map<string, SyntheticSource>();
	const itemOf = new Map<string, string>();
	const addMediaItem = (m: IMedia): string | null => {
		const known = itemOf.get(m.id);
		if (known) return known;
		const label = m.label;
		if (m.kind === 'generator' || m.generator) {
			const sid = ids.next('syn');
			const syn = syntheticOf(m, sid);
			if (!syn) return null;
			synOf.set(m.id, syn);
			frag.synthetics.push(syn);
			const itemId = ids.next('itm');
			frag.items.push({
				id: itemId,
				kind: 'synthetic',
				name: m.name || syn.kind,
				syntheticId: sid,
				label: label ?? 'lavender',
				marks: { in: null, out: null },
			});
			itemOf.set(m.id, itemId);
			return itemId;
		}
		const mid = ids.next('med');
		const resolved = opts.assets?.[m.id];
		const fromJasper = m.jasper?.asset as MediaAsset | undefined;
		let asset: MediaAsset;
		if (resolved) asset = { ...clone(resolved), id: mid };
		else if (fromJasper && typeof fromJasper === 'object' && typeof fromJasper.fingerprint === 'string')
			asset = { ...clone(fromJasper), id: mid, derivation: null };
		else {
			asset = placeholderAsset(m, mid, now, usage.get(m.id) ?? { video: false, audio: false }, fallback);
			const reason: MissingMedia['reason'] = !m.path
				? 'no-path'
				: opts.notFound?.has(m.id)
					? 'not-found'
					: m.offline
						? 'offline-in-document'
						: 'unresolved';
			frag.missing.push({
				mediaId: mid,
				name: m.name,
				path: m.path,
				kind: asset.kind,
				durationFlicks: asset.probe.durationFlicks,
				reason,
			});
		}
		assetOf.set(m.id, asset);
		frag.media.push(asset);
		const itemId = ids.next('itm');
		const jItem = m.jasper?.item as { marks?: unknown } | undefined;
		frag.items.push({
			id: itemId,
			kind: 'media',
			name: m.name || asset.originalName,
			mediaId: mid,
			label: label ?? defaultLabelForMedia(asset),
			marks:
				jItem && typeof jItem.marks === 'object' && jItem.marks
					? (clone(jItem.marks) as never)
					: { in: null, out: null },
		});
		itemOf.set(m.id, itemId);
		return itemId;
	};

	// ---- sequences: ids first (nests refer to each other)
	const seqIdOf = new Map<string, string>();
	const seqItemOf = new Map<string, string>();
	for (const s of Object.values(p.sequences)) seqIdOf.set(s.id, ids.next('seq'));
	const seqRate = new Map<string, Rate>();
	for (const s of Object.values(p.sequences)) {
		let rate: Rate = { ...s.rate };
		if (!isAllowedSequenceRate(rate)) {
			const r = nearestAllowedRate(rate);
			report.warn(
				`sequence "${s.name}" uses ${(rate.num / rate.den).toFixed(3)} fps, which JasperEditor sequences do not support; converted to ${(r.num / r.den).toFixed(3)} fps`,
				{ subject: { kind: 'sequence', name: s.name }, instead: `${(r.num / r.den).toFixed(3)} fps` },
			);
			rate = r;
		}
		seqRate.set(s.id, rate);
	}

	const convertSequence = (s: ISequence): Sequence => {
		const id = seqIdOf.get(s.id)!;
		const rate = seqRate.get(s.id)!;
		const F = flicksPerFrame(rate);
		let rounded = 0;
		const toFrames = (t: number) => {
			const f = flicksToFrames(t, rate);
			if (framesToFlicks(f, rate) !== t) rounded++;
			return f;
		};
		const jSettings = s.jasper?.settings as Partial<Sequence['settings']> | undefined;
		const width = Math.min(8192, Math.max(16, Math.round(s.width) || 1920));
		const height = Math.min(8192, Math.max(16, Math.round(s.height) || 1080));
		const settings = makeSequenceSettings(width - (width % 2), height - (height % 2), rate);
		if (jSettings && typeof jSettings === 'object') {
			if (Array.isArray(jSettings.backgroundColor) && jSettings.backgroundColor.length === 4)
				settings.backgroundColor = [...jSettings.backgroundColor] as typeof settings.backgroundColor;
		}
		if (width !== settings.width || height !== settings.height)
			report.info(
				`sequence "${s.name}" frame size ${s.width}×${s.height} adjusted to ${settings.width}×${settings.height}`,
			);
		settings.dropFrame = s.dropFrame && supportsDropFrame(rate);
		settings.startTimecodeFrames = Math.max(0, Math.round(s.startTimecode) || 0);
		if (s.sampleRate === 44100 || s.sampleRate === 48000 || s.sampleRate === 96000)
			settings.audioSampleRate = s.sampleRate;
		else if (s.sampleRate)
			report.info(`sequence "${s.name}" audio at ${s.sampleRate} Hz is mixed at 48000 Hz`);
		if (s.pixelAspect && s.pixelAspect.num !== s.pixelAspect.den)
			report.warn(
				`sequence "${s.name}" has non-square pixels (${s.pixelAspect.num}:${s.pixelAspect.den}); imported with square pixels`,
				{
					subject: { kind: 'sequence', name: s.name },
					instead: 'square pixels',
				},
			);
		const jMaster = s.jasper?.master as Sequence['master'] | undefined;
		const seq: Sequence = {
			id,
			settings,
			videoTracks: [],
			audioTracks: [],
			captionTracks: [],
			master:
				jMaster && typeof jMaster === 'object' && jMaster.volumeDb
					? clone(jMaster)
					: { volumeDb: anim(0), effects: [] },
			clips: {},
			transitions: {},
			links: {},
			groups: {},
			markers: [],
			inPoint: s.inPoint != null ? Math.max(0, toFrames(s.inPoint)) : null,
			outPoint: s.outPoint != null ? Math.max(0, toFrames(s.outPoint)) : null,
			workArea: null,
		};
		if (seq.inPoint !== null && seq.outPoint !== null && seq.outPoint <= seq.inPoint) seq.outPoint = null;
		for (const m of s.markers)
			seq.markers.push({
				...((m.jasper as object) ?? {}),
				id: ids.next('mrk'),
				frame: Math.max(0, toFrames(m.start)),
				duration: Math.max(0, toFrames(m.start + m.duration) - toFrames(m.start)),
				name: m.name,
				comment: m.comment,
				color: m.color,
				type: m.type ?? 'comment',
				...(m.url ? { url: m.url } : {}),
				author: 'user',
			} as Sequence['markers'][number]);
		seq.markers.sort((a, b) => a.frame - b.frame);

		const linkMembers = new Map<string, string[]>();
		const groupMembers = new Map<string, string[]>();
		const clipIdOf = new Map<string, string>();

		const makeTrack = (kind: Track['kind'], t: ITrack | null): Track => {
			const j = (t?.jasper ?? {}) as Partial<Track>;
			const base: Track = {
				id: ids.next('trk'),
				kind,
				name: t?.name ?? null,
				locked: !!t?.locked,
				syncLock: j.syncLock ?? true,
			};
			if (kind === 'video') return { ...base, output: t ? t.enabled : true };
			if (kind === 'audio')
				return {
					...base,
					mute: t ? !t.enabled : false,
					solo: !!t?.solo,
					volumeDb: t?.volumeDb ? clone(t.volumeDb) : anim(0),
					pan: t?.pan ? clone(t.pan) : anim(0),
					channelFormat: j.channelFormat === 'mono' ? 'mono' : 'stereo',
					effects: Array.isArray(j.effects) ? clone(j.effects) : [],
				};
			return {
				...base,
				captionFormat: 'open',
				visible: t ? t.enabled : true,
				...(j.styleDefaults ? { styleDefaults: clone(j.styleDefaults) } : {}),
			};
		};

		const placeClips = (t: ITrack, track: Track, list: Clip[]) => {
			let prevEnd = 0;
			for (const c of t.clips) {
				const made = convertClip(c, track, toFrames, rate);
				for (const clip of made) {
					if (clip.start < prevEnd) {
						const cut = prevEnd - clip.start;
						if (clip.duration - cut < 1) {
							report.warn(
								`clip "${clip.name}" overlaps the clip before it after rounding to frames and was dropped`,
								{
									subject: { kind: 'clip', name: clip.name, frame: clip.start },
								},
							);
							continue;
						}
						if (!clip.speed.reverse) clip.sourceIn += Math.round(cut * F * clip.speed.rate);
						clip.start = prevEnd;
						clip.duration -= cut;
					}
					seq.clips[clip.id] = clip;
					list.push(clip);
					prevEnd = clip.start + clip.duration;
				}
				const first = made[0];
				if (first) {
					clipIdOf.set(c.id, first.id);
					if (c.link) linkMembers.set(c.link, [...(linkMembers.get(c.link) ?? []), first.id]);
					if (c.group)
						groupMembers.set(c.group, [...(groupMembers.get(c.group) ?? []), ...made.map((x) => x.id)]);
				}
			}
		};

		const trackClips = new Map<string, Clip[]>();
		const transitionsOf: { t: ITrack; track: Track }[] = [];
		const videoAt: Track[] = [];
		const audioAt: Track[] = [];
		for (const t of s.video) {
			const caption = (t.jasper as { captionTrack?: boolean } | undefined)?.captionTrack === true;
			const track = makeTrack(caption ? 'caption' : 'video', t);
			videoAt.push(track);
			(caption ? seq.captionTracks : seq.videoTracks).push(track);
			const list: Clip[] = [];
			placeClips(t, track, list);
			trackClips.set(track.id, list);
			transitionsOf.push({ t, track });
		}
		for (const t of s.audio) {
			const track = makeTrack('audio', t);
			audioAt.push(track);
			seq.audioTracks.push(track);
			const list: Clip[] = [];
			placeClips(t, track, list);
			trackClips.set(track.id, list);
			transitionsOf.push({ t, track });
		}
		if (seq.videoTracks.length === 0) seq.videoTracks.push(makeTrack('video', null));
		if (seq.audioTracks.length === 0) seq.audioTracks.push(makeTrack('audio', null));
		if (s.multicam) {
			const mc = multicamIn(s, videoAt, audioAt);
			if (mc) seq.multicam = mc;
			else
				report.warn(`the cameras of multi-camera sequence "${s.name}" do not resolve to its tracks`, {
					subject: { kind: 'sequence', name: s.name },
					instead: 'an ordinary sequence (its clips play as nests)',
				});
		}

		// ---- links (at most one video member per group) and groups
		for (const [, members] of linkMembers) {
			const valid = members.filter((m) => seq.clips[m]);
			const video = valid.filter((m) => seq.videoTracks.some((t) => t.id === seq.clips[m]!.trackId));
			const keep = [...video.slice(0, 1), ...valid.filter((m) => !video.includes(m))];
			if (video.length > 1)
				report.info('a link group with several video clips was linked with its first video clip only');
			if (keep.length < 2) continue;
			const lid = ids.next('lnk');
			const g: LinkGroup = { id: lid, members: keep };
			seq.links[lid] = g;
			for (const m of keep) seq.clips[m]!.linkId = lid;
		}
		for (const [, members] of groupMembers) {
			const valid = [...new Set(members.filter((m) => seq.clips[m]))];
			if (valid.length < 2) continue;
			const gid = ids.next('grp');
			seq.groups[gid] = { id: gid, members: valid };
			for (const m of valid) seq.clips[m]!.groupId = gid;
		}

		// ---- transitions
		const usedEdge = new Set<string>();
		for (const { t, track } of transitionsOf) {
			for (const x of t.transitions) {
				const out = x.from ? clipIdOf.get(x.from) : undefined;
				const inc = x.to ? clipIdOf.get(x.to) : undefined;
				const outClip = out ? seq.clips[out] : undefined;
				const incClip = inc ? seq.clips[inc] : undefined;
				const name = transitionSpec(x.effectId)?.label ?? x.effectId;
				const drop = (why: string) =>
					report.warn(
						`transition "${name}" at frame ${Math.round(x.start / F)} ${why}; it was not imported`,
						{
							subject: { kind: 'transition', name, frame: Math.round(x.start / F) },
						},
					);
				if (!outClip && !incClip) {
					drop('has no clip on its track');
					continue;
				}
				const spec = transitionSpec(x.effectId);
				if (!spec) {
					drop('is unknown');
					continue;
				}
				const audio = track.kind === 'audio';
				if ((spec.appliesTo === 'audio') !== audio) {
					drop(`is a${audio ? ' video' : 'n audio'} transition on a${audio ? 'n audio' : ' video'} track`);
					continue;
				}
				let duration = Math.max(1, toFrames(x.start + x.duration) - toFrames(x.start));
				let alignment = x.alignment;
				if (outClip && incClip) {
					if (outClip.start + outClip.duration !== incClip.start) {
						drop('joins clips that are not adjacent');
						continue;
					}
					// Derive the alignment from where the span sits around the cut.
					const cut = incClip.start;
					const s0 = toFrames(x.start);
					alignment = s0 >= cut ? 'start-at-cut' : s0 + duration <= cut ? 'end-at-cut' : 'center';
					if (alignment === 'center' && cut - s0 !== duration >> 1)
						report.info(
							`transition "${name}" at frame ${s0} is off-centre on its cut; JasperEditor centres it (${duration >> 1} frames before the cut)`,
						);
					duration = Math.min(duration, outClip.duration, incClip.duration);
				} else {
					const c = (outClip ?? incClip)!;
					alignment = outClip ? 'end-at-cut' : 'start-at-cut';
					duration = Math.min(duration, c.duration);
				}
				const edges = [out ? `${out}:out` : null, inc ? `${inc}:in` : null].filter((e): e is string => !!e);
				if (edges.some((e) => usedEdge.has(e))) {
					drop('shares a clip edge with another transition');
					continue;
				}
				for (const e of edges) usedEdge.add(e);
				const tid = ids.next('trn');
				const tr: Transition = {
					...((x.jasper as object) ?? {}),
					id: tid,
					trackId: track.id,
					effectId: spec.id,
					effectVersion: spec.version,
					outgoingClipId: out ?? null,
					incomingClipId: inc ?? null,
					duration,
					alignment,
					params: clone(x.params) as Transition['params'],
				};
				seq.transitions[tid] = tr;
			}
		}
		if (rounded)
			report.info(
				`${rounded} time${rounded === 1 ? '' : 's'} in "${s.name}" were not on frame boundaries and were rounded to frames`,
			);
		return seq;
	};

	// ---- clips
	const convertClip = (c: IClip, track: Track, toFrames: (t: number) => number, rate: Rate): Clip[] => {
		const F = flicksPerFrame(rate);
		const start = Math.max(0, toFrames(c.start));
		const duration = Math.max(1, toFrames(c.start + c.duration) - start);
		const j = (c.jasper ?? null) as (Clip & Record<string, unknown>) | null;
		const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: start };
		let speed = Math.abs(c.speed) || 1;
		if (speed < 0.01 || speed > 100) {
			const s2 = Math.min(100, Math.max(0.01, speed));
			report.warn(
				`clip "${c.name}" plays at ${(speed * 100).toFixed(2)} %; JasperEditor supports 1 %–10000 %`,
				{
					subject: where,
					instead: `${(s2 * 100).toFixed(2)} %`,
				},
			);
			speed = s2;
		}
		const common = {
			id: ids.next('clp'),
			trackId: track.id,
			start,
			duration,
			sourceIn: Math.max(0, Math.round(c.sourceIn)),
			speed: { rate: speed, reverse: !!c.reverse, maintainPitch: j?.speed?.maintainPitch ?? true },
			name: c.name,
			label: (c.label ?? j?.label ?? (track.kind === 'audio' ? 'caribbean' : 'iris')) as LabelColor,
			enabled: c.enabled,
			linkId: null,
			groupId: null,
			markers: c.markers.map((m) => ({
				...((m.jasper as object) ?? {}),
				id: ids.next('mrk'),
				flicks: Math.max(0, Math.round(m.start)),
				duration: Math.max(0, Math.round(m.duration)),
				name: m.name,
				comment: m.comment,
				color: m.color,
				type: m.type ?? 'comment',
				...(m.url ? { url: m.url } : {}),
				author: 'user' as const,
			})),
		};
		const effects = c.effects.filter((fx) => {
			if (fx && typeof fx.effectId === 'string') return true;
			report.warn(`an effect of clip "${c.name}" is malformed and was skipped`, { subject: where });
			return false;
		});
		const reid = <T extends { id: string }>(list: T[], prefix: 'fx'): T[] =>
			list.map((x) => ({ ...clone(x), id: isValidId(x.id) ? x.id : ids.next(prefix) }));
		// Workstream `time`: a time map becomes Time Remapping (video and nested pictures); audio cannot be remapped.
		const hasMap = !!c.timeMap && c.timeMap.length >= 2 && c.hold == null;
		const remapFields = (): Record<string, unknown> => {
			// OTIO carries JasperEditor's own remap in its metadata (the format has no variable speed).
			const jr = (j as { timeRemap?: { enabled?: boolean } } | null)?.timeRemap;
			if (!hasMap && jr?.enabled && j && typeof j.sourceIn === 'number')
				return {
					timeRemap: reidKeys(clone(jr) as { keyframes?: { id: string }[] }),
					sourceIn: j.sourceIn,
					speed: { ...common.speed, rate: j.speed?.rate ?? 1, reverse: false },
				};
			if (!hasMap) return {};
			const r = timeMapToRemap(c.timeMap!, common.sourceIn, () => ids.next('kf'), speed);
			if (r.approximated)
				report.info(`the eased speed changes of clip "${c.name}" became symmetric speed transitions`, {
					subject: where,
				});
			return { timeRemap: r.remap, speed: { ...common.speed, reverse: false } };
		};
		const reidKeys = <T extends { keyframes?: { id: string }[] }>(r: T): T => {
			for (const k of r.keyframes ?? []) k.id = ids.next('kf');
			return r;
		};
		const interpField = (): Record<string, unknown> =>
			c.frameSampling && c.frameSampling !== 'frame-sampling'
				? { timeInterpolation: c.frameSampling }
				: typeof (j as { timeInterpolation?: unknown } | null)?.timeInterpolation === 'string'
					? { timeInterpolation: (j as { timeInterpolation: string }).timeInterpolation }
					: {};
		if (hasMap && track.kind === 'audio') {
			const a = c.timeMap![0]!;
			const b = c.timeMap![c.timeMap!.length - 1]!;
			const avg = (b.value - a.value) / Math.max(1, b.time - a.time);
			report.warn(
				`the variable speed of audio clip "${c.name}" is not supported (Premiere keeps audio at 100 %)`,
				{
					subject: where,
					instead: 'its average speed',
				},
			);
			common.speed = {
				...common.speed,
				rate: Math.min(100, Math.max(0.01, Math.abs(avg) || 1)),
				reverse: avg < 0,
			};
			common.sourceIn = Math.max(0, Math.round(Math.min(a.value, b.value)));
		}

		// JasperEditor clips without media (OTIO metadata round trip): restore the clip itself.
		if (c.source.type === 'none') {
			if (j && typeof j.kind === 'string' && j.kind !== 'video' && j.kind !== 'audio') {
				const restored = { ...clone(j), ...common } as Clip & Record<string, unknown>;
				const want = j.kind === 'captions' ? 'caption' : j.kind === 'nest-audio' ? 'audio' : 'video';
				if (want !== track.kind) {
					report.warn(
						`${c.source.what} "${c.name}" does not belong on a ${track.kind} track and was skipped`,
						{ subject: where },
					);
					return [];
				}
				return [restored as Clip];
			}
			report.warn(`${c.source.what} "${c.name}" has no media and was skipped`, { subject: where });
			return [];
		}

		if (c.source.type === 'sequence') {
			const sid = seqIdOf.get(c.source.sequenceId);
			if (!sid) {
				report.warn(`clip "${c.name}" refers to a missing nested sequence and was skipped`, {
					subject: where,
				});
				return [];
			}
			const mcSel =
				c.multicam && typeof c.multicam.angle === 'string' && p.sequences[c.source.sequenceId]?.multicam
					? { multicam: { enabled: c.multicam.enabled !== false, angle: c.multicam.angle } }
					: {};
			if (track.kind === 'audio')
				return [
					{
						...common,
						...mcSel,
						kind: 'nest-audio',
						sequenceId: sid,
						gainDb: c.gainDb ?? 0,
						volumeDb: c.volumeDb ? clone(c.volumeDb) : anim(0),
						pan: c.pan ? clone(c.pan) : anim(0),
						effects: reid(effects, 'fx'),
					} as Clip,
				];
			const inner = p.sequences[c.source.sequenceId]!;
			return [
				{
					...common,
					...mcSel,
					kind: 'nest-video',
					sequenceId: sid,
					...visual(c, { width: inner.width, height: inner.height }),
					effects: reid(effects, 'fx'),
					...remapFields(),
				} as Clip,
			];
		}

		const m = p.media[c.source.mediaId];
		if (!m) {
			report.warn(`clip "${c.name}" refers to media the document does not define and was skipped`, {
				subject: where,
			});
			return [];
		}
		addMediaItem(m);
		if (m.kind === 'generator' || m.generator) {
			const syn = synOf.get(m.id);
			if (!syn) {
				report.warn(`clip "${c.name}" uses an unsupported generator and was skipped`, { subject: where });
				return [];
			}
			if (track.kind !== 'video') {
				if (syn.kind !== 'bars-and-tone' && syn.kind !== 'counting-leader') {
					report.warn(`generator clip "${c.name}" on an audio track has no sound and was skipped`, {
						subject: where,
					});
					return [];
				}
				return [
					{
						...common,
						kind: 'synthetic-audio',
						syntheticId: syn.id,
						gainDb: c.gainDb ?? 0,
						volumeDb: c.volumeDb ? clone(c.volumeDb) : anim(0),
						pan: c.pan ? clone(c.pan) : anim(0),
						effects: reid(effects, 'fx'),
					} as Clip,
				];
			}
			return [
				{
					...common,
					kind: 'solid',
					syntheticId: syn.id,
					...visual(c, { width: seqFrame.width, height: seqFrame.height }),
					effects: reid(effects, 'fx'),
				} as Clip,
			];
		}
		const asset = assetOf.get(m.id)!;
		const dur = asset.probe.durationFlicks;
		const bounded = asset.kind === 'video' || asset.kind === 'audio';
		const fit = (clip: Clip): Clip | null => {
			if (!bounded || dur === null) return clip;
			if (isRemapped(clip as TimedClip)) {
				const n = remapFitDuration(clip as TimedClip, clip.duration, rate, dur);
				if (n < clip.duration) {
					report.warn(
						`clip "${c.name}" uses more media than the file holds; it was shortened by ${clip.duration - n} frames`,
						{ subject: where, instead: `a clip of ${n} frames` },
					);
					clip.duration = n;
				}
				return clip;
			}
			const span = Math.round(clip.duration * F * clip.speed.rate);
			if (clip.sourceIn >= dur) {
				report.warn(`clip "${c.name}" starts after the end of its media and was skipped`, { subject: where });
				return null;
			}
			if (clip.sourceIn + span > dur + F * clip.speed.rate) {
				const frames = Math.max(1, Math.floor((dur - clip.sourceIn) / (F * clip.speed.rate)));
				report.warn(
					`clip "${c.name}" uses more media than the file holds; it was shortened by ${clip.duration - frames} frames`,
					{
						subject: where,
						instead: `a clip of ${frames} frames`,
					},
				);
				clip.duration = frames;
			}
			return clip;
		};
		if (track.kind === 'audio') {
			const streams = asset.probe.streams.filter((x) => x.type === 'audio');
			if (!streams.length) {
				report.warn(`audio clip "${c.name}" uses media without audio and was skipped`, { subject: where });
				return [];
			}
			const sIx = Math.min(streams.length - 1, Math.max(0, c.channels?.streamIndex ?? 0));
			const st = streams[sIx]!;
			const chans = st.type === 'audio' ? st.channels : 2;
			const map = (c.channels?.map ?? (chans >= 2 ? [0, 1] : [0])).filter((x) => x >= 0 && x < chans);
			let clip: Clip = {
				...common,
				kind: 'audio',
				mediaId: asset.id,
				channels: { streamIndex: st.index, map: map.length ? map : [0] },
				gainDb: c.gainDb ?? 0,
				volumeDb: c.volumeDb ? clone(c.volumeDb) : anim(0),
				pan: c.pan ? clone(c.pan) : anim(0),
				effects: reid(effects, 'fx'),
			} as Clip;
			if (c.hold != null) {
				report.warn(`frame hold on audio clip "${c.name}" has no JasperEditor equivalent`, {
					subject: where,
					instead: 'the audio at 100 % speed from the hold point',
				});
				clip = {
					...clip,
					sourceIn: Math.max(0, Math.round(c.hold)),
					speed: { ...clip.speed, rate: 1, reverse: false },
				};
			}
			const f = fit(clip);
			return f ? [f] : [];
		}
		if (asset.kind === 'audio') {
			report.warn(`clip "${c.name}" on a video track uses audio-only media and was skipped`, {
				subject: where,
			});
			return [];
		}
		const vs = asset.probe.streams.find((x) => x.type === 'video');
		const box =
			vs && vs.type === 'video'
				? { width: vs.width, height: vs.height }
				: { width: seqFrame.width, height: seqFrame.height };
		const kind =
			asset.kind === 'image' ? 'still' : asset.kind === 'animated-image' ? 'animated-image' : 'video';
		const vis = visual(c, box);
		const make = (over: Partial<Clip>): Clip =>
			({
				...common,
				kind,
				mediaId: asset.id,
				...(kind === 'video' ? { videoStreamIndex: vs?.index ?? 0 } : {}),
				...(kind === 'animated-image' ? { loop: (j as { loop?: boolean } | null)?.loop ?? false } : {}),
				...vis,
				effects: reid(effects, 'fx'),
				...(j?.trackers ? { trackers: clone(j.trackers) } : {}),
				...(kind === 'video' ? { ...remapFields(), ...interpField() } : {}),
				...over,
			}) as Clip;
		if (c.hold != null && kind !== 'still') {
			const hold = Math.max(0, Math.round(c.hold));
			const held = make({
				frameHold: {
					flicks: hold,
					...((j?.frameHold as { holdFilters?: boolean } | undefined)?.holdFilters
						? { holdFilters: true }
						: {}),
				},
			} as Partial<Clip>);
			// The hold shows one frame; the clip's own range only needs to lie in the media.
			if (dur !== null && hold >= dur) {
				report.warn(`frame hold of clip "${c.name}" lies after the end of its media; the hold was dropped`, {
					subject: where,
				});
				delete (held as { frameHold?: unknown }).frameHold;
			}
			const f = fit(held);
			return f ? [f] : [];
		}
		if (c.hold != null)
			report.info(`frame hold on still clip "${c.name}" is implicit and was dropped`, { subject: where });
		const f = fit(make({}));
		return f ? [f] : [];
	};

	let seqFrame = { width: 1920, height: 1080 };
	const visual = (c: IClip, box: { width: number; height: number }) => {
		const t: Transform = c.transform ? clone(c.transform) : defaultTransform(box, seqFrame, 'none');
		return {
			transform: t,
			opacity: c.opacity ? clone(c.opacity) : anim(100),
			blendMode: c.blendMode ?? 'normal',
		};
	};

	for (const s of Object.values(p.sequences)) {
		seqFrame = { width: s.width, height: s.height };
		frag.sequences.push(convertSequence(s));
		const rate = seqRate.get(s.id)!;
		for (const ct of s.captions ?? []) {
			const cues = ct.cues
				.map((q) => ({
					start: Math.max(0, flicksToFrames(q.start, rate)),
					end: flicksToFrames(q.start + q.duration, rate),
					text: q.text,
					...(q.speaker ? { speaker: q.speaker } : {}),
					...(q.settings ? { settings: q.settings } : {}),
				}))
				.filter((q) => q.end > q.start && q.text.trim());
			if (cues.length)
				frag.captions.push({
					sequenceId: seqIdOf.get(s.id)!,
					name: ct.name,
					...(ct.language ? { language: ct.language } : {}),
					cues,
				});
		}
	}
	frag.topSequences = p.top.map((t) => seqIdOf.get(t)).filter((x): x is string => !!x);

	// ---- bins
	const placedSeq = new Set<string>();
	const placedMedia = new Set<string>();
	const seqItem = (s: ISequence): string => {
		const known = seqItemOf.get(s.id);
		if (known) return known;
		const id = ids.next('itm');
		frag.items.push({
			id,
			kind: 'sequence',
			name: s.name || 'Sequence',
			sequenceId: seqIdOf.get(s.id)!,
			label: s.label ?? 'forest',
		});
		seqItemOf.set(s.id, id);
		return id;
	};
	const walk = (entries: IBinEntry[], depth: number): string[] => {
		const out: string[] = [];
		for (const e of entries) {
			if (e.type === 'bin') {
				if (depth > 64) continue;
				const children = walk(e.children, depth + 1);
				const id = ids.next('bin');
				frag.items.push({ id, kind: 'bin', name: e.name || 'Bin', children, label: e.label ?? 'violet' });
				out.push(id);
			} else if (e.type === 'sequence') {
				const s = p.sequences[e.id];
				if (!s || placedSeq.has(e.id)) continue;
				placedSeq.add(e.id);
				out.push(seqItem(s));
			} else {
				const m = p.media[e.id];
				if (!m || placedMedia.has(e.id)) continue;
				const it = addMediaItem(m);
				if (!it) continue;
				placedMedia.add(e.id);
				out.push(it);
			}
		}
		return out;
	};
	frag.rootItems = walk(p.root, 0);
	for (const s of Object.values(p.sequences))
		if (!placedSeq.has(s.id)) {
			placedSeq.add(s.id);
			frag.rootItems.push(seqItem(s));
		}
	for (const [mid, itemId] of itemOf) if (!placedMedia.has(mid)) frag.rootItems.push(itemId);

	// ---- JasperEditor entities carried by OTIO metadata (fonts, transcripts) for restored clips
	for (const s of Object.values(p.sequences)) {
		const ent = s.jasper?.entities as
			| {
					fonts?: FontRef[];
					transcripts?: Transcript[];
					synthetics?: SyntheticSource[];
					media?: MediaAsset[];
			  }
			| undefined;
		if (!ent || typeof ent !== 'object') continue;
		for (const f of ent.fonts ?? []) if (!frag.fonts.some((x) => x.id === f.id)) frag.fonts.push(clone(f));
		for (const t of ent.transcripts ?? [])
			if (!frag.transcripts.some((x) => x.id === t.id)) frag.transcripts.push(clone(t));
		for (const x of ent.synthetics ?? [])
			if (!frag.synthetics.some((y) => y.id === x.id)) frag.synthetics.push(clone(x));
		for (const m of ent.media ?? []) if (!frag.media.some((y) => y.id === m.id)) frag.media.push(clone(m));
	}
	validateReferences(frag, report);
	return frag;
}

/**
 * Clips restored from JasperEditor metadata may reference entities (fonts, transcripts, synthetic sources, bundles,
 * LUT media) the document did not carry: such clips and effects are dropped with a report entry, so the fragment
 * always pastes.
 */
const SYNC = new Set(['in', 'out', 'timecode', 'marker', 'audio']);

/** The IR cameras of a multi-camera source → JasperEditor angles on the created tracks (null when none resolves). */
function multicamIn(s: ISequence, videoAt: Track[], audioAt: Track[]): MulticamSource | null {
	const src = s.multicam!;
	const usedIds = new Set<string>();
	const usedVideo = new Set<string>();
	const angles: MulticamAngle[] = [];
	for (const [i, a] of src.angles.entries()) {
		const vt = a.video === null ? null : videoAt[a.video];
		if (a.video !== null && (vt?.kind !== 'video' || usedVideo.has(vt.id))) continue;
		const audio = [...new Set(a.audio.map((k) => audioAt[k]?.id).filter((x): x is string => !!x))];
		if (!vt && audio.length === 0) continue;
		let id = typeof a.id === 'string' && a.id ? a.id : `angle${i + 1}`;
		while (usedIds.has(id)) id = `${id}_`;
		usedIds.add(id);
		if (vt) usedVideo.add(vt.id);
		angles.push({
			id,
			name: a.name || `Camera ${angles.length + 1}`,
			videoTrackId: vt?.id ?? null,
			audioTrackIds: audio,
			enabled: a.enabled !== false,
		});
	}
	if (!angles.some((a) => a.videoTrackId !== null)) return null;
	const audio = src.audio === 'all' || src.audio === 'switch' ? src.audio : 'camera1';
	return { angles, audio, ...(src.sync && SYNC.has(src.sync) ? { sync: src.sync } : {}) };
}

function validateReferences(frag: JasperFragment, report: Report): void {
	const media = new Set(frag.media.map((m) => m.id));
	const syn = new Set(frag.synthetics.map((m) => m.id));
	const fonts = new Set(frag.fonts.map((m) => m.id));
	const trs = new Set(frag.transcripts.map((m) => m.id));
	const seqs = new Set(frag.sequences.map((m) => m.id));
	const mediaRefsOk = (v: unknown): boolean => {
		const o = v as { mediaId?: unknown } | null;
		return !(
			o &&
			typeof o === 'object' &&
			!Array.isArray(o) &&
			typeof o.mediaId === 'string' &&
			o.mediaId &&
			!media.has(o.mediaId)
		);
	};
	for (const f of frag.fonts)
		if (f.source.type === 'asset' && !media.has(f.source.mediaId)) f.source = { type: 'system' };
	for (const t of frag.transcripts) if (t.mediaId && !media.has(t.mediaId)) t.mediaId = null;
	for (const seq of frag.sequences) {
		for (const c of Object.values(seq.clips) as (Clip & Record<string, unknown>)[]) {
			const missing: string[] = [];
			if (typeof c.mediaId === 'string' && !media.has(c.mediaId)) missing.push('media');
			if (typeof c.syntheticId === 'string' && !syn.has(c.syntheticId)) missing.push('synthetic source');
			if (typeof c.transcriptId === 'string' && !trs.has(c.transcriptId)) missing.push('transcript');
			if (typeof c.sequenceId === 'string' && !seqs.has(c.sequenceId)) missing.push('sequence');
			const font = (c.content as { style?: { fontId?: string } } | undefined)?.style?.fontId;
			if (typeof font === 'string' && !fonts.has(font)) missing.push('font');
			const comp = c.composition as { mediaId?: string } | undefined;
			if (comp?.mediaId && !media.has(comp.mediaId)) missing.push('Remotion bundle');
			if (missing.length) {
				report.warn(
					`clip "${c.name}" needs a ${missing.join(', ')} the document does not carry and was skipped`,
					{
						subject: { kind: 'clip', name: c.name, frame: c.start },
					},
				);
				delete seq.clips[c.id];
				for (const t of Object.values(seq.transitions))
					if (t.outgoingClipId === c.id || t.incomingClipId === c.id) delete seq.transitions[t.id];
				for (const table of [seq.links, seq.groups])
					for (const g of Object.values(table)) {
						g.members = g.members.filter((m) => m !== c.id);
						if (g.members.length < 2) {
							for (const m of g.members) {
								const other = seq.clips[m] as (Clip & Record<string, unknown>) | undefined;
								if (other) {
									if (table === seq.links) other.linkId = null;
									else other.groupId = null;
								}
							}
							delete table[g.id];
						}
					}
				continue;
			}
			const fx = c.effects as { effectId: string; params: Record<string, Animatable<unknown>> }[] | undefined;
			if (Array.isArray(fx)) {
				const keep = fx.filter((e) =>
					Object.values(e.params ?? {}).every(
						(a) => mediaRefsOk(a?.value) && (a?.keyframes ?? []).every((k) => mediaRefsOk(k.value)),
					),
				);
				if (keep.length !== fx.length) {
					report.warn(
						`an effect of clip "${c.name}" references a LUT the document does not carry and was removed`,
						{
							subject: { kind: 'effect', name: c.name, frame: c.start },
						},
					);
					c.effects = keep;
				}
			}
		}
	}
}
