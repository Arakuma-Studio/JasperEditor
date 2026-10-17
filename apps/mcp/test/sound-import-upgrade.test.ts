// WP6.5b: import_sounds / insert_sound / swap_sound build their media commands with `importCommands`: a project holding
// an older copy of a library sound (another fingerprint, same soundId) gets the new copy in place
// (`media.upgradeLibraryCopy`), not a second media.
import type { RegisterSoundResponse } from '@jasper/api';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { importCommands } from '../src/tools/sound.ts';

const SOUND = 'snd_0123456789abcdef';
const ids = createCounterIdSource(5);
const ctx = (revision: number) => ({
	ids,
	now: () => '2026-10-17T00:00:00.000Z',
	revision,
	registries: defaultRegistries(),
});

function reg(fp: string, lead: number): RegisterSoundResponse {
	const dur = 0.9 + lead;
	return {
		mediaKey: `mk_${fp.slice(-24)}`,
		fingerprint: fp,
		originalName: 'Impact.wav',
		sizeBytes: 1000,
		container: 'wav',
		kind: 'audio',
		probe: {
			durationFlicks: Math.round(dur * FLICKS_PER_SECOND),
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_f32le',
					sampleRate: 48000,
					channels: 1,
					channelLayout: 'mono',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [],
		browserPlayable: 'yes',
		library: {
			soundId: SOUND,
			title: 'Impact',
			types: ['hit'],
			source: { type: 'starter' },
			license: 'CC0-1.0',
			author: 'Kenney',
			attribution: null,
			descriptors: {
				peakSec: 0.0123 + lead,
				onsetSec: 0.011 + lead,
				headQuietSec: 0.0105 + lead,
				durationSec: dur,
				octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
				centroidHz: 1820,
				maxMomentaryLufs: -14.2,
			},
			...(lead ? { leadSilenceSec: lead } : {}),
			snapshotHash: 'sha256:abc',
		},
		existingMediaId: null,
	} as RegisterSoundResponse;
}

function apply(doc: ProjectDocument, commands: unknown[], revision: number) {
	const r = applyTransaction(doc, { label: 't', origin: 'user', commands: commands as never }, ctx(revision));
	expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
	return r;
}

describe('importCommands and older copies', () => {
	it('upgrades the older copy in place: one media, its clip moved by the lead', () => {
		let doc = createEmptyProject({ ids, name: 'Import', preset: 'hd-1080p-30' });
		const old = reg(`q1:${'0'.repeat(63)}1`, 0);
		const first = importCommands(doc, [{ soundId: SOUND, reg: old, title: 'Impact' }]);
		expect(first.commands.map((c) => c.type)).toEqual(['bin.create', 'media.register']);
		let r = apply(doc, first.commands, 0);
		doc = r.document;
		const mediaId = r.result.ok ? r.result.refs.$s0! : '';
		r = apply(
			doc,
			[{ type: 'soundDesign.place', frame: 40, layers: [{ mediaId, gainDb: 0, ref: '$c' }] }],
			1,
		);
		doc = r.document;
		const clipId = r.result.ok ? r.result.refs.$c! : '';
		const seqId = Object.keys(doc.sequences)[0]!;
		const before = { ...(doc.sequences[seqId]!.clips[clipId] as { sourceIn: number; start: number }) };
		// the engine now gives another copy (50 ms of lead silence)
		const next = reg(`q1:${'0'.repeat(63)}2`, 0.05);
		const plan = importCommands(doc, [{ soundId: SOUND, reg: next, title: 'Impact' }]);
		expect(plan.commands.map((c) => c.type)).toEqual(['media.upgradeLibraryCopy']);
		expect(plan.media[0]).toMatchObject({ upgradedFrom: mediaId, ref: '$s0', reused: false });
		r = apply(doc, plan.commands, 2);
		doc = r.document;
		expect(r.result.ok && r.result.refs.$s0).toBe(mediaId);
		expect(Object.keys(doc.media)).toEqual([mediaId]);
		expect(doc.media[mediaId]!.fingerprint).toBe(next.fingerprint);
		const after = doc.sequences[seqId]!.clips[clipId] as { sourceIn: number; start: number };
		expect(after.start).toBe(before.start);
		expect(after.sourceIn).toBe(before.sourceIn + 0.05 * FLICKS_PER_SECOND);
		// importing it again reuses it
		const again = importCommands(doc, [{ soundId: SOUND, reg: next, title: 'Impact' }]);
		expect(again.commands).toEqual([]);
		expect(again.media[0]).toMatchObject({ mediaId, reused: true });
	});
});
