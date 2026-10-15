import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	createCounterIdSource,
	defaultEffectRegistry,
	loadProject,
	migrate,
	type ProjectDocument,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import type { MutationDocument, MutationEnvelope } from './project-mutation-fixtures.ts';

const fixture = (): MutationEnvelope =>
	JSON.parse(readFileSync(join(__dirname, 'fixtures/v1/basic.jasper'), 'utf8'));
const fixtureV2 = (): MutationEnvelope =>
	JSON.parse(readFileSync(join(__dirname, 'fixtures/v2/basic.jasper'), 'utf8'));

describe('persistence envelope and migrations (S01:PER-002, MIG-001…005)', () => {
	it('the v1 fixture always loads without repairs', () => {
		const r = loadProject(fixture(), { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		expect(r.document.name).toBe('Basic fixture');
		expect(Object.keys(Object.values(r.document.sequences)[0]!.clips)).toHaveLength(4);
	});
	it('v1 → v2 relabels default-labelled audio halves of A/V clips and nothing else', () => {
		const env = fixture();
		const m = migrate(env);
		expect(m.readOnly).toBe(false);
		expect(m.report).toEqual({
			fromVersion: 1,
			toVersion: CURRENT_SCHEMA_VERSION,
			steps: ['v1→v2', 'v2→v3', 'v3→v4', 'v4→v5', 'v5→v6', 'v6→v7'],
		});
		expect(m.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		const before = Object.values(env.document.sequences)[0]!;
		const after = Object.values(m.document.sequences)[0]!;
		for (const c of Object.values(before.clips)) {
			expect(after.clips[c.id]!.label).toBe(c.kind === 'audio' ? 'caribbean' : c.label);
		}
		const strip = (d: MutationDocument) => {
			const copy: MutationDocument = JSON.parse(JSON.stringify(d));
			for (const s of Object.values(copy.sequences))
				for (const c of Object.values(s.clips)) if (c.kind === 'audio') c.label = 'x';
			copy.schemaVersion = 0;
			return copy;
		};
		expect(strip(m.document)).toEqual(strip(env.document));
		expect(Object.values(before.clips).find((c) => c.kind === 'audio')!.label).toBe('violet');
	});
	it('v1 → v2 keeps labels the user chose on audio clips', () => {
		const env = fixture();
		const seq = Object.values(env.document.sequences)[0]!;
		const audio = Object.values(seq.clips).find((c) => c.kind === 'audio')!;
		audio.label = 'rose';
		const m = migrate(env);
		expect(Object.values(m.document.sequences)[0]!.clips[audio.id]!.label).toBe('rose');
	});
	it('the v2 fixture loads unchanged (v2 → … → v6 change no data it holds) and newer versions open read-only', () => {
		const env = fixtureV2();
		const m = migrate(env);
		expect(m.readOnly).toBe(false);
		expect(m.report.steps).toEqual(['v2→v3', 'v3→v4', 'v4→v5', 'v5→v6', 'v6→v7']);
		expect(m.document).toEqual({ ...env.document, schemaVersion: CURRENT_SCHEMA_VERSION });
		const r2 = loadProject(env, { effects: defaultEffectRegistry });
		expect(r2.repairs).toEqual([]);
		expect(r2.issues).toEqual([]);
		const newer = {
			...env,
			schemaVersion: CURRENT_SCHEMA_VERSION + 1,
			document: { ...env.document, schemaVersion: CURRENT_SCHEMA_VERSION + 1, futureField: { a: 1 } },
		};
		const r = loadProject(newer);
		expect(r.readOnly).toBe(true);
		expect((r.document as unknown as { futureField: unknown }).futureField).toEqual({ a: 1 });
	});
	it('rejects data that is not a project', () => {
		expect(() => loadProject({ format: 'something-else' })).toThrow();
		expect(() => loadProject({ format: 'jasper-project', document: { name: 3 } })).toThrow();
	});
});

describe('unknown data is preserved (S01:DOC-005, AC-24)', () => {
	it('AC-24: unknown effect id and unknown clip kind load, are bypassed, and survive edits and saves', () => {
		const env = fixture();
		const doc = env.document;
		const seq = Object.values(doc.sequences)[0]!;
		const video = Object.values(seq.clips).find((c) => c.kind === 'video')!;
		video.effects!.push({
			id: 'fx_000000000000FUTR',
			effectId: 'jasper.hologram',
			effectVersion: 3,
			enabled: true,
			params: { glow: { value: 0.7, keyframes: [] } },
			extra: 'kept',
		});
		video.futureField = { nested: true };
		const v2 = seq.videoTracks[1]!.id;
		seq.clips.clp_000000000000HOLO = {
			id: 'clp_000000000000HOLO',
			kind: 'hologram',
			trackId: v2,
			start: 400,
			duration: 30,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: true },
			name: 'Future',
			label: 'teal',
			enabled: true,
			linkId: null,
			groupId: null,
			markers: [],
			beam: { power: 9000 },
		};
		const loaded = loadProject(env, { effects: defaultEffectRegistry });
		expect(loaded.repairs).toEqual([]);
		expect(loaded.issues).toEqual([]);
		const saved = JSON.parse(JSON.stringify(loaded.document)) as ProjectDocument;
		const s2 = Object.values(saved.sequences)[0]!;
		expect((s2.clips.clp_000000000000HOLO as unknown as { beam: unknown }).beam).toEqual({ power: 9000 });
		expect((s2.clips[video.id] as unknown as { futureField: unknown }).futureField).toEqual({ nested: true });
		const snap = buildRenderSnapshot(loaded.document, s2.id, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		expect(snap.warnings.map((w) => w.clipId)).toContain('clp_000000000000HOLO');
		const h = new Harness();
		h.doc = loaded.document;
		const r = h.tx([{ type: 'clip.addSolid', at: 500, duration: 10, track: 'V2', color: [1, 1, 1, 1] }], {
			ctx: { registries: { ...h.ctx().registries } },
		});
		expect(r.ok).toBe(true);
		const after = Object.values(h.doc.sequences)[0]!;
		expect(after.clips.clp_000000000000HOLO).toEqual(s2.clips.clp_000000000000HOLO);
		h.ok([{ type: 'clip.addSolid', at: 420, duration: 30, track: 'V2', color: [1, 1, 1, 1] }]);
		expect(Object.values(h.doc.sequences)[0]!.clips.clp_000000000000HOLO!.duration).toBe(20);
		const fx = (
			after.clips[video.id] as unknown as { effects: { effectId: string; extra?: string }[] }
		).effects.find((e) => e.effectId === 'jasper.hologram');
		expect(fx?.extra).toBe('kept');
	});
});

describe('repair (S01:PER-004, AC-20)', () => {
	it('AC-20: overlapping clips open with a repair report; the later clip moves to a new track', () => {
		const env = fixture();
		const seq = Object.values(env.document.sequences)[0]!;
		const text = Object.values(seq.clips).find((c) => c.kind === 'text')!;
		const solid = Object.values(seq.clips).find((c) => c.kind === 'solid')!;
		solid.trackId = text.trackId;
		solid.start = text.start + 10; // overlaps the text clip
		const r = loadProject(env, { ids: createCounterIdSource(3), effects: defaultEffectRegistry });
		expect(r.repairs.map((x) => x.action)).toContain('move-overlap');
		expect(r.issues).toEqual([]);
		const s = Object.values(r.document.sequences)[0]!;
		expect(s.clips[solid.id]!.trackId).not.toBe(text.trackId);
		expect(s.videoTracks.length).toBe(4);
		expect(checkInvariants(r.document)).toEqual([]);
	});
	it('drops dangling references and dissolves broken link groups', () => {
		const env = fixture();
		const seq = Object.values(env.document.sequences)[0]!;
		const audio = Object.values(seq.clips).find((c) => c.kind === 'audio')!;
		delete seq.clips[audio.id];
		env.document.rootItems.push('itm_000000000000GONE');
		const r = loadProject(env, { ids: createCounterIdSource(3) });
		expect(r.issues).toEqual([]);
		expect(r.repairs.map((x) => x.action)).toEqual(
			expect.arrayContaining(['drop-reference', 'dissolve-links']),
		);
	});
});
