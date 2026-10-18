// Shared fixtures of the Sound Library tests: library entries, a registered-sound answer, a fake engine client.
import {
	offeredTakes,
	type RegisterSoundResponse,
	type SoundEntry,
	type SoundPackInfo,
	type SoundSearchRequest,
	type SoundSearchResponse,
	soundEntryById,
	withOfferedTakes,
} from '@jasper/api';
import { rankSounds } from '@jasper/project';

let n = 0;
export function soundId(i: number): string {
	return `snd_${i.toString(16).padStart(16, '0')}`;
}

export function soundEntry(
	over: Partial<SoundEntry> & { peakSec?: number; durationSec?: number } = {},
): SoundEntry {
	n++;
	const { peakSec = 0.25, durationSec = 1, ...rest } = over;
	return {
		id: soundId(n),
		fingerprint: `q1:${n.toString(16).padStart(64, '0')}`,
		title: `Sound ${n}`,
		types: ['hit'],
		tags: [],
		source: { type: 'starter', file: `s${n}.wav` },
		license: 'CC0-1.0',
		author: 'Kenney',
		attribution: null,
		format: { durationSec, sampleRate: 48000, channels: 2, container: 'wav' },
		descriptors: {
			durationSec,
			peakSec,
			onsetSec: Math.max(0, peakSec - 0.01),
			riseMs: 5,
			decayMs: 200,
			decays: true,
			tailSec: 0.5,
			centroidHz: 800,
			rolloff85Hz: 3000,
			below150Share: 0.35,
			above6kShare: 0.02,
			flatness: 0.05,
			octaveBandsDb: [-20, -18, -16, -20, -24, -30, -40],
			pitchMidi: null,
			pitchConfidence: 0,
			onsetCount: 1,
			integratedLufs: -20,
			maxMomentaryLufs: -14,
			truePeakDb: -1,
			stereoWidth: 0.1,
			headQuietSec: Math.max(0, peakSec - 0.02),
			loopable: false,
		},
		judge: { ok: true, score: 0.9, reasons: [], type: 'hit' },
		indexedAt: '2026-10-15T00:00:00.000Z',
		analysisVersion: 1001,
		...rest,
	};
}

/** The engine's answer to `registerSound` for an entry (an audio asset of the entry's length). */
export function registered(e: SoundEntry, over: Partial<RegisterSoundResponse> = {}): RegisterSoundResponse {
	return {
		mediaKey: `mk_${e.id}`,
		fingerprint: e.fingerprint,
		originalName: `${e.title}.wav`,
		sizeBytes: 1000,
		container: 'wav',
		kind: 'audio',
		probe: {
			durationFlicks: Math.round(e.format.durationSec * 705_600_000),
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
		locators: [],
		browserPlayable: 'yes',
		library: {
			soundId: e.id,
			title: e.title,
			types: [...e.types],
			source: { type: 'starter' },
			license: e.license,
			author: e.author,
			attribution: e.attribution,
			descriptors: {
				peakSec: e.descriptors.peakSec,
				onsetSec: e.descriptors.onsetSec,
				headQuietSec: e.descriptors.headQuietSec,
				durationSec: e.descriptors.durationSec,
				octaveBandsDb: [...e.descriptors.octaveBandsDb],
				centroidHz: e.descriptors.centroidHz,
				maxMomentaryLufs: e.descriptors.maxMomentaryLufs,
			},
		},
		existingMediaId: null,
		...over,
	} as RegisterSoundResponse;
}

/**
 * The engine's answer for a sound registered with `leadSec` of silence put in front (what the engine does for sounds
 * whose head is not quiet): another file (fingerprint), longer by the lead, provenance descriptors moved by it.
 */
export function registeredPadded(e: SoundEntry, leadSec = 0.05): RegisterSoundResponse {
	const base = registered(e);
	const d = base.library.descriptors!;
	return {
		...base,
		mediaKey: `mk_${e.id}_pad`,
		fingerprint: `q1:${'f'.repeat(48)}${e.fingerprint.slice(-16)}`,
		probe: { ...base.probe, durationFlicks: Math.round((e.format.durationSec + leadSec) * 705_600_000) },
		library: {
			...base.library,
			descriptors: {
				...d,
				peakSec: d.peakSec + leadSec,
				onsetSec: d.onsetSec + leadSec,
				headQuietSec: d.headQuietSec + leadSec,
				durationSec: d.durationSec + leadSec,
			},
			leadSilenceSec: leadSec,
		},
	} as RegisterSoundResponse;
}

/** A fake engine client over a list of entries (search ranks them with the shared `rankSounds`). */
export function fakeSoundEngine(entries: SoundEntry[], opts: { packs?: SoundPackInfo[] } = {}) {
	const calls: { search: SoundSearchRequest[]; register: string[] } = { search: [], register: [] };
	return {
		calls,
		client: {
			soundLibraryStatus: async () => ({
				snapshotHash: 'h',
				sounds: entries.length,
				bySource: { starter: entries.length, pack: 0, folder: 0, synth: 0 },
				packs: 0,
				roots: 0,
				starter: { status: 'ok' as const, sounds: entries.length, errors: [] },
				indexedAt: '2026-10-15T00:00:00.000Z',
				needsIndex: false,
				recovered: false,
				indexing: null,
				synth: true,
				local: true,
			}),
			getSoundRoots: async () => ({ roots: [], local: true }),
			listSoundPacks: async () => ({ packs: opts.packs ?? [], catalogErrors: [] }),
			searchSounds: async (req: SoundSearchRequest): Promise<SoundSearchResponse> => {
				calls.search.push(req);
				// takes (P6-E9): rows of their own with `takes`, else counted on their recording; `material` filters
				const pool = (req.takes ? withOfferedTakes(entries) : entries).filter(
					(e) => !req.material || (e.materials ?? []).includes(req.material),
				);
				const materials: Record<string, number> = {};
				for (const e of entries) for (const m of e.materials ?? []) materials[m] = (materials[m] ?? 0) + 1;
				const ranked = rankSounds(pool, {
					...(req.q ? { query: req.q } : {}),
					...(req.types ? { types: req.types } : {}),
					license: req.license ?? 'commercial-safe',
				});
				const types: Record<string, number> = {};
				for (const r of rankSounds(entries, { ...(req.q ? { query: req.q } : {}), license: req.license }))
					for (const t of r.entry.types) types[t] = (types[t] ?? 0) + 1;
				return {
					snapshotHash: 'h',
					librarySize: entries.length,
					total: ranked.length,
					offset: req.offset ?? 0,
					results: ranked.slice(req.offset ?? 0, (req.offset ?? 0) + (req.limit ?? 50)).map((r) => {
						const { takes, ...sound } = r.entry;
						return {
							sound: takes ? sound : r.entry,
							score: r.score,
							parts: r.parts as never,
							...(takes ? { takeCount: offeredTakes(r.entry).length } : {}),
						};
					}),
					facets: { types, families: {}, licenses: {}, sources: {}, materials },
					indexing: false,
				};
			},
			getSound: async (id: string) => {
				const e = soundEntryById(id, (k) => entries.find((x) => x.id === k));
				if (!e) throw new Error('not found');
				return e;
			},
			getSoundVisual: async () => {
				throw new Error('no visual in tests');
			},
			soundAudioUrl: (id: string) => `/api/sounds/${id}/audio`,
			registerSound: async (id: string) => {
				calls.register.push(id);
				const e = soundEntryById(id, (k) => entries.find((x) => x.id === k));
				if (!e) throw new Error('not found');
				return registered(e);
			},
			indexSounds: async () => ({}) as never,
			putSoundRoots: async () => ({}) as never,
		},
	};
}

/** A pack as `GET /api/sounds/packs` lists it. */
export function soundPack(over: Partial<SoundPackInfo> = {}): SoundPackInfo {
	return {
		id: 'kenney-ui-audio',
		title: 'UI Audio',
		author: 'Kenney (www.kenney.nl)',
		description: 'Button clicks and switches.',
		license: 'CC0-1.0',
		licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
		licenseEvidence: [
			{
				url: 'https://kenney.nl/assets/ui-audio',
				statement: 'License: Creative Commons CC0',
				checkedAt: '2026-10-17',
			},
		],
		attribution: null,
		pageUrl: 'https://kenney.nl/assets/ui-audio',
		downloadUrl: 'https://kenney.nl/media/pages/assets/ui-audio/x/kenney_ui-audio.zip',
		sha256: 'a'.repeat(64),
		downloadBytes: 411_949,
		installBytes: 288_000,
		sounds: 45,
		inCatalog: true,
		state: 'available',
		installedAt: null,
		installedBytes: null,
		indexedSounds: 0,
		job: null,
		...over,
	};
}
