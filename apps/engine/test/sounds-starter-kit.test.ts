// The committed Kenney CC0 starter kit (spec 12 §0 decision 1, P1-R4; wp-note "WP1.2b starter kit"): the manifest the
// engine ships is valid, every file exists, decodes with the engine's FFmpeg and is accepted by the judge for its
// first type, the kit stays under its 8 MB budget, and the folder holds nothing the manifest does not list.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { judgeSound } from '@jasper/audio-fx';
import { isSoundTypeId, SOUND_EFFECT_TYPES, SOUND_TYPE_PROFILES } from '@jasper/project';
import { repoRoot } from '@jasper/testkit/env';
import { requireTool } from '@jasper/testkit/oracle';
import { describe, expect, it } from 'vitest';
import { runAnalysis } from '../src/sounds/analysis-core.ts';
import { decodeSound } from '../src/sounds/decode.ts';
import { loadManifest, starterDir } from '../src/sounds/starter.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';

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
		expect(DIR).toBe(join(repoRoot(), STARTER_REL));
		expect(m.status).toBe('ok');
		expect(m.errors).toEqual([]);
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

	it('ships CC0 Kenney provenance and known types', () => {
		const packIds = new Set(m.packs.map((p) => p.id));
		for (const s of m.sounds) {
			expect(s.types.length).toBeGreaterThan(0);
			for (const t of s.types) expect(isSoundTypeId(t)).toBe(true);
			expect(s.license).toBe('CC0-1.0');
			expect(s.licenseUrl).toBe(CC0_URL);
			expect(s.author).toBe(KENNEY);
			expect(s.sourceUrl).toMatch(/^https:\/\/kenney\.nl\/assets\/[a-z-]+$/);
			expect(packIds.has(s.packId!)).toBe(true);
			// CC0 needs no credit line; the library generates none
			expect(s.attribution).toBeUndefined();
		}
	});

	it('covers every effect type available from the bundled source', () => {
		const count = (t: string) => m.sounds.filter((s) => s.types.includes(t as never)).length;
		expect(SOUND_EFFECT_TYPES.filter((t) => !UNCOVERED.includes(t) && count(t) === 0)).toEqual([]);
	});

	it('holds exactly the manifest files, within the size budget', () => {
		const listed = new Set(m.sounds.map((s) => s.file));
		const files = readdirSync(DIR).filter((f) => f !== 'manifest.json');
		const extra = files.filter((f) => !listed.has(f));
		expect(extra).toEqual([]);
		let total = 0;
		for (const s of m.sounds) {
			const size = statSync(join(DIR, s.file)).size;
			total += size;
		}
		expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
	});

	it('every file decodes at 48 kHz and the judge accepts it as its first type', {
		timeout: 300_000,
	}, async (ctx) => {
		const ff = new Ffmpeg({
			ffmpeg: requireTool('ffmpeg', 'bundled starter kit', ctx),
			ffprobe: requireTool('ffprobe', 'bundled starter kit', ctx),
		});
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
