// Compact, LLM-friendly views of a project document: sequences, tracks and clips with ids, frames and
// timecodes (S02:TL-951: frames always come with timecode), media summaries and a text timeline table.
import {
	type Clip,
	flicksToSeconds,
	fpsOf,
	linkedPartners,
	type MediaAsset,
	type ProjectDocument,
	type Rational,
	type Sequence,
	type ShapeData,
	sequenceDuration,
	sequenceTimecode,
	sourceOut,
	TEXT_ANIMATION_SIDES,
	type Track,
	type Transition,
	trackLabel,
	transitionSpan,
	transitionSpec,
} from '@jasper/project';

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function sequenceName(doc: ProjectDocument, seqId: string): string {
	for (const item of Object.values(doc.items))
		if (item.kind === 'sequence' && item.sequenceId === seqId) return item.name;
	return seqId;
}

function tracksOf(seq: Sequence): Track[] {
	return [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks];
}

/** The sequence a tool addresses: explicit id, else the only/first one. */
export function pickSequence(doc: ProjectDocument, sequenceId?: string): Sequence {
	if (sequenceId) {
		const s = doc.sequences[sequenceId];
		if (!s) throw new Error(`Sequence not found: ${sequenceId}`);
		return s;
	}
	const all = Object.values(doc.sequences);
	if (!all.length) throw new Error('The project has no sequence');
	return all[0]!;
}

function mediaName(doc: ProjectDocument, mediaId: string): string {
	for (const item of Object.values(doc.items))
		if (item.kind === 'media' && item.mediaId === mediaId) return item.name;
	return doc.media[mediaId]?.originalName ?? mediaId;
}

/** One-line description of what a clip shows or plays. */
export function clipSourceText(doc: ProjectDocument, seq: Sequence, clip: Clip): string {
	const c = clip as Clip & Record<string, unknown>;
	const r = seq.settings.frameRate as Rational;
	if (typeof c.mediaId === 'string') {
		const a = round3(flicksToSeconds(clip.sourceIn));
		const b = round3(flicksToSeconds(sourceOut(clip, r)));
		return `${mediaName(doc, c.mediaId)} [${c.mediaId}] ${a}–${b} s${clip.speed.rate !== 1 ? ` @${clip.speed.rate}x` : ''}`;
	}
	if (clip.kind === 'text') {
		const t = (c.content as { text?: string } | undefined)?.text ?? '';
		// M2 (S11:ANA-008): the in/out text animators, e.g. `in:slide-up out:fade`.
		const anim = clip.textAnimation;
		const sides = TEXT_ANIMATION_SIDES.flatMap((s) => (anim?.[s] ? [`${s}:${anim[s].preset}`] : []));
		return `text "${t.length > 40 ? `${t.slice(0, 40)}…` : t}"${sides.length ? ` ${sides.join(' ')}` : ''}`;
	}
	if (clip.kind === 'motion-graphic') {
		const t = c.template as { id?: string; version?: number; renderer?: string } | undefined;
		return `motion graphic ${t?.id ?? '?'}@${t?.version ?? '?'}${t?.renderer === 'anime' ? ' (anime)' : ''}`;
	}
	if (clip.kind === 'solid') return 'color matte';
	// wp-m2-shapes (S11:SHP-008, ANA-008): geometry and paint.
	if (clip.kind === 'shape') return shapeText(clip.shape);
	return clip.kind;
}

// ---------------------------------------------------------------- wp-m2-shapes

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
const hexOf = (c: readonly number[]) => {
	const h = c.map((x) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, '0'),
	);
	return `#${h.slice(0, 3).join('')}${h[3] === 'ff' ? '' : h[3]}`;
};

/** "rect 400×400 fill #ffffff stroke 4px #000000 inside radius 12 (animated: size)". */
export function shapeText(s: ShapeData): string {
	const parts = [`${s.type} ${round3(s.size.value[0])}×${round3(s.size.value[1])}`];
	parts.push(s.fill ? `fill ${hexOf(s.fill.value)}` : 'no fill');
	if (s.stroke)
		parts.push(
			`stroke ${round3(s.stroke.width.value)}px ${hexOf(s.stroke.color.value)} ${s.stroke.position}`,
		);
	if (s.type === 'rect' && s.cornerRadius.value > 0) parts.push(`radius ${round3(s.cornerRadius.value)}`);
	const keyed: [string, { keyframes: unknown[] } | null | undefined][] = [
		['size', s.size],
		['fill', s.fill],
		['stroke color', s.stroke?.color],
		['stroke width', s.stroke?.width],
		['radius', s.cornerRadius],
	];
	const animated = keyed.filter(([, a]) => (a?.keyframes.length ?? 0) > 0).map(([k]) => k);
	return `${parts.join(' ')}${animated.length ? ` (animated: ${animated.join(', ')})` : ''}`;
}

// ---------------------------------------------------------------- end wp-m2-shapes

export type ClipSummary = {
	id: string;
	kind: string;
	name: string;
	track: string;
	start: number;
	end: number;
	startTimecode: string;
	endTimecode: string;
	source: string;
	enabled?: false;
	linked?: string[];
};

export function clipSummary(doc: ProjectDocument, seq: Sequence, clip: Clip): ClipSummary {
	const linked = linkedPartners(seq, clip.id).map((p) => p.id);
	return {
		id: clip.id,
		kind: clip.kind,
		name: clip.name,
		track: trackLabel(seq, clip.trackId) ?? clip.trackId,
		start: clip.start,
		end: clip.start + clip.duration,
		startTimecode: sequenceTimecode(seq, clip.start),
		endTimecode: sequenceTimecode(seq, clip.start + clip.duration),
		source: clipSourceText(doc, seq, clip),
		...(clip.enabled ? {} : { enabled: false as const }),
		...(linked.length ? { linked } : {}),
	};
}

function sortedClips(seq: Sequence): Clip[] {
	const order = new Map(tracksOf(seq).map((t, i) => [t.id, i]));
	return Object.values(seq.clips).sort(
		(a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || a.start - b.start,
	);
}

export function sequenceSummary(doc: ProjectDocument, seq: Sequence) {
	const r = seq.settings.frameRate as Rational;
	const duration = sequenceDuration(seq);
	return {
		sequenceId: seq.id,
		name: sequenceName(doc, seq.id),
		width: seq.settings.width,
		height: seq.settings.height,
		fps: round3(fpsOf(r)),
		frameRate: `${r.num}/${r.den}`,
		dropFrame: seq.settings.dropFrame,
		duration: {
			frames: duration,
			timecode: sequenceTimecode(seq, duration),
			seconds: round3((duration * r.den) / r.num),
		},
		tracks: tracksOf(seq).map((t) => ({
			id: t.id,
			label: trackLabel(seq, t.id),
			kind: t.kind,
			...(t.locked ? { locked: true } : {}),
			...(t.mute ? { mute: true } : {}),
			clips: Object.values(seq.clips).filter((c) => c.trackId === t.id).length,
		})),
		clips: sortedClips(seq).map((c) => clipSummary(doc, seq, c)),
		markers: seq.markers.map((m) => ({
			id: m.id,
			frame: m.frame,
			timecode: sequenceTimecode(seq, m.frame),
			name: m.name,
			...(m.comment ? { comment: m.comment } : {}),
			...(m.duration ? { duration: m.duration } : {}),
		})),
		inPoint: seq.inPoint,
		outPoint: seq.outPoint,
	};
}

export function mediaSummary(doc: ProjectDocument, m: MediaAsset) {
	const vs = m.probe.streams.find((s) => s.type === 'video');
	const as = m.probe.streams.filter((s) => s.type === 'audio');
	return {
		mediaId: m.id,
		name: mediaName(doc, m.id),
		kind: m.kind,
		durationSeconds: m.probe.durationFlicks === null ? null : round3(flicksToSeconds(m.probe.durationFlicks)),
		...(vs ? { video: `${vs.width}x${vs.height} @ ${round3(fpsOf(vs.frameRate))} fps ${vs.codec}` } : {}),
		...(as.length
			? {
					audio: as.map((a) => `${a.channels} ch ${a.sampleRate} Hz ${a.codec}`).join(', '),
				}
			: {}),
	};
}

/** `get_project` body. */
export function projectSummary(doc: ProjectDocument, revision: number | undefined, live: boolean) {
	return {
		projectId: doc.projectId,
		name: doc.name,
		revision: revision ?? null,
		editorOpen: live,
		sequences: Object.values(doc.sequences).map((s) => sequenceSummary(doc, s)),
		media: Object.values(doc.media).map((m) => mediaSummary(doc, m)),
	};
}

/**
 * Where a transition sits: the cut (the outgoing clip's end, else the incoming clip's start) and the span
 * `[start, end)` it covers around it. Null when neither of its clips exists any more.
 */
export function transitionPlacement(
	seq: Sequence,
	t: Transition,
): { cut: number; start: number; end: number } | null {
	const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
	const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
	const cut = out ? out.start + out.duration : inc ? inc.start : null;
	if (cut === null) return null;
	return { cut, ...transitionSpan(cut, t.duration, t.alignment) };
}

/** `get_timeline`: one line per transition overlapping [from, to), in track order then time. */
export function transitionLines(seq: Sequence, from = 0, to = Number.POSITIVE_INFINITY): string[] {
	const order = new Map(tracksOf(seq).map((t, i) => [t.id, i]));
	return Object.values(seq.transitions)
		.map((t) => ({ t, p: transitionPlacement(seq, t) }))
		.filter(
			(x): x is { t: Transition; p: NonNullable<typeof x.p> } => !!x.p && x.p.start < to && x.p.end > from,
		)
		.sort((a, b) => (order.get(a.t.trackId) ?? 0) - (order.get(b.t.trackId) ?? 0) || a.p.cut - b.p.cut)
		.map(({ t, p }) => {
			const kind =
				t.outgoingClipId && t.incomingClipId ? t.alignment : t.incomingClipId ? 'fade in' : 'fade out';
			return (
				`  ${trackLabel(seq, t.trackId) ?? t.trackId} ${t.id} ${transitionSpec(t.effectId)?.label ?? t.effectId} ` +
				`${sequenceTimecode(seq, p.start)}–${sequenceTimecode(seq, p.end)} (${p.start}–${p.end}) ${kind}, ${t.duration} frames`
			);
		});
}

/** `get_timeline`: a compact text table (one row per clip) plus transitions and markers. */
export function timelineTable(
	doc: ProjectDocument,
	seq: Sequence,
	opts: { from?: number; to?: number; revision?: number; live?: boolean } = {},
): string {
	const r = seq.settings.frameRate as Rational;
	const duration = sequenceDuration(seq);
	const from = opts.from ?? 0;
	const to = opts.to ?? Number.POSITIVE_INFINITY;
	const lines: string[] = [];
	lines.push(
		`Sequence "${sequenceName(doc, seq.id)}" (${seq.id}) ${seq.settings.width}x${seq.settings.height} @ ${round3(fpsOf(r))} fps` +
			`${seq.settings.dropFrame ? ' DF' : ''}, duration ${sequenceTimecode(seq, duration)} (${duration} frames)` +
			`${opts.revision !== undefined ? `, revision ${opts.revision}` : ''}${opts.live ? ', open in the editor' : ''}`,
	);
	if (opts.from !== undefined || opts.to !== undefined)
		lines.push(
			`Range ${sequenceTimecode(seq, from)}–${Number.isFinite(to) ? sequenceTimecode(seq, to) : 'end'} (frames ${from}–${Number.isFinite(to) ? to : 'end'})`,
		);
	lines.push('track | clip id | kind | name | start–end timecode | start–end frames | source | linked');
	for (const t of tracksOf(seq)) {
		const clips = Object.values(seq.clips)
			.filter((c) => c.trackId === t.id && c.start < to && c.start + c.duration > from)
			.sort((a, b) => a.start - b.start);
		const label = trackLabel(seq, t.id) ?? t.id;
		const flags = [t.locked ? 'locked' : '', t.mute ? 'muted' : ''].filter(Boolean).join(',');
		if (!clips.length) {
			lines.push(`${label}${flags ? ` (${flags})` : ''} | (empty)`);
			continue;
		}
		for (const c of clips) {
			const s = clipSummary(doc, seq, c);
			lines.push(
				[
					`${label}${flags ? ` (${flags})` : ''}`,
					s.id,
					s.kind + (s.enabled === false ? ' (disabled)' : ''),
					s.name,
					`${s.startTimecode}–${s.endTimecode}`,
					`${s.start}–${s.end}`,
					s.source,
					s.linked?.join(' ') ?? '',
				].join(' | '),
			);
		}
	}
	const transitions = transitionLines(seq, from, to);
	if (transitions.length) lines.push('Transitions:', ...transitions);
	const markers = seq.markers.filter((m) => m.frame >= from && m.frame < to);
	if (markers.length) {
		lines.push('Markers:');
		for (const m of markers)
			lines.push(
				`  ${sequenceTimecode(seq, m.frame)} (${m.frame}) "${m.name}" ${m.id}${m.comment ? ` — ${m.comment}` : ''}`,
			);
	}
	if (seq.inPoint !== null || seq.outPoint !== null)
		lines.push(
			`In/Out: ${seq.inPoint === null ? '—' : sequenceTimecode(seq, seq.inPoint)} / ${seq.outPoint === null ? '—' : sequenceTimecode(seq, seq.outPoint)}`,
		);
	return lines.join('\n');
}
