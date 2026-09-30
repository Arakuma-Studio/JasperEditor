// Agent helpers shared by the bridge and the engine (WP-2H): queries, semantic addressing, guard rails.
import { describe, expect, it } from 'vitest';
import {
	AgentQueryError,
	approvalReasons,
	checkAgentTxLimits,
	exportAgentQuerySchemas,
	historyPseudoCommand,
	normalizeAgentTransaction,
	resolveAgentAddresses,
	runAgentQuery,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

function setup() {
	const h = new Harness({ preset: 'hd-1080p-30' });
	const mediaId = h.registerVideo({ seconds: 10 });
	const name = h.doc.media[mediaId]!.originalName;
	h.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
	h.ok([{ type: 'clip.addText', at: 30, duration: 60, track: 'V2', content: { text: 'Hello' } }]);
	h.ok([{ type: 'marker.add', frame: 15, name: 'Intro', markerType: 'comment' }]);
	return { h, mediaId, name };
}

describe('agent queries (S01 §21.2, S02:TL-951)', () => {
	it('sequence.summary reports tracks, markers and timecodes', () => {
		const { h } = setup();
		const r = runAgentQuery({ doc: h.doc, revision: h.revision }, 'sequence.summary') as {
			duration: { frames: number; timecode: string };
			tracks: { label: string; clipCount: number }[];
			markers: { name: string; timecode: string }[];
			clipCount: number;
		};
		expect(r.duration.frames).toBe(300);
		expect(r.duration.timecode).toBe('00:00:10:00');
		expect(r.tracks.find((t) => t.label === 'V1')?.clipCount).toBe(1);
		expect(r.tracks.find((t) => t.label === 'V2')?.clipCount).toBe(1);
		expect(r.markers[0]).toMatchObject({ name: 'Intro', timecode: '00:00:00:15' });
		expect(r.clipCount).toBe(3);
	});

	it('sequence.clipsInRange filters by range and track labels, with source seconds', () => {
		const { h } = setup();
		const r = runAgentQuery({ doc: h.doc, revision: h.revision }, 'sequence.clipsInRange', {
			from: '00:00:00:00',
			to: { seconds: 0.5 },
			tracks: ['V1', 'A1'],
		}) as {
			clips: { track: string; startTimecode: string; source: { outSeconds: number }; linked: string[] }[];
		};
		expect(r.clips.map((c) => c.track).sort()).toEqual(['A1', 'V1']);
		expect(r.clips[0]!.source.outSeconds).toBe(10);
		expect(r.clips[0]!.linked).toHaveLength(1);
	});

	it('sequence.at evaluates the stack at a frame (bottom → top)', () => {
		const { h } = setup();
		const r = runAgentQuery({ doc: h.doc, revision: h.revision }, 'sequence.at', { frame: 40 }) as {
			video: { track: string; opacity: number }[];
			audio: { track: string }[];
			timecode: string;
		};
		expect(r.video.map((v) => v.track)).toEqual(['V1', 'V2']);
		expect(r.video[1]!.opacity).toBe(100);
		expect(r.audio.map((a) => a.track)).toEqual(['A1']);
		expect(r.timecode).toBe('00:00:01:10');
	});

	it('doc.get supports paths and field projection; session-only queries need a session', () => {
		const { h } = setup();
		const env = { doc: h.doc, revision: h.revision };
		expect(runAgentQuery(env, 'doc.get', { path: ['sequences', h.seqId], fields: ['id'] })).toEqual({
			id: h.seqId,
		});
		expect(() => runAgentQuery(env, 'doc.get', { path: ['nope'] })).toThrow(AgentQueryError);
		expect(runAgentQuery(env, 'doc.revision')).toEqual({ revision: h.revision });
		expect(() => runAgentQuery(env, 'selection.get')).toThrowError(/session/);
		const media = runAgentQuery(env, 'media.list') as { media: { usage: { clips: number } }[] };
		expect(media.media[0]!.usage.clips).toBe(2);
		expect((runAgentQuery(env, 'validate') as { ok: boolean }).ok).toBe(true);
	});

	it('exports JSON Schemas for every query', () => {
		const s = exportAgentQuerySchemas();
		expect(Object.keys(s)).toContain('sequence.clipsInRange');
		expect(s['history.list'].sessionOnly).toBe(true);
		expect(s['sequence.at'].args).toHaveProperty('properties');
	});
});

describe('semantic addressing (S01:AGT-005, S02:TL-952)', () => {
	it('resolves mediaByName, clipAt and markerByName', () => {
		const { h, mediaId, name } = setup();
		const r = resolveAgentAddresses(h.doc, [
			{ type: 'clip.place', source: { mediaByName: name }, at: 400 },
			{ type: 'clip.update', clipId: { clipAt: { track: 'V2', at: '00:00:01:15' } }, patch: { name: 'T' } },
			{ type: 'marker.remove', markerId: { markerByName: 'Intro' } },
			{ type: 'clip.addText', at: 0, duration: 5, track: 'V3', content: { text: '{"mediaByName":"x"}' } },
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.commands[0] as { source: unknown }).source).toEqual({ mediaId });
		expect((r.commands[1] as { clipId: string }).clipId).toMatch(/^clp_/);
		expect((r.commands[2] as { markerId: string }).markerId).toMatch(/^mrk_/);
	});

	it('fails with E_AMBIGUOUS / E_NOT_FOUND and the command index', () => {
		const { h, name } = setup();
		const asset = { ...videoAsset(), originalName: name };
		h.ok([{ type: 'media.register', asset }]);
		const r = resolveAgentAddresses(h.doc, [
			{ type: 'x' },
			{ type: 'clip.place', source: { mediaByName: name }, at: 0 },
		]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors[0]).toMatchObject({ commandIndex: 1, code: 'E_AMBIGUOUS' });
		const miss = resolveAgentAddresses(h.doc, [
			{ type: 'clip.place', source: { mediaByName: 'nope.mov' }, at: 0 },
		]);
		expect(miss.ok ? null : miss.errors[0]!.code).toBe('E_NOT_FOUND');
	});
});

describe('guard rails (S01:AGT-011, UND-008)', () => {
	it('flags destructive commands and force', () => {
		expect(approvalReasons({ commands: [{ type: 'marker.add' }] })).toEqual([]);
		expect(approvalReasons({ commands: [{ type: 'track.remove', trackIds: ['V3'] }] })).toHaveLength(1);
		expect(approvalReasons({ commands: [{ type: 'clip.lift', clipIds: ['x'], force: true }] })).toHaveLength(
			1,
		);
		expect(approvalReasons({ commands: [{ type: 'track.remove' }], dryRun: true })).toEqual([]);
	});

	it('enforces limits and normalizes origins', () => {
		const many = { commands: Array.from({ length: 5001 }, () => ({ type: 'marker.add' })) };
		expect(checkAgentTxLimits(many)?.code).toBe('E_LIMIT');
		expect(checkAgentTxLimits({ commands: [] }, 21 * 1024 * 1024)?.code).toBe('E_LIMIT');
		expect(checkAgentTxLimits({ commands: [{ type: 'marker.add' }] })).toBeNull();
		const n = normalizeAgentTransaction({ origin: 'user', commands: [] }, 'curl');
		expect(n.origin).toEqual({ agent: 'curl' });
		expect(n.protocol).toBe('jasper.tx/1');
		expect(n.label).toBe('Agent transaction');
		expect(historyPseudoCommand({ commands: [{ type: 'history.undo' }] })).toBe('history.undo');
		expect(historyPseudoCommand({ commands: [{ type: 'history.undo' }, { type: 'x' }] })).toBeNull();
	});
});
