// Dev-only helpers (never shipped in production builds): insert sample clips without the engine or the
// Project panel, and expose the session for manual verification (`window.__jasperDev`).
import type { EditorSession } from '@jasper/session';

/** A probed 30 s 1080p30 movie with stereo audio (no real file; the engine key does not exist). */
function sampleAsset(n: number) {
	return {
		kind: 'video' as const,
		fingerprint: `q1:${(0xde0000 + n).toString(16).padStart(64, '0')}`,
		originalName: `sample-${n}.mp4`,
		sizeBytes: 1,
		container: 'mov,mp4',
		probe: {
			durationFlicks: 30 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video' as const,
					codec: 'h264',
					width: 1920,
					height: 1080,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' as const },
					browserDecodable: true,
				},
				{
					index: 1,
					type: 'audio' as const,
					codec: 'aac',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
			rotationDegrees: 0 as const,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store' as const, engineId: 'dev', key: `mk_dev_sample_${n}` }],
	};
}

let counter = 0;

/** One transaction with a linked A/V movie clip, a second movie, a color matte and a text clip. */
export function insertSampleClips(session: EditorSession, sequenceId: string): void {
	const n = ++counter;
	const r = session.apply({
		label: 'Dev: Sample Clips',
		origin: 'user',
		sequenceId,
		commands: [
			{ type: 'media.register', asset: sampleAsset(n * 2), ref: '$a' },
			{ type: 'media.register', asset: sampleAsset(n * 2 + 1), ref: '$b' },
			{
				type: 'clip.place',
				source: { mediaId: '$a' },
				at: 0,
				sourceRange: { in: { seconds: 2 }, out: { seconds: 10 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: '$b' },
				at: 240,
				sourceRange: { in: { seconds: 5 }, out: { seconds: 12 } },
			},
			{ type: 'clip.addSolid', at: 60, duration: 150, track: 'V2', color: [0.2, 0.4, 0.8, 1] },
			{ type: 'clip.addText', at: 120, duration: 120, track: 'V3', content: { text: 'Title' } },
		] as never[],
	});
	if (!r.ok) console.warn('[timeline dev] sample clips failed', r.errors);
}

export function exposeForDev(session: EditorSession): void {
	(globalThis as { __jasperDev?: unknown }).__jasperDev = { session };
}
