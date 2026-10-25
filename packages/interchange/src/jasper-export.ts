// JasperEditor document → interchange model (the export side). Every JasperEditor entity is kept verbatim in the
// `jasper` fields so formats that can carry metadata (OTIO `metadata.jasper`) restore it exactly; other formats
// map what they can and report the rest.
import {
	type CaptionsClip,
	type Clip,
	captionClipSpeaker,
	captionClipText,
	clipParamMediaIds,
	cueMarkers,
	flicksPerFrame,
	isEnabledMulticamClip,
	isKnownClipKind,
	type MediaAsset,
	type MulticamClip,
	type ProjectDocument,
	type ProjectItem,
	pieceAudioClip,
	pieceVideoClip,
	remapToTimeMap,
	resolveMulticamClip,
	type Sequence,
	type SyntheticSource,
	type TimedClip,
	type Track,
	timeInterpolationOf,
	transitionStartFrame,
	vttSettingsFor,
} from '@jasper/project';
import { anim } from './build.ts';
import { FORMAT_CAPS } from './capabilities.ts';
import type {
	IBinEntry,
	IClip,
	IGenerator,
	IMarker,
	IMedia,
	IMulticamSource,
	IProject,
	ISequence,
	ITrack,
	ITransition,
	Rate,
} from './model.ts';
import type { Format } from './options.ts';
import { isAbsolutePath, kindFromExtension } from './paths.ts';
import type { Report } from './report.ts';
import { parseTc } from './time.ts';

/** A clip rendered to a movie (ProRes 4444 with alpha) by the engine: frame 0 = the clip's first frame. */
export type PrerenderedClip = {
	path: string;
	width: number;
	height: number;
	rate: Rate;
	/** Length of the file (flicks). */
	durationFlicks: number;
	sizeBytes?: number;
};

export type FromJasperOptions = {
	/** The target format (decides which JasperEditor-only data is reported as not carried). */
	format: Format;
	/** Absolute path of a media file (the engine resolves `engine-store` locators); default: its `path` locator. */
	mediaPath?: (asset: MediaAsset) => string | null;
	/** Clips replaced by pre-rendered files, by clip id. */
	prerendered?: Readonly<Record<string, PrerenderedClip>>;
};

/** How reports name JasperEditor clip kinds that have no media. */
export function uncarriedWhat(kind: string): string | null {
	switch (kind) {
		case 'text':
			return 'text clip';
		case 'shape':
			return 'shape clip';
		case 'motion-graphic':
			return 'motion graphic clip';
		case 'composition':
			return 'composition clip';
		case 'captions':
			return 'captions clip';
		case 'adjustment':
			return 'adjustment layer';
		// cameras and lights shape the 3D layers (which are pre-rendered with them); model layers draw in 3D only.
		case 'camera':
			return 'camera';
		case 'light':
			return 'light';
		case 'model':
			return '3D model layer';
		case 'video':
		case 'audio':
		case 'still':
		case 'animated-image':
		case 'solid':
		case 'nest-video':
		case 'nest-audio':
			return null;
		default:
			return `${kind} clip`;
	}
}

/** Formats without nested sequences: enabled multi-camera clips are written as their angle's clips. */
const FLAT_FORMATS: ReadonlySet<Format> = new Set(['edl', 'aaf', 'omf', 'ale']);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function mediaPathOf(asset: MediaAsset): string | null {
	for (const l of asset.locators) if (l.type === 'path' && l.path) return l.path;
	return null;
}

function generatorOf(s: SyntheticSource): IGenerator | null {
	switch (s.kind) {
		case 'color-matte':
			return { kind: 'color', color: [...s.color] as [number, number, number, number] };
		case 'black-video':
			return { kind: 'black' };
		case 'transparent':
			return { kind: 'transparent' };
		case 'bars-and-tone':
			return { kind: 'bars-and-tone', toneHz: s.toneHz, toneDb: s.toneDb };
		case 'counting-leader':
			return { kind: 'counting-leader' };
		default:
			return null;
	}
}

const GENERATOR_NAMES: Record<IGenerator['kind'], string> = {
	black: 'Black Video',
	transparent: 'Transparent Video',
	color: 'Color Matte',
	'bars-and-tone': 'Bars and Tone',
	'counting-leader': 'Universal Counting Leader',
};

/** JasperEditor document → interchange project holding `sequenceId`, its nested sequences and their sources. */
export function fromJasper(
	doc: ProjectDocument,
	sequenceId: string,
	opts: FromJasperOptions,
	report: Report,
): IProject {
	const itemOfSequence = new Map<string, ProjectItem>();
	const itemOfMedia = new Map<string, ProjectItem>();
	const itemOfSynthetic = new Map<string, ProjectItem>();
	for (const it of Object.values(doc.items)) {
		if (it.kind === 'sequence') itemOfSequence.set(it.sequenceId, it);
		else if (it.kind === 'media' && !itemOfMedia.has(it.mediaId)) itemOfMedia.set(it.mediaId, it);
		else if (it.kind === 'synthetic' && !itemOfSynthetic.has(it.syntheticId))
			itemOfSynthetic.set(it.syntheticId, it);
	}
	const top = doc.sequences[sequenceId];
	const p: IProject = {
		name: itemOfSequence.get(sequenceId)?.name ?? doc.name,
		root: [],
		media: {},
		sequences: {},
		top: top ? [sequenceId] : [],
	};
	if (!top) return p;
	const otio = opts.format === 'otio';
	const pathOf = opts.mediaPath ?? mediaPathOf;
	const prerendered = opts.prerendered ?? {};
	const preMedia = new Map<string, string>();
	const pre = (c: Clip) => !!prerendered[c.id];
	/** Formats without nested sequences write enabled multi-camera clips as the clips of their angle (Flatten). */
	const flat_ = opts.format !== undefined && FLAT_FORMATS.has(opts.format);

	const multicamOut = (s: Sequence): IMulticamSource => {
		const mc = s.multicam!;
		const vi = (id: string | null) => (id === null ? -1 : s.videoTracks.findIndex((t) => t.id === id));
		return {
			angles: mc.angles
				.filter((a) => a.videoTrackId === null || vi(a.videoTrackId) >= 0)
				.map((a) => ({
					id: a.id,
					name: a.name,
					video: a.videoTrackId === null ? null : vi(a.videoTrackId),
					audio: a.audioTrackIds
						.map((id) => s.audioTracks.findIndex((t) => t.id === id))
						.filter((i) => i >= 0),
					enabled: a.enabled,
				})),
			audio: mc.audio,
			...(mc.sync ? { sync: mc.sync } : {}),
		};
	};

	/**
	 * The clips an enabled multi-camera clip shows (Multi-Camera ▸ Flatten's pieces), `k` = which of the source's
	 * audible tracks a piece comes from (0 for video); null when it is no enabled multi-camera clip or has a frame hold.
	 */
	const flattenMulticam = (c: Clip, rate: Rate): { clip: Clip; k: number }[] | null => {
		if (!isEnabledMulticamClip(c) || c.frameHold) return null;
		const r = resolveMulticamClip(doc, { num: rate.num, den: rate.den }, c);
		if (!r) return null;
		const notes = new Set<string>();
		const warn = (_code: string, message: string) => notes.add(message);
		const innerTracks = [...new Set(r.pieces.map((x) => x.innerTrackId))];
		const audioTracks = new Map(r.source.audioTracks.map((t) => [t.id, t]));
		const out = r.pieces.map((piece, n) => {
			const id = `${c.id}~${n}`;
			const clip =
				c.kind === 'nest-video'
					? pieceVideoClip(doc, r.source, c as MulticamClip & { kind: 'nest-video' }, piece, id, warn)
					: pieceAudioClip(
							r.source,
							c as MulticamClip & { kind: 'nest-audio' },
							piece,
							audioTracks.get(piece.innerTrackId)!,
							id,
							warn,
						);
			if (c.linkId) clip.linkId = `${c.linkId}:${clip.start}:${clip.duration}`;
			return { clip, k: innerTracks.indexOf(piece.innerTrackId) };
		});
		const angle = r.multicam.angles.find((a) => a.id === r.angleId);
		report.info(
			`multi-camera clip "${c.name}" at frame ${c.start} is written as the ${out.length} clip(s) of its active angle${angle ? ` "${angle.name}"` : ''}`,
			{ subject: { kind: 'clip', id: c.id, name: c.name, frame: c.start }, instead: 'the angle’s clips' },
		);
		for (const m of notes)
			report.info(m, { subject: { kind: 'clip', id: c.id, name: c.name, frame: c.start } });
		return out;
	};

	const mediaFor = (assetId: string): string | null => {
		if (p.media[assetId]) return assetId;
		const a = doc.media[assetId] as MediaAsset | undefined;
		if (!a) return null;
		const item = itemOfMedia.get(assetId);
		const vs = a.probe.streams.find((s) => s.type === 'video');
		const audio = a.probe.streams.filter((s) => s.type === 'audio');
		const path = pathOf(a);
		const vrate = vs && vs.type === 'video' ? { num: vs.frameRate.num, den: vs.frameRate.den } : null;
		let timecode: IMedia['timecode'] = null;
		if (a.probe.startTimecode) {
			const r = vrate ?? top.settings.frameRate;
			const frames = parseTc(a.probe.startTimecode, r);
			if (frames !== null && frames >= 0)
				timecode = { frames, rate: { ...r }, dropFrame: a.probe.startTimecode.includes(';') };
		}
		const kind =
			a.kind === 'video' || a.kind === 'audio' || a.kind === 'image' || a.kind === 'animated-image'
				? a.kind
				: kindFromExtension(a.originalName);
		const m: IMedia = {
			id: assetId,
			name: item?.name ?? a.originalName,
			kind,
			path: path && (isAbsolutePath(path) || !path.includes('://')) ? path : null,
			duration: a.probe.durationFlicks,
			markers: [],
			...(vs && vs.type === 'video'
				? {
						video: {
							width: vs.width,
							height: vs.height,
							rate: vrate ?? { ...top.settings.frameRate },
							...(vs.pixelAspect.num !== vs.pixelAspect.den ? { pixelAspect: { ...vs.pixelAspect } } : {}),
							...(a.probe.hasAlpha ? { alpha: true } : {}),
							codec: vs.codec,
						},
					}
				: {}),
			...(audio[0] && audio[0].type === 'audio'
				? {
						audio: {
							sampleRate: audio[0].sampleRate,
							channels: audio[0].channels,
							...(audio.length > 1 ? { streams: audio.length } : {}),
						},
					}
				: {}),
			...(timecode ? { timecode } : {}),
			...(item?.kind === 'media' ? { label: item.label } : {}),
			sizeBytes: a.sizeBytes || null,
			...(path ? {} : { offline: !a.locators.some((l) => l.type === 'url') }),
			...(a.locators.find((l) => l.type === 'url')
				? { url: (a.locators.find((l) => l.type === 'url') as { url: string }).url }
				: {}),
			jasper: { asset: clone(a), ...(item ? { item: clone(item) } : {}) },
		};
		if (!path && !m.url)
			report.warn(`media "${m.name}" has no file path the document can reference`, {
				subject: { kind: 'media', id: assetId, name: m.name },
				instead: 'a reference by name only (offline in other applications)',
			});
		p.media[assetId] = m;
		return assetId;
	};

	const generatorFor = (synId: string): string | null => {
		if (p.media[synId]) return synId;
		const s = doc.synthetics[synId] as SyntheticSource | undefined;
		if (!s) return null;
		const g = generatorOf(s);
		if (!g) return null;
		const item = itemOfSynthetic.get(synId);
		p.media[synId] = {
			id: synId,
			name: item?.name ?? GENERATOR_NAMES[g.kind],
			kind: 'generator',
			path: null,
			duration: null,
			video: { width: top.settings.width, height: top.settings.height, rate: { ...top.settings.frameRate } },
			generator: g,
			markers: [],
			...(item?.kind === 'synthetic' ? { label: item.label } : {}),
			jasper: { synthetic: clone(s), ...(item ? { item: clone(item) } : {}) },
		};
		return synId;
	};

	const prerenderMedia = (clip: Clip, pre: PrerenderedClip): string => {
		const known = preMedia.get(pre.path);
		if (known) return known;
		const id = `pre_${clip.id}`;
		p.media[id] = {
			id,
			name: `${clip.name || clip.kind} (pre-rendered)`,
			kind: 'video',
			path: pre.path,
			duration: pre.durationFlicks,
			video: { width: pre.width, height: pre.height, rate: { ...pre.rate }, alpha: true, codec: 'prores' },
			markers: [],
			label: 'violet',
			...(pre.sizeBytes ? { sizeBytes: pre.sizeBytes } : {}),
		};
		preMedia.set(pre.path, id);
		return id;
	};

	const visiting = new Set<string>();
	const sequenceFor = (seqId: string): string | null => {
		if (p.sequences[seqId]) return seqId;
		const s = doc.sequences[seqId] as Sequence | undefined;
		if (!s || visiting.has(seqId)) return null;
		visiting.add(seqId);
		p.sequences[seqId] = convertSequence(s);
		visiting.delete(seqId);
		return seqId;
	};

	const convertSequence = (s: Sequence): ISequence => {
		const rate: Rate = { num: s.settings.frameRate.num, den: s.settings.frameRate.den };
		const F = flicksPerFrame(rate);
		const item = itemOfSequence.get(s.id);
		const name = item?.name ?? 'Sequence';
		const cues = cueMarkers(doc, s);
		const seq: ISequence = {
			id: s.id,
			name,
			rate,
			dropFrame: s.settings.dropFrame,
			width: s.settings.width,
			height: s.settings.height,
			sampleRate: s.settings.audioSampleRate,
			startTimecode: s.settings.startTimecodeFrames,
			...(item ? { label: item.label } : {}),
			video: [],
			audio: [],
			markers: [
				...s.markers.map(
					(m): IMarker => ({
						start: m.frame * F,
						duration: m.duration * F,
						name: m.name,
						comment: m.comment,
						color: m.color,
						type: m.type,
						...(m.url ? { url: m.url } : {}),
						jasper: clone(m),
					}),
				),
				// spec 12 §2.11: sound cues as `SFX: <type>[+<type>] (<weight>)` markers (no JasperEditor metadata: a
				// re-import makes plain markers, which Convert Markers to Cues turns back into cues).
				...cues.map(
					(m): IMarker => ({
						start: m.frame * F,
						duration: 0,
						name: m.name,
						comment: m.comment,
						color: 'mango',
						type: 'comment',
					}),
				),
			].sort((a, b) => a.start - b.start),
			inPoint: s.inPoint === null ? null : s.inPoint * F,
			outPoint: s.outPoint === null ? null : s.outPoint * F,
			...(s.multicam ? { multicam: multicamOut(s) } : {}),
			jasper: {
				settings: clone(s.settings),
				master: clone(s.master),
				workArea: s.workArea,
				// OTIO restores the submixes (and the sends and outputs naming them) from its metadata
				...(s.submixTracks?.length ? { submixTracks: clone(s.submixTracks) } : {}),
				...(item ? { item: clone(item) } : {}),
			},
		};
		const where = { kind: 'sequence' as const, id: s.id, name };
		const sd = (s as { soundDesign?: unknown }).soundDesign;
		if (sd !== undefined && sd !== null) {
			const n = cues.length;
			const carried =
				opts.format === 'ale'
					? 'not carried (an ALE is a media log without a timeline)'
					: opts.format === 'omf'
						? 'not carried (OMF has no sequence markers)'
						: null;
			const meta =
				"proposals and the sound design's mix metadata (settings, mix records, the last Sound Check, the SFX placement data of clips) are not carried";
			report.info(
				n === 0
					? `the sound design of "${name}" has no cues; ${meta}`
					: carried
						? `the ${n} sound design cue(s) of "${name}" are ${carried}; ${meta}`
						: `the ${n} sound design cue(s) of "${name}" are exported as "SFX: <type> (<weight>)" markers; ${meta}`,
				{
					subject: where,
					instead:
						carried || n === 0
							? 'nothing'
							: 'markers (after importing, Sequence ▸ Sound Design ▸ Convert Markers to Cues makes them cues again)',
				},
			);
		}
		if (!otio && s.master.loudness?.enabled)
			report.warn(
				`the loudness normalisation of "${name}" (${s.master.loudness.targetLufs} LUFS, ${s.master.loudness.truePeakDb} dBTP ceiling) is not carried`,
				{ subject: where, instead: 'the mix at its own level (normalise it in the other application)' },
			);
		if (!otio && s.submixTracks?.length)
			report.warn(`the ${s.submixTracks.length} submix track(s) of "${name}" are not carried`, {
				subject: where,
				instead: 'tracks routed to them play straight to the master',
			});
		if (!otio) {
			if (s.master.effects.length || s.master.volumeDb.keyframes.length || s.master.volumeDb.value !== 0)
				report.warn(`the master volume and effects of "${name}" are not carried`, {
					subject: where,
					instead: 'nothing (unity master)',
				});
		}
		const clipsByTrack = new Map<string, Clip[]>();
		for (const c of Object.values(s.clips) as Clip[])
			clipsByTrack.set(c.trackId, [...(clipsByTrack.get(c.trackId) ?? []), c]);
		const transitionsByTrack = new Map<string, Sequence['transitions'][string][]>();
		for (const t of Object.values(s.transitions))
			transitionsByTrack.set(t.trackId, [...(transitionsByTrack.get(t.trackId) ?? []), t]);

		const convertTrack = (t: Track, kind: 'video' | 'audio', index: number): ITrack => {
			const tr: ITrack = {
				name: t.name,
				enabled: kind === 'video' ? t.output !== false : t.mute !== true,
				locked: t.locked,
				clips: [],
				transitions: [],
				jasper: clone(t),
			};
			if (kind === 'audio') {
				if (t.solo) tr.solo = true;
				if (t.volumeDb) tr.volumeDb = clone(t.volumeDb);
				if (t.pan) tr.pan = clone(t.pan);
			}
			if (!otio && t.effects?.length)
				report.warn(`track effects on ${kind === 'video' ? 'V' : 'A'}${index + 1} are not carried`, {
					subject: { kind: 'track', id: t.id, name: t.name ?? `${kind === 'video' ? 'V' : 'A'}${index + 1}` },
					instead: 'the clips without the track effects',
				});
			const tag = `${kind === 'video' ? 'V' : 'A'}${index + 1}`;
			const mixer = t.mixer;
			if (!otio && mixer) {
				const what: string[] = [];
				if (mixer.sends?.length) what.push('sends');
				if (mixer.output) what.push('a submix output');
				if (Object.values(mixer.lanes ?? {}).some((l) => l.keyframes.length || l.value !== 0))
					what.push('mute / 5.1 automation');
				if (what.length)
					report.warn(`the ${what.join(', ')} of track ${tag} are not carried`, {
						subject: { kind: 'track', id: t.id, name: t.name ?? tag },
						instead: 'the track mixed straight to the master',
					});
			}
			const clips = [...(clipsByTrack.get(t.id) ?? [])].sort((a, b) => a.start - b.start);
			/** Flattened multi-camera clips: outer clip id → the pieces at its edges (on this track). */
			const edges = new Map<string, { first: string | null; last: string | null }>();
			for (const c of clips) {
				const flat = flat_ && !pre(c) ? flattenMulticam(c, rate) : null;
				if (flat) {
					const e = { first: null as string | null, last: null as string | null };
					for (const piece of flat) {
						const ic = convertClip(piece.clip, rate);
						if (!ic) continue;
						if (piece.k === 0) {
							tr.clips.push(ic);
							if (piece.clip.start === c.start) e.first = ic.id;
							if (piece.clip.start + piece.clip.duration === c.start + c.duration) e.last = ic.id;
						} else {
							let x = overflow.get(`${t.id}:${piece.k}`);
							if (!x) {
								x = { kind, track: { ...tr, name: null, clips: [], transitions: [], jasper: undefined } };
								overflow.set(`${t.id}:${piece.k}`, x);
							}
							x.track.clips.push(ic);
						}
					}
					edges.set(c.id, e);
					continue;
				}
				const ic = convertClip(c, rate);
				if (ic) tr.clips.push(ic);
			}
			const edgeOf = (id: string | null, side: 'first' | 'last'): string | null | undefined => {
				if (id === null) return null;
				const e = edges.get(id);
				return e ? (e[side] ?? undefined) : id;
			};
			for (const x of transitionsByTrack.get(t.id) ?? []) {
				const startFrame = transitionStartFrame(s, x);
				if (startFrame === null) continue;
				const from = edgeOf(x.outgoingClipId, 'last');
				const to = edgeOf(x.incomingClipId, 'first');
				if (from === undefined || to === undefined) {
					report.warn(
						`a transition at frame ${startFrame} is not written: the multi-camera angle has no clip at that edge`,
						{ subject: { kind: 'transition', id: x.id, frame: startFrame }, instead: 'a cut' },
					);
					continue;
				}
				tr.transitions.push({
					id: x.id,
					effectId: x.effectId,
					from,
					to,
					start: startFrame * F,
					duration: x.duration * F,
					alignment: x.alignment,
					params: clone(x.params) as ITransition['params'],
					jasper: clone(x),
				});
			}
			tr.transitions.sort((a, b) => a.start - b.start);
			return tr;
		};
		const overflow = new Map<string, { kind: 'video' | 'audio'; track: ITrack }>();
		seq.video = s.videoTracks.map((t, i) => convertTrack(t, 'video', i));
		seq.audio = s.audioTracks.map((t, i) => convertTrack(t, 'audio', i));
		// Flattened multi-camera clips whose angle spans several tracks: extra tracks after the others.
		for (const { kind, track } of overflow.values()) {
			delete track.jasper;
			seq[kind].push(track);
		}
		// Captions: formats with captions (FCPXML, OTIO) carry the cues; pre-rendered caption clips become video
		// clips on extra top tracks; the others are reported, one entry per caption.
		const carriesCaptions = opts.format === 'fcpxml' || otio;
		for (const t of s.captionTracks) {
			const clips = ([...(clipsByTrack.get(t.id) ?? [])] as Clip[])
				.filter((c) => c.kind === 'captions')
				.sort((a, b) => a.start - b.start) as CaptionsClip[];
			const pre = clips.filter((c) => prerendered[c.id]);
			if (pre.length) {
				const tr: ITrack = {
					name: t.name ?? 'Captions',
					enabled: t.visible !== false,
					locked: t.locked,
					clips: [],
					transitions: [],
				};
				for (const c of pre) {
					const ic = convertClip(c, rate);
					if (ic) tr.clips.push(ic);
				}
				seq.video.push(tr);
			}
			const rest = clips.filter((c) => !prerendered[c.id]);
			if (!rest.length) continue;
			if (!carriesCaptions) {
				for (const c of rest)
					reportUncarried(c, 'caption', 'nothing (export the captions as a sidecar file)');
				continue;
			}
			(seq.captions ??= []).push({
				name: t.name,
				...(t.language ? { language: t.language } : {}),
				enabled: t.visible !== false,
				cues: rest.map((c) => {
					const settings = vttSettingsFor(c);
					return {
						start: c.start * F,
						duration: c.duration * F,
						text: captionClipText(doc, c, rate),
						speaker: captionClipSpeaker(doc, c, rate),
						...(settings ? { settings } : {}),
					};
				}),
			});
		}
		return seq;
	};

	const reportUncarried = (c: Clip, what: string, instead: string | null) => {
		if (instead === null) return;
		const frame = c.start;
		report.warn(`${what} "${c.name}" at frame ${frame} has no equivalent in this format`, {
			subject: { kind: 'clip', id: c.id, name: c.name, frame },
			instead,
		});
	};

	const convertClip = (c: Clip, rate: Rate): IClip | null => {
		const F = flicksPerFrame(rate);
		const base: IClip = {
			id: c.id,
			name: c.name,
			start: c.start * F,
			duration: c.duration * F,
			sourceIn: c.sourceIn,
			speed: c.speed.rate,
			reverse: c.speed.reverse,
			enabled: c.enabled,
			label: c.label,
			link: c.linkId,
			group: c.groupId,
			source: { type: 'none', what: uncarriedWhat(c.kind) ?? `${c.kind} clip` },
			markers: c.markers.map(
				(m): IMarker => ({
					start: m.flicks,
					duration: m.duration,
					name: m.name,
					comment: m.comment,
					color: m.color,
					type: m.type,
					...(m.url ? { url: m.url } : {}),
					jasper: clone(m),
				}),
			),
			effects: clone('effects' in c ? c.effects : []),
			jasper: clone(c),
		};
		if (c.frameHold) base.hold = c.frameHold.flicks;
		// Time Remapping as a time map (clip time → media time), and the Time Interpolation.
		const tmap = remapToTimeMap(c as TimedClip, rate);
		// (`speed` / `sourceIn` stay: they are the content axis keyframes are measured on.)
		if (tmap) base.timeMap = tmap;
		const interp = timeInterpolationOf(c as TimedClip);
		if (interp !== 'frame-sampling') base.frameSampling = interp;
		const pre = prerendered[c.id];
		if (tmap && !pre && opts.format && !FORMAT_CAPS[opts.format].timeMap) {
			// No variable speed in this format: the clip's average speed, reported (OTIO keeps the remap in its metadata).
			const a = tmap[0]!;
			const b = tmap[tmap.length - 1]!;
			const avg = (b.value - a.value) / Math.max(1, b.time - a.time);
			base.timeMap = null;
			base.speed = Math.max(0.01, Math.abs(avg)) || 1;
			base.reverse = avg < 0;
			base.sourceIn = Math.max(0, Math.min(a.value, b.value));
			const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: c.start };
			if (otio)
				report.info(`the time remapping of clip "${c.name}" is kept in the OTIO metadata only`, {
					subject: where,
				});
			else
				report.warn(`the time remapping of clip "${c.name}" at frame ${c.start} is not carried`, {
					subject: where,
					instead: 'its average speed (pre-render it to keep the speed changes)',
				});
		}
		if (!pre && !otio) {
			const where = { kind: 'clip' as const, id: c.id, name: c.name, frame: c.start };
			const masks = 'masks' in c && c.masks?.length;
			const fxMasks = 'effects' in c && c.effects.some((e) => e.masks?.length);
			if (masks || fxMasks)
				report.warn(`the masks of clip "${c.name}" at frame ${c.start} are not carried`, {
					subject: where,
					instead: 'the clip without its masks (pre-render it to keep them)',
				});
			if ('threeD' in c && c.threeD?.enabled === true && c.kind !== 'model')
				report.warn(`the 3D placement of clip "${c.name}" at frame ${c.start} is not carried`, {
					subject: where,
					instead:
						'the clip with its 2D Motion only (pre-render it to keep its 3D placement, camera and lights)',
				});
			if (hasExpression(c))
				report.warn(`the expressions of clip "${c.name}" at frame ${c.start} are not carried`, {
					subject: where,
					instead: 'the keyframed values without the expressions (pre-render it to keep them)',
				});
		}
		if (pre) {
			const mid = prerenderMedia(c, pre);
			return {
				...base,
				source: { type: 'media', mediaId: mid },
				sourceIn: 0,
				speed: 1,
				reverse: false,
				hold: null,
				effects: [],
				transform: {
					position: anim([pre.width / 2, pre.height / 2]),
					anchor: anim([pre.width / 2, pre.height / 2]),
					scale: anim(100),
					scaleWidth: anim(100),
					uniformScale: true,
					rotation: anim(0),
					flipH: false,
					flipV: false,
				},
				opacity: anim(100),
				blendMode: 'blendMode' in c ? c.blendMode : 'normal',
				markers: [],
			};
		}
		if (!isKnownClipKind(c.kind)) {
			reportUncarried(c, `${c.kind} clip`, otio ? null : 'nothing (unknown clip kind)');
			return otio ? base : null;
		}
		switch (c.kind) {
			case 'video':
			case 'still':
			case 'animated-image': {
				const mid = mediaFor(c.mediaId);
				if (!mid) {
					report.warn(`clip "${c.name}" references missing media and was not exported`, {
						subject: { kind: 'clip', id: c.id, name: c.name, frame: c.start },
					});
					return null;
				}
				return {
					...base,
					source: { type: 'media', mediaId: mid },
					transform: clone(c.transform),
					opacity: clone(c.opacity),
					blendMode: c.blendMode,
				};
			}
			case 'audio': {
				const mid = mediaFor(c.mediaId);
				if (!mid) {
					report.warn(`clip "${c.name}" references missing media and was not exported`, {
						subject: { kind: 'clip', id: c.id, name: c.name, frame: c.start },
					});
					return null;
				}
				const a = doc.media[c.mediaId] as MediaAsset;
				const streams = a.probe.streams.filter((x) => x.type === 'audio');
				const ordinal = Math.max(
					0,
					streams.findIndex((x) => x.index === c.channels.streamIndex),
				);
				return {
					...base,
					source: { type: 'media', mediaId: mid },
					gainDb: c.gainDb,
					volumeDb: clone(c.volumeDb),
					pan: clone(c.pan),
					channels: { streamIndex: ordinal, map: [...c.channels.map] },
				};
			}
			case 'solid': {
				const mid = generatorFor(c.syntheticId);
				if (!mid) {
					reportUncarried(c, 'solid clip', otio ? null : 'nothing (unsupported synthetic source)');
					return otio ? base : null;
				}
				return {
					...base,
					source: { type: 'media', mediaId: mid },
					transform: clone(c.transform),
					opacity: clone(c.opacity),
					blendMode: c.blendMode,
				};
			}
			case 'synthetic-audio': {
				const mid = generatorFor(c.syntheticId);
				if (!mid) {
					reportUncarried(c, 'synthetic audio clip', otio ? null : 'nothing');
					return otio ? base : null;
				}
				return {
					...base,
					source: { type: 'media', mediaId: mid },
					gainDb: c.gainDb,
					volumeDb: clone(c.volumeDb),
					pan: clone(c.pan),
				};
			}
			case 'nest-video':
			case 'nest-audio': {
				const sid = sequenceFor(c.sequenceId);
				if (!sid) {
					report.warn(`nested sequence clip "${c.name}" refers to a missing or recursive sequence`, {
						subject: { kind: 'clip', id: c.id, name: c.name, frame: c.start },
						instead: 'nothing',
					});
					return null;
				}
				const mc = c.multicam ? { multicam: { enabled: c.multicam.enabled, angle: c.multicam.angle } } : {};
				if (c.kind === 'nest-video')
					return {
						...base,
						source: { type: 'sequence', sequenceId: sid },
						...mc,
						transform: clone(c.transform),
						opacity: clone(c.opacity),
						blendMode: c.blendMode,
					};
				return {
					...base,
					source: { type: 'sequence', sequenceId: sid },
					...mc,
					gainDb: c.gainDb,
					volumeDb: clone(c.volumeDb),
					pan: clone(c.pan),
				};
			}
			default: {
				return {
					...base,
					...('transform' in c ? { transform: clone(c.transform) } : {}),
					...('opacity' in c ? { opacity: clone(c.opacity) } : {}),
					...('blendMode' in c ? { blendMode: c.blendMode } : {}),
				};
			}
		}
	};

	sequenceFor(sequenceId);

	// JasperEditor entities the exported clips reference besides their media (fonts, transcripts, synthetic
	// sources, Remotion bundles, LUTs): kept on the top sequence for formats that carry metadata (OTIO).
	{
		const fonts = new Map<string, ProjectDocument['fonts'][string]>();
		const transcripts = new Map<string, ProjectDocument['transcripts'][string]>();
		const synthetics = new Map<string, SyntheticSource>();
		const media = new Map<string, MediaAsset>();
		const addMedia = (id: unknown) => {
			if (typeof id === 'string' && doc.media[id] && !p.media[id]) media.set(id, clone(doc.media[id]));
		};
		const scan = (v: unknown, depth = 0) => {
			if (depth > 32 || !v || typeof v !== 'object') return;
			if (Array.isArray(v)) {
				for (const x of v) scan(x, depth + 1);
				return;
			}
			const o = v as Record<string, unknown>;
			if (typeof o.mediaId === 'string') addMedia(o.mediaId);
			for (const x of Object.values(o)) scan(x, depth + 1);
		};
		for (const sid of Object.keys(p.sequences)) {
			const s = doc.sequences[sid] as Sequence;
			for (const c of Object.values(s.clips) as (Clip & Record<string, unknown>)[]) {
				const font = (c.content as { style?: { fontId?: string } } | undefined)?.style?.fontId;
				if (font && doc.fonts[font]) {
					fonts.set(font, clone(doc.fonts[font]));
					const f = doc.fonts[font]!;
					if (f.source.type === 'asset') addMedia(f.source.mediaId);
				}
				if (typeof c.transcriptId === 'string' && doc.transcripts[c.transcriptId])
					transcripts.set(c.transcriptId, clone(doc.transcripts[c.transcriptId]));
				if (typeof c.syntheticId === 'string' && doc.synthetics[c.syntheticId] && !p.media[c.syntheticId])
					synthetics.set(c.syntheticId, clone(doc.synthetics[c.syntheticId]));
				addMedia((c.composition as { mediaId?: string } | undefined)?.mediaId);
				scan(c.effects);
				// template media params (avatars) of motion graphics.
				for (const id of clipParamMediaIds(c)) addMedia(id);
			}
			for (const t of [...s.videoTracks, ...s.audioTracks, ...s.captionTracks]) {
				scan(t.effects);
				const fid = t.styleDefaults?.fontId;
				if (fid && doc.fonts[fid]) fonts.set(fid, clone(doc.fonts[fid]));
			}
			scan(s.master.effects);
		}
		const topSeq = p.sequences[sequenceId];
		if (topSeq && (fonts.size || transcripts.size || synthetics.size || media.size))
			topSeq.jasper = {
				...topSeq.jasper,
				entities: {
					fonts: [...fonts.values()],
					transcripts: [...transcripts.values()],
					synthetics: [...synthetics.values()],
					media: [...media.values()],
				},
			};
	}

	// Bin tree: the exported sequences and their sources, where they sit in the project.
	const wanted = new Set<string>();
	for (const id of Object.keys(p.sequences)) {
		const it = itemOfSequence.get(id);
		if (it) wanted.add(it.id);
	}
	for (const id of Object.keys(p.media)) {
		const it = itemOfMedia.get(id) ?? itemOfSynthetic.get(id);
		if (it) wanted.add(it.id);
	}
	const placed = new Set<string>();
	const entryFor = (it: ProjectItem): IBinEntry | null => {
		if (it.kind === 'sequence' && p.sequences[it.sequenceId] && wanted.has(it.id)) {
			placed.add(it.sequenceId);
			return { type: 'sequence', id: it.sequenceId };
		}
		if (it.kind === 'media' && p.media[it.mediaId] && wanted.has(it.id)) {
			placed.add(it.mediaId);
			return { type: 'media', id: it.mediaId };
		}
		if (it.kind === 'synthetic' && p.media[it.syntheticId] && wanted.has(it.id)) {
			placed.add(it.syntheticId);
			return { type: 'media', id: it.syntheticId };
		}
		return null;
	};
	const walk = (ids: readonly string[], out: IBinEntry[], depth: number) => {
		for (const id of ids) {
			const it = doc.items[id];
			if (!it) continue;
			if (it.kind === 'bin') {
				if (depth > 64) continue;
				const children: IBinEntry[] = [];
				walk(it.children, children, depth + 1);
				if (children.length) out.push({ type: 'bin', name: it.name, label: it.label, children });
			} else {
				const e = entryFor(it);
				if (e) out.push(e);
			}
		}
	};
	walk(doc.rootItems, p.root, 0);
	for (const id of Object.keys(p.sequences)) if (!placed.has(id)) p.root.push({ type: 'sequence', id });
	const preIds = Object.keys(p.media).filter((id) => id.startsWith('pre_'));
	if (preIds.length)
		p.root.push({
			type: 'bin',
			name: 'Pre-rendered',
			children: preIds.map((id) => ({ type: 'media' as const, id })),
		});
	for (const id of Object.keys(p.media))
		if (!placed.has(id) && !id.startsWith('pre_')) p.root.push({ type: 'media', id });
	return p;
}

/** Whether any animatable of a clip (Motion, Opacity, levels, effect params, Source Text) has an expression. */
export function hasExpression(c: unknown): boolean {
	let found = false;
	const walk = (v: unknown, depth: number) => {
		if (found || depth > 12 || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x, depth + 1);
			return;
		}
		const o = v as Record<string, unknown>;
		const e = o.expression as { text?: unknown } | undefined;
		if (e && typeof e === 'object' && typeof e.text === 'string' && e.text.trim()) {
			found = true;
			return;
		}
		for (const [k, x] of Object.entries(o)) if (k !== 'markers' && k !== 'trackers') walk(x, depth + 1);
	};
	walk(c, 0);
	return found;
}
