// The committed Kenney CC0 starter kit (spec 12 §0 decision 1, P1-R4; wp-note "WP1.2b starter kit"): the manifest the
// engine ships is valid, every file exists, decodes with the engine's FFmpeg and is accepted by the judge for its
// first type, the kit stays under its 8 MB budget, and the folder holds nothing the manifest does not list.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { judgeSound } from '@jasper/audio-fx';
import { isSoundTypeId, SOUND_EFFECT_TYPES, SOUND_TYPE_PROFILES } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/sounds/analysis-core.ts';
import { decodeSound } from '../src/sounds/decode.ts';
import { loadManifest, starterDir } from '../src/sounds/starter.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { ROOT, TEST_FFMPEG, TEST_FFPROBE } from './helpers.ts';

/** P1-R4: the bundled kit is at most 8 MB. */
const BUDGET_BYTES = 8 * 1024 * 1024;
const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const KENNEY = 'Kenney (www.kenney.nl)';
/** Types Kenney's packs have no recording for (the Jasper Synth fallback covers them); see the wp-note. */
const UNCOVERED = ['key'];

const DIR = starterDir({});
const STARTER_REL = 'apps/engine/sounds/starter';

describe('bundled starter kit', async () => {
	const m = await loadManifest(DIR);

	it('is found where the engine looks without an override, and its manifest is valid', () => {
		expect(DIR).toBe(join(ROOT, STARTER_REL));
		expect(m.status).toBe('ok');
		expect(m.errors).toEqual([]);
		expect(m.sounds.length).toBeGreaterThanOrEqual(40);
		expect(m.sounds.length).toBeLessThanOrEqual(60);
		expect(m.packs.length).toBeGreaterThan(0);
		for (const p of m.packs) {
			expect(p.id).toMatch(/^kenney-/);
			expect(p.url).toMatch(
				/^https:\/\/kenney\.nl\/media\/pages\/assets\/[a-z-]+\/[^/]+\/kenney_[a-z-]+\.zip$/,
			);
			expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(p.license).toBe('CC0-1.0');
			expect(p.licenseUrl).toBe(CC0_URL);
			expect(p.author).toBe(KENNEY);
		}
	});

	it('lists CC0 Kenney sounds with known types and tidy names', () => {
		const packIds = new Set(m.packs.map((p) => p.id));
		for (const s of m.sounds) {
			expect(s.file).toMatch(/^[a-z]+(-[a-z0-9]+)*-\d\d\.ogg$/);
			expect(s.types.length).toBeGreaterThan(0);
			for (const t of s.types) expect(isSoundTypeId(t)).toBe(true);
			expect(s.file.startsWith(`${s.types[0]}-`)).toBe(true);
			expect(s.license).toBe('CC0-1.0');
			expect(s.licenseUrl).toBe(CC0_URL);
			expect(s.author).toBe(KENNEY);
			expect(s.sourceUrl).toMatch(/^https:\/\/kenney\.nl\/assets\/[a-z-]+$/);
			expect(packIds.has(s.packId!)).toBe(true);
			// CC0 needs no credit line; the library generates none
			expect(s.attribution).toBeUndefined();
		}
	});

	it('covers every effect type Kenney has, with several variants of the commonest', () => {
		const count = (t: string) => m.sounds.filter((s) => s.types.includes(t as never)).length;
		expect(SOUND_EFFECT_TYPES.filter((t) => count(t) === 0)).toEqual(UNCOVERED);
		for (const t of ['hit', 'whoosh', 'click', 'pop', 'ui']) expect(count(t)).toBeGreaterThanOrEqual(3);
	});

	it('holds exactly the manifest files, within the size budget', () => {
		const listed = new Set(m.sounds.map((s) => s.file));
		const files = readdirSync(DIR).filter((f) => f !== 'manifest.json');
		const extra = files.filter((f) => !listed.has(f));
		expect(extra).toEqual([]);
		let total = 0;
		for (const s of m.sounds) {
			const size = statSync(join(DIR, s.file)).size;
			expect(size).toBeGreaterThan(1000);
			total += size;
		}
		expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
	});

	it('every file decodes at 48 kHz and the judge accepts it as its first type', {
		timeout: 300_000,
	}, async () => {
		const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
		const rejected: string[] = [];
		for (const s of m.sounds) {
			const d = await decodeSound(ff, join(DIR, s.file));
			expect(d.format.container).toBe('ogg');
			expect(d.format.sampleRate).toBe(48_000);
			expect([1, 2]).toContain(d.format.channels);
			expect(d.format.durationSec).toBeGreaterThan(0.01);
			expect(d.format.durationSec).toBeLessThanOrEqual(5);
			const { descriptors } = runAnalysis({
				kind: 'analyse',
				channels: d.channels,
				rate: d.rate,
				soundId: 'snd_0000000000000000',
				fingerprint: `q1:${'0'.repeat(64)}`,
				durationSec: d.format.durationSec,
			});
			const type = s.types[0]!;
			const j = judgeSound(descriptors!, SOUND_TYPE_PROFILES[type as keyof typeof SOUND_TYPE_PROFILES]);
			if (!j.ok) rejected.push(`${s.file}: ${j.reasons.join(', ')}`);
		}
		expect(rejected).toEqual([]);
	});
});
