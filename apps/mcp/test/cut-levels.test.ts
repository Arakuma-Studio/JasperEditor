// Cut levels for agent transactions (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): a text cut
// gets the cached voice analysis around its edges attached, an exact range cut does not, and a media without an
// analysis leaves the command as it was.
import {
	applyTransaction,
	buildVoiceAnalysis,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/context.ts';
import { withCutLevels } from '../src/cut-levels.ts';

const S = 705_600_000;

function setup() {
	const ids = createCounterIdSource(7);
	const doc0: ProjectDocument = createEmptyProject({ ids, name: 'Cut', preset: 'hd-1080p-25' });
	const seqId = Object.keys(doc0.sequences)[0]!;
	const asset = {
		kind: 'audio',
		fingerprint: `q1:${'a'.repeat(64)}`,
		originalName: 'voice.wav',
		sizeBytes: 1000,
		container: 'wav',
		probe: {
			durationFlicks: 10 * S,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 1,
					channelLayout: 'mono',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_aaaaaaaaaaaaaaaaaaaaaaaa' }],
		derivation: null,
		importedAt: '2026-11-14T00:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
	const r = applyTransaction(
		doc0,
		{
			protocol: 'jasper.tx/1',
			sequenceId: seqId,
			origin: 'user',
			label: 'setup',
			commands: [
				{ type: 'media.register', asset, ref: '$m' },
				{
					type: 'clip.place',
					source: { mediaId: '$m' },
					at: 0,
					tracks: { audio: ['A1'] },
					mode: 'overwrite',
				},
				{
					type: 'transcript.create',
					mediaId: '$m',
					language: 'es',
					origin: 'manual',
					words: [
						{ text: 'uno', start: 1 * S, end: 1.5 * S, confidence: 0.9 },
						{ text: 'dos', start: 2 * S, end: 2.5 * S, confidence: 0.9 },
					],
				},
			],
		} as never,
		{ ids, now: () => '2026-11-14T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	const n = 1000;
	const planes = {
		level: new Uint8Array(n).fill(100),
		voicing: new Uint8Array(n),
		flatness: new Uint8Array(n),
	};
	const analysis = buildVoiceAnalysis({
		fingerprint: asset.fingerprint,
		stream: 0,
		samples: n * 160,
		planes,
	});
	const engine = (has: boolean) =>
		({
			engine: async (fn: (c: unknown) => Promise<unknown>) =>
				fn({
					getVoiceAnalysis: async () => {
						if (!has) throw new Error('VOICE_ANALYSIS_NOT_FOUND');
						return analysis;
					},
				}),
		}) as unknown as Pick<ToolContext, 'engine'>;
	return { doc: r.document, seqId, engine };
}

describe('cut levels for agent transactions', () => {
	it('attaches the voice analysis around a text cut, not to an exact range cut', async () => {
		const { doc, seqId, engine } = setup();
		const out = (await withCutLevels(
			engine(true),
			async () => ({ doc }),
			[
				{ type: 'transcript.extract', fromWord: 1, toWord: 1 },
				{ type: 'range.extract', from: 10, to: 20 },
				{ type: 'range.extract', from: 10, to: 20, snapToSilence: true },
			],
			seqId,
		)) as Array<{ levels?: Array<{ from: number; level: string }> }>;
		expect(out[0]!.levels?.length).toBe(1);
		// 0.55 s each side of the cut (frames 50–63 at 25 fps = 2.0–2.52 s)
		expect(out[0]!.levels![0]!.from).toBe(145);
		expect(out[1]!.levels).toBeUndefined();
		expect(out[2]!.levels?.length).toBe(1);
	});

	it('leaves the commands as they are without an analysis', async () => {
		const { doc, seqId, engine } = setup();
		const cmds = [{ type: 'transcript.lift', fromWord: 0, toWord: 0 }];
		expect(await withCutLevels(engine(false), async () => ({ doc }), cmds, seqId)).toEqual(cmds);
	});
});
