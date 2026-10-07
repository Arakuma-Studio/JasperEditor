// Multi-Camera view logic (wp-multicam), pure and testable: which multi-camera clip the view follows, the grid
// layout and paging, and the virtual document the Program monitor plays in Multi-Camera view — one composition with
// the angle grid on the left and the program on the right, so every cell and the program are frame-synced by the
// same Player and drawn by the same render paths as everything else (each cell is the multi-camera clip itself,
// switched to one angle, without the clip's effects or Motion).
import {
	anim,
	type Clip,
	createCounterIdSource,
	createSequence,
	isEnabledMulticamClip,
	type MulticamAngle,
	type MulticamClip,
	type MulticamSource,
	multicamSourceOf,
	type ProjectDocument,
	type Sequence,
	sequenceDuration,
	shownAngles,
} from '@jasper/project';

/** The enabled multi-camera video clip at `frame`: lowest video track first, or topmost with `topDown`. */
export function multicamClipAt(
	seq: Sequence,
	frame: number,
	topDown = false,
): { clip: MulticamClip; trackId: string } | null {
	const tracks = topDown ? [...seq.videoTracks].reverse() : seq.videoTracks;
	for (const t of tracks) {
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== t.id || c.kind !== 'nest-video' || !isEnabledMulticamClip(c)) continue;
			if (c.start <= frame && frame < c.start + c.duration) return { clip: c, trackId: t.id };
		}
	}
	return null;
}

/** The track the Multi-Camera view follows: the one with a multi-camera clip at `frame`, else the first with any. */
export function multicamTrack(seq: Sequence, frame: number, topDown = false): string | null {
	const at = multicamClipAt(seq, frame, topDown);
	if (at) return at.trackId;
	const tracks = topDown ? [...seq.videoTracks].reverse() : seq.videoTracks;
	for (const t of tracks)
		if (
			Object.values(seq.clips).some(
				(c) => c.trackId === t.id && c.kind === 'nest-video' && isEnabledMulticamClip(c),
			)
		)
			return t.id;
	return null;
}

export type GridLayout = {
	cols: number;
	rows: number;
	perPage: number;
	page: number;
	pages: number;
	first: number;
	count: number;
};

/** Grid page for `n` shown angles: `side` = 2/3/4 (2×2, 3×3, 4×4) or `auto` (smallest square ≤ 4×4 that fits). */
export function gridLayout(n: number, side: 'auto' | 2 | 3 | 4, page: number): GridLayout {
	const s = side === 'auto' ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))))) : side;
	const perPage = s * s;
	const pages = Math.max(1, Math.ceil(n / perPage));
	const p = Math.min(Math.max(0, page), pages - 1);
	const first = p * perPage;
	return {
		cols: s,
		rows: s,
		perPage,
		page: p,
		pages,
		first,
		count: Math.max(0, Math.min(perPage, n - first)),
	};
}

export type MulticamCell = {
	angle: MulticamAngle;
	/** 1-based camera number among the shown angles (what keys 1–9 pick, page-relative on later pages). */
	camera: number;
	/** In virtual-composition pixels. */
	rect: { x: number; y: number; width: number; height: number };
};

export type MulticamViewDoc = {
	doc: ProjectDocument;
	sequenceId: string;
	width: number;
	height: number;
	cells: MulticamCell[];
	/** Where the program sits (null when the preview monitor is hidden). */
	program: { x: number; y: number; width: number; height: number } | null;
	layout: GridLayout;
	trackId: string;
	source: MulticamSource;
	sourceSequenceId: string;
};

const VIRTUAL_SEQ = 'seq_MULTICAMVIEW0000';

/**
 * The virtual document of the Multi-Camera view of `seqId` at `frame`, or null when the sequence has no enabled
 * multi-camera clip. The grid follows the multi-camera clips of one track (`multicamTrack`) whose source is the
 * source of the clip at the playhead (else of the first one).
 */
export function buildMulticamViewDoc(
	doc: ProjectDocument,
	seqId: string,
	frame: number,
	opts: { showPreview: boolean; topDown: boolean; layout: 'auto' | 2 | 3 | 4; page: number },
): MulticamViewDoc | null {
	const seq = doc.sequences[seqId];
	if (!seq) return null;
	const trackId = multicamTrack(seq, frame, opts.topDown);
	if (!trackId) return null;
	const onTrack = Object.values(seq.clips)
		.filter(
			(c): c is MulticamClip => c.trackId === trackId && c.kind === 'nest-video' && isEnabledMulticamClip(c),
		)
		.sort((a, b) => a.start - b.start);
	const at = onTrack.find((c) => c.start <= frame && frame < c.start + c.duration) ?? onTrack[0]!;
	const sourceSequenceId = at.sequenceId;
	const source = multicamSourceOf(doc.sequences[sourceSequenceId]);
	if (!source) return null;
	const shown = shownAngles(source);
	const layout = gridLayout(shown.length, opts.layout, opts.page);
	const W = seq.settings.width;
	const H = seq.settings.height;
	const even = (n: number) => n - (n % 2);
	const width = opts.showPreview ? Math.min(8192, even(W * 2)) : W;
	const half = opts.showPreview ? width / 2 : width;
	const scaleToHalf = half / W;
	const gridH = H * scaleToHalf;
	const gridY = (H - gridH) / 2;
	const cellW = half / layout.cols;
	const cellH = gridH / layout.rows;
	const ids = createCounterIdSource(1);
	const vseq = createSequence(
		ids,
		{ ...seq.settings, width, height: H },
		{ video: 1 + layout.count, audio: 1 },
		VIRTUAL_SEQ,
	);
	const clips: Record<string, Clip> = {};
	const src = doc.sequences[sourceSequenceId]!;
	const box = { width: src.settings.width, height: src.settings.height };
	const cells: MulticamCell[] = [];
	shown.slice(layout.first, layout.first + layout.count).forEach((angle, k) => {
		const col = k % layout.cols;
		const row = Math.floor(k / layout.cols);
		const rect = { x: col * cellW, y: gridY + row * cellH, width: cellW, height: cellH };
		cells.push({ angle, camera: layout.first + k + 1, rect });
		const scale = Math.min(cellW / box.width, cellH / box.height) * 100;
		const track = vseq.videoTracks[1 + k]!;
		for (const m of onTrack) {
			if (m.sequenceId !== sourceSequenceId) continue;
			const id = `clp_MCV${String(k).padStart(3, '0')}${m.id.slice(-10)}`;
			clips[id] = {
				id,
				kind: 'nest-video',
				trackId: track.id,
				start: m.start,
				duration: m.duration,
				sourceIn: m.sourceIn,
				speed: m.speed,
				name: angle.name,
				label: m.label,
				enabled: true,
				linkId: null,
				groupId: null,
				markers: [],
				sequenceId: sourceSequenceId,
				multicam: { enabled: true, angle: angle.id },
				transform: {
					position: anim<[number, number]>([rect.x + rect.width / 2, rect.y + rect.height / 2]),
					anchor: anim<[number, number]>([box.width / 2, box.height / 2]),
					scale: anim(scale),
					scaleWidth: anim(scale),
					uniformScale: true,
					rotation: anim(0),
					flipH: false,
					flipV: false,
				},
				opacity: anim(100),
				blendMode: 'normal',
				effects: [],
				...(m.frameHold ? { frameHold: m.frameHold } : {}),
			} as unknown as Clip;
		}
	});
	let program: MulticamViewDoc['program'] = null;
	const len = sequenceDuration(seq);
	if (opts.showPreview && len > 0) {
		program = { x: half, y: gridY, width: half, height: gridH };
		const base = {
			start: 0,
			duration: len,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: false },
			name: 'Program',
			label: 'forest',
			enabled: true,
			linkId: null,
			groupId: null,
			markers: [],
			sequenceId: seqId,
		};
		clips.clp_MCVPROGRAMVIDEO = {
			...base,
			id: 'clp_MCVPROGRAMVIDEO',
			kind: 'nest-video',
			trackId: vseq.videoTracks[0]!.id,
			transform: {
				position: anim<[number, number]>([half + half / 2, H / 2]),
				anchor: anim<[number, number]>([W / 2, H / 2]),
				scale: anim(scaleToHalf * 100),
				scaleWidth: anim(scaleToHalf * 100),
				uniformScale: true,
				rotation: anim(0),
				flipH: false,
				flipV: false,
			},
			opacity: anim(100),
			blendMode: 'normal',
			effects: [],
		} as unknown as Clip;
	}
	// The program's sound plays in either layout (the grid cells are silent).
	if (len > 0)
		clips.clp_MCVPROGRAMAUDIO = {
			id: 'clp_MCVPROGRAMAUDIO',
			kind: 'nest-audio',
			trackId: vseq.audioTracks[0]!.id,
			start: 0,
			duration: len,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: false },
			name: 'Program',
			label: 'forest',
			enabled: true,
			linkId: null,
			groupId: null,
			markers: [],
			sequenceId: seqId,
			gainDb: 0,
			volumeDb: anim(0),
			pan: anim(0),
			effects: [],
		} as unknown as Clip;
	const virtual: Sequence = { ...vseq, clips };
	return {
		doc: { ...doc, sequences: { ...doc.sequences, [VIRTUAL_SEQ]: virtual } },
		sequenceId: VIRTUAL_SEQ,
		width,
		height: H,
		cells,
		program,
		layout,
		trackId,
		source,
		sourceSequenceId,
	};
}
