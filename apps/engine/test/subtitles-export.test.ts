// spec 13 AS-005: subtitle groups of text clips export as sidecar files and embedded streams like caption tracks.
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
	readCaptionFile,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import {
	captionPlanWarnings,
	embeddedTracks,
	sidecarBytes,
	sidecarName,
	sidecarTracks,
} from '../src/export/captions.ts';

function project(): { doc: ProjectDocument; groupId: string } {
	const ids = createCounterIdSource(3);
	let doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const ctx = { ids, now: () => '2026-10-25T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
	const run = (commands: unknown[]) => {
		const r = applyTransaction(doc, { label: 't', origin: 'user', sequenceId: seqId, commands }, ctx);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		return r.result;
	};
	const media = run([
		{
			type: 'media.register',
			asset: {
				kind: 'audio',
				fingerprint: `q1:${'a'.repeat(64)}`,
				originalName: 'a.wav',
				sizeBytes: 1000,
				container: 'wav',
				probe: {
					durationFlicks: 10 * FLICKS_PER_SECOND,
					startTimecode: null,
					streams: [
						{
							index: 0,
							type: 'audio',
							codec: 'pcm_s16le',
							sampleRate: 48000,
							channels: 2,
							channelLayout: 'stereo',
						},
					],
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
				locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_a' }],
				derivation: null,
				importedAt: '2026-10-25T00:00:00.000Z',
			},
		},
	]).results[0] as { mediaId: string };
	run([{ type: 'clip.place', source: { mediaId: media.mediaId }, at: 0, tracks: { audio: ['A1'] } }]);
	const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
	run([
		{
			type: 'transcript.create',
			mediaId: media.mediaId,
			language: 'es',
			origin: 'manual',
			words: [
				{ text: 'Hola', start: s(1), end: s(1.4) },
				{ text: 'mundo.', start: s(1.4), end: s(2) },
				{ text: 'Chau', start: s(4), end: s(4.5) },
			],
		},
	]);
	const g = run([{ type: 'captions.generate', template: 'builtin:bold-pop' }]).results[0] as {
		groupId: string;
	};
	return { doc, groupId: g.groupId };
}

describe('subtitle groups as caption outputs', () => {
	it('sidecars: "active" falls back to the first group; a group by id; SRT round trip', () => {
		const { doc, groupId } = project();
		const seq = Object.values(doc.sequences)[0]!;
		const range = { start: 0, end: 300 };
		const side = sidecarTracks(doc, seq, { sidecar: ['srt'] }, range);
		expect(side.map((o) => o.track.id)).toEqual([groupId]);
		expect(sidecarTracks(doc, seq, { sidecar: ['vtt'], sidecarTracks: [groupId] }, range)).toHaveLength(1);
		const bytes = sidecarBytes(side[0]!, 'srt', seq, undefined);
		const back = readCaptionFile(bytes, { format: 'srt' });
		expect(back.ok && back.doc.cues.map((c) => c.text)).toEqual(['HOLA MUNDO.', 'CHAU']);
		expect(sidecarName('output', side[0]!, 'srt', true)).toBe('output.srt');
		expect(embeddedTracks(doc, seq, { embed: true }, range)).toHaveLength(1);
		expect(captionPlanWarnings(doc, seq, { captions: { sidecar: ['srt'] } }, range)).toEqual([]);
		expect(() =>
			sidecarTracks(doc, seq, { sidecar: ['srt'], sidecarTracks: ['cgp_NOPE000000000000'] }, range),
		).toThrow();
	});
});
