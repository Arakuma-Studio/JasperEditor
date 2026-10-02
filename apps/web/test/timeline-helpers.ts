// Shared fixtures for timeline tests: a real EditorSession on an in-memory document, a controller
// with a fixed geometry, and a probed video asset factory (no engine needed).
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type Sequence,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import {
	type Geometry,
	type PointerInfo,
	TimelineController,
} from '../src/panels/timeline/state/controller.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';

const WIDTH = 1000;
const HEIGHT = 404;

export function makeSession(opts: { preset?: string; seed?: number } = {}) {
	const ids = createCounterIdSource(opts.seed ?? 1);
	const doc = createEmptyProject({ ids, name: 'T', preset: opts.preset ?? 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-09-30T00:00:00.000Z', registries: defaultRegistries() },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	return { session, seqId };
}

let fp = 0;
export function videoAsset(seconds = 20, audio = true): Omit<MediaAsset, 'id'> {
	fp++;
	const streams: MediaAsset['probe']['streams'] = [
		{
			index: 0,
			type: 'video',
			codec: 'h264',
			width: 1920,
			height: 1080,
			pixelAspect: { num: 1, den: 1 },
			frameRate: { num: 30, den: 1 },
			pixelFormat: 'yuv420p',
			bitDepth: 8,
			color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
			browserDecodable: true,
		},
	];
	if (audio)
		streams.push({
			index: 1,
			type: 'audio',
			codec: 'aac',
			sampleRate: 48000,
			channels: 2,
			channelLayout: 'stereo',
		});
	return {
		kind: 'video',
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `clip-${fp}.mp4`,
		sizeBytes: 1,
		container: 'mov,mp4',
		probe: {
			durationFlicks: Math.round(seconds * 705_600_000),
			startTimecode: null,
			streams,
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-09-30T00:00:00.000Z',
	};
}

export function setupTimeline(opts: { pxPerFrame?: number; scrollFrame?: number } = {}) {
	const { session, seqId } = makeSession();
	session.setView(seqId, { pxPerFrame: opts.pxPerFrame ?? 10, scrollFrame: opts.scrollFrame ?? 0 });
	const ui = createTimelineUiStore();
	const geometry = (): Geometry => {
		const v = session.getState().views[seqId]!;
		const seq = session.getDrawn().sequences[seqId]! as Sequence;
		return {
			viewport: { scrollFrame: v.scrollFrame, pxPerFrame: v.pxPerFrame, width: WIDTH },
			layout: computeLayout({
				height: HEIGHT,
				dividerRatio: v.dividerRatio,
				videoTracks: seq.videoTracks,
				audioTracks: seq.audioTracks,
				heights: v.trackHeights,
				scrollYVideo: v.scrollYVideo,
				scrollYAudio: v.scrollYAudio,
			}),
		};
	};
	const toasts: string[] = [];
	const controller = new TimelineController({
		session,
		sequenceId: () => seqId,
		ui,
		geometry,
		toast: (_k, m) => toasts.push(m),
	});
	const seq = () => session.getCommitted().sequences[seqId]! as Sequence;
	const rowY = (label: string) => {
		const s = seq();
		const list = label[0] === 'V' ? s.videoTracks : s.audioTracks;
		const id = list[Number(label.slice(1)) - 1]!.id;
		const g = geometry().layout;
		const row = [...g.video.rows, ...g.audio.rows].find((r) => r.trackId === id)!;
		return row.y + row.height / 2;
	};
	const x = (frame: number) => {
		const v = session.getState().views[seqId]!;
		return (frame - v.scrollFrame) * v.pxPerFrame;
	};
	const spans = (label: string) => {
		const s = seq();
		const list = label[0] === 'V' ? s.videoTracks : s.audioTracks;
		const id = list[Number(label.slice(1)) - 1]!.id;
		return Object.values(s.clips)
			.filter((c) => c.trackId === id)
			.sort((a, b) => a.start - b.start)
			.map((c) => [c.start, c.start + c.duration]);
	};
	const clipsOn = (label: string) => {
		const s = seq();
		const list = label[0] === 'V' ? s.videoTracks : s.audioTracks;
		const id = list[Number(label.slice(1)) - 1]!.id;
		return Object.values(s.clips)
			.filter((c) => c.trackId === id)
			.sort((a, b) => a.start - b.start);
	};
	const history = () => session.getState().history.entries.map((e) => e.label);
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const pt = (px: number, py: number, mods: Partial<PointerInfo> = {}): PointerInfo => ({
		x: px,
		y: py,
		shift: false,
		ctrl: false,
		alt: false,
		button: 0,
		...mods,
	});
	/** Drag from (x0,y0) to (x1,y1) in a few pointer moves. */
	const drag = (
		x0: number,
		y0: number,
		x1: number,
		y1: number,
		mods: Partial<PointerInfo> = {},
		release = true,
	) => {
		controller.pointerDown(pt(x0, y0, mods));
		const steps = 4;
		for (let i = 1; i <= steps; i++)
			controller.pointerMove(pt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, mods));
		if (release) controller.pointerUp(pt(x1, y1, mods));
	};
	return {
		session,
		seqId,
		ui,
		controller,
		seq,
		rowY,
		x,
		spans,
		clipsOn,
		history,
		apply,
		pt,
		drag,
		toasts,
		geometry,
	};
}

export const solid = (at: number, duration: number, track: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [0, 0, 1, 1],
});
