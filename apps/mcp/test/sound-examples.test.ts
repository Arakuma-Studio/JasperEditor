// The describe_commands examples of the sound-design commands run against a real project (spec 12 §2.9).
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	mixFingerprint,
	resolveAgentAddresses,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES } from '../src/examples.ts';

const SOUND_COMMANDS = [
	'media.setLibraryInfo',
	'media.upgradeLibraryCopy',
	'soundCue.add',
	'soundCue.update',
	'soundCue.remove',
	'soundCue.resync',
	'soundDesign.place',
	'soundDesign.swap',
	'soundDesign.setRole',
	'soundDesign.setPalette',
	'soundDesign.setSettings',
	'soundDesign.setPeak',
	'soundDesign.applyGains',
	'soundDesign.setAutoGain',
	'soundDesign.setCheck',
	'soundDesign.setVerdict',
	'soundDesign.expectMix',
	'audio.volumeDip',
	'soundDesign.applyStopBefore',
	'soundDesign.applyBuild',
	'soundDesign.ensureBus',
	'soundDesign.removeBus',
	'soundDesign.applyDelivery',
];

/** A music clip on A1 (Phase 4 mixing examples). */
const MUSIC = [
	{
		type: 'clip.place',
		source: { mediaByName: 'clip-a.mp4' },
		at: 0,
		tracks: { audio: 'A1' },
		ref: '$music',
	},
	{ type: 'essentialSound.setType', clipIds: ['$music'], audioType: 'music' },
];
const HERO = (extra: Record<string, unknown>) => ({
	type: 'soundCue.add',
	cues: [{ id: 'cue_00000000000000EX', frame: 25, kind: 'land', weight: 'hero', source: 'user', ...extra }],
});

/** Examples whose prelude runs in the same transaction (they use a `$ref` the prelude binds). */
const SAME_TX = new Set(['soundDesign.applyGains']);

/** What an example needs in the project first (a cue to edit, a placed sound to swap). */
const PRELUDE: Record<string, unknown[]> = {
	// an older copy of the starter hit (the Ogg as it is: no lead silence), placed once
	'media.upgradeLibraryCopy': [
		{
			type: 'media.register',
			asset: {
				kind: 'audio',
				fingerprint: 'q1:00000000000000000000000000000000000000000000000000000000000e0000',
				originalName: 'impact-old.ogg',
				sizeBytes: 9000,
				container: 'ogg',
				probe: {
					durationFlicks: 635_040_000,
					startTimecode: null,
					streams: [
						{
							index: 0,
							type: 'audio',
							codec: 'vorbis',
							sampleRate: 48_000,
							channels: 1,
							channelLayout: 'mono',
						},
					],
					rotationDegrees: 0,
					hasAlpha: false,
					variableFrameRate: false,
				},
				locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_00000000000000000000e000' }],
				library: {
					soundId: 'snd_0123456789abcdef',
					title: 'Impact Metal 03',
					types: ['hit'],
					source: { type: 'starter' },
					license: 'CC0-1.0',
					author: 'Kenney',
					attribution: null,
					descriptors: {
						peakSec: 0.0123,
						onsetSec: 0.011,
						headQuietSec: 0.0105,
						durationSec: 0.9,
						octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
						centroidHz: 1820,
						maxMomentaryLufs: -14.2,
					},
				},
			},
			ref: '$old',
		},
		{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: '$old', track: 'A1' }] },
	],
	'soundCue.update': [
		{
			type: 'soundCue.add',
			cues: [{ id: 'cue_00000000000000EX', frame: 30, kind: 'cut', weight: 'support', source: 'user' }],
		},
	],
	'soundCue.remove': [
		{
			type: 'soundCue.add',
			cues: [{ id: 'cue_00000000000000EX', frame: 30, kind: 'cut', weight: 'support', source: 'user' }],
		},
	],
	'soundDesign.swap': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.setRole': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.setPeak': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.applyGains': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1', ref: '$sfx' }],
		},
	],
	'soundDesign.setAutoGain': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'audio.volumeDip': MUSIC,
	'soundDesign.applyStopBefore': [...MUSIC, HERO({ stopBefore: { seconds: 0.25, depthDb: -24 } })],
	'soundDesign.applyBuild': [...MUSIC, HERO({ build: { seconds: 0.5, fromHz: 150, toHz: 2000 } })],
	'soundDesign.ensureBus': [
		{
			type: 'soundDesign.place',
			frame: 30,
			layers: [{ mediaId: { mediaByName: 'clip-a.mp4' }, align: 'start', track: 'A1' }],
		},
	],
	'soundDesign.removeBus': [{ type: 'soundDesign.ensureBus' }],
	'soundDesign.setVerdict': MUSIC,
	'soundDesign.applyDelivery': MUSIC,
};

describe('sound-design describe_commands examples', () => {
	it.each(SOUND_COMMANDS)('%s applies to a project with clip-a.mp4', (type) => {
		const ids = createCounterIdSource(3);
		const ctx = { ids, now: () => '2026-10-15T00:00:00.000Z', revision: 0, registries: defaultRegistries() };
		const empty = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const reg = applyTransaction(
			empty,
			{
				label: 'import',
				origin: 'user',
				commands: [
					{
						type: 'media.register',
						asset: {
							kind: 'video',
							fingerprint: 'q1:example',
							originalName: 'clip-a.mp4',
							sizeBytes: 1,
							container: 'mov,mp4',
							probe: {
								durationFlicks: 705_600_000,
								startTimecode: null,
								streams: [
									{
										index: 0,
										type: 'audio',
										codec: 'aac',
										sampleRate: 48_000,
										channels: 2,
										channelLayout: 'stereo',
									},
								],
								rotationDegrees: 0,
								hasAlpha: false,
								variableFrameRate: false,
							},
							locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_example' }],
						},
					},
				],
			},
			ctx,
		);
		expect(reg.result.ok).toBe(true);
		const example = COMMAND_EXAMPLES[type];
		expect(example).toBeDefined();
		let doc = reg.document;
		const prelude = SAME_TX.has(type) ? undefined : PRELUDE[type];
		if (prelude) {
			const p = resolveAgentAddresses(doc, prelude);
			expect(p.ok).toBe(true);
			if (!p.ok) return;
			const pr = applyTransaction(
				doc,
				{ label: 'prelude', origin: 'user', commands: p.commands },
				{ ...ctx, revision: 1 },
			);
			expect(pr.result.ok, JSON.stringify(pr.result)).toBe(true);
			doc = pr.document;
		}
		// the precondition's example names a hash: the measured mix's (here the document's own); the literal one refuses
		const seqId = Object.keys(doc.sequences)[0]!;
		let cmd = example;
		if (type === 'soundDesign.expectMix') {
			const stale = applyTransaction(doc, { label: 'stale', origin: 'user', commands: [example] }, ctx);
			expect(stale.result.ok ? null : stale.result.errors[0]!.code).toBe('E_REVISION_MISMATCH');
			cmd = { ...(example as Record<string, unknown>), mixHash: mixFingerprint(doc, seqId) };
		}
		const resolved = resolveAgentAddresses(doc, [...(SAME_TX.has(type) ? PRELUDE[type]! : []), cmd]);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		const r = applyTransaction(
			doc,
			{ label: 'example', origin: 'user', commands: resolved.commands },
			{ ...ctx, revision: 2 },
		);
		expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
	});
});
