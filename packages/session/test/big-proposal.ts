// A large sound-design proposal for the review perf tests: N place items (+ their bin, 25 sounds and N new cues as
// setup items), built with the WP3.2 draft builder on a sequence long enough for them.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type LibraryProvenance,
	type SoundProposalMedia,
	type SoundProposalPlacement,
	soundProposalItems,
} from '@jasper/project';
import { videoAsset } from '../../project/test/helpers.ts';
import { LIB } from '../../project/test/sound-fixtures.ts';
import { EditorSession } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();

function sound(i: number): SoundProposalMedia {
	const soundId = `snd_${(i + 1).toString(16).padStart(16, '0')}`;
	const library: LibraryProvenance = {
		...LIB,
		soundId,
		title: `Hit ${i + 1}`,
		descriptors: {
			...LIB.descriptors!,
			peakSec: 0.07,
			onsetSec: 0.06,
			headQuietSec: 0.05,
			durationSec: 0.55,
		},
		leadSilenceSec: 0.05,
	};
	const asset = videoAsset({ kind: 'audio', seconds: 0.55 }) as Record<string, unknown>;
	asset.fingerprint = `fp-${i}`;
	const fingerprint = asset.fingerprint as string;
	return {
		soundId,
		title: library.title,
		fingerprint,
		kind: 'audio',
		existingMediaId: null,
		library,
		register: { type: 'media.register', asset, name: library.title, ref: '$x', itemRef: '$xi' },
	};
}

export function bigProposal(session: EditorSession, engine: FakeEngine, n: number) {
	const seqId = Object.keys(session.getCommitted().sequences)[0]!;
	const sounds = Array.from({ length: 25 }, (_, i) => sound(i));
	const placements: SoundProposalPlacement[] = Array.from({ length: n }, (_, i) => {
		const a = sounds[i % 25]!;
		const b = sounds[(i + 1) % 25]!;
		return {
			id: `sfx:${String(i + 1).padStart(3, '0')}`,
			label: `${a.title} · cut`,
			group: i % 7 === 0 ? 'hero' : 'support',
			cue: {
				add: { frame: 30 + i * 12, kind: 'cut', weight: 'support', align: 'peak', source: 'derived' },
				label: 'Cue: cut',
			},
			layers: [{ soundId: a.soundId, role: 'support' }],
			ring: [a.soundId, b.soundId],
			alternatives: [{ soundId: b.soundId, label: b.title }],
		};
	});
	const built = soundProposalItems(session.getCommitted(), seqId, sounds, placements, {
		binName: 'Sound Effects',
	});
	if (built.missing.length) throw new Error(`missing ${built.missing.join(', ')}`);
	return engine.create({ feature: 'sound-design', title: 'Big pass', sequenceId: seqId, items: built.items });
}

export function bigSession(n: number) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	let session!: EditorSession;
	const engine = new FakeEngine(() => session);
	session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-16T10:00:00.000Z', registries: REG },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = session.apply({
		label: 'Setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 30 + n * 12 + 60, track: 'V1', color: [0, 0, 1, 1] },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, engine, seqId };
}
