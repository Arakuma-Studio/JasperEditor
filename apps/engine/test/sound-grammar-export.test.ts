// The cue grammar MEASURED in an export (spec 12 P6-E10 "Done when": "on the fixture a 4-card stagger climbs
// 0 / +1 / +2 / +3 st, measured in the export"; "clicks share one sound and one level"; "key sounds play at rate 1").
// A real engine indexes a generated kit (three 1 kHz pops, two clicks, a typing run of 8 key presses); the plan job
// proposes sounds for a typing + UI fixture (a typewriter, four Pop cards 0.5 s apart, three "sfx: click" markers), the
// editor accepts every item (one transaction), the sequence is exported (native, PCM) and the audio is measured: the
// pops' frequencies give the climb in semitones, the clicks' peaks their level, the keys' clips their speed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EngineJob, type SoundDesignPlanResult, SoundDesignPlanResultSchema } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	type ClipSfx,
	frameToSample,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	soundCuesOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, ROOT, TEST_FFMPEG, type TestApp, tempAppdir } from './helpers.ts';

const SR = 48_000;
const POP_HZ = 1000;
const ENV_KEYS = ['JASPER_SOUND_STARTER_DIR', 'JASPER_SOUND_SYNTH_VARIANTS', 'JASPER_SOUND_AUTO_INDEX'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function lcg(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}
/** A pop: a 1 kHz sine with a 2 ms attack and an exponential decay τ (seconds), 0.25 s. */
function pop(tau: number): Float32Array {
	return Float32Array.from({ length: Math.round(0.25 * SR) }, (_, i) => {
		const t = i / SR;
		return 0.6 * Math.min(1, t / 0.002) * Math.exp(-t / tau) * Math.sin(2 * Math.PI * POP_HZ * t);
	});
}
/** A click: 3 kHz + noise under a 2 ms decay. */
function click(seed: number): Float32Array {
	const r = lcg(seed);
	return Float32Array.from({ length: Math.round(0.08 * SR) }, (_, i) => {
		const t = i / SR;
		return 0.7 * Math.exp(-t / 0.002) * (0.5 * r() + 0.5 * Math.sin(2 * Math.PI * 3000 * t));
	});
}
function typing(): Float32Array {
	const r = lcg(77);
	const x = Float32Array.from({ length: Math.round(4.6 * SR) }, () => 3e-4 * r());
	const add = (at: number, amp: number, seed: number) => {
		const q = lcg(seed);
		for (let i = 0; i < 0.06 * SR; i++)
			x[at + i] =
				x[at + i]! +
				amp * Math.exp(-i / (0.005 * SR)) * (0.6 * q() + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR));
	};
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * SR);
		add(down, 0.6, 200 + k);
		add(down + Math.round(0.08 * SR), 0.3, 300 + k);
	}
	return x;
}

function makeKit(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const files: [string, Float32Array, string, string[]][] = [
		['pop_a.wav', pop(0.05), 'Bubble pop a', ['pop']],
		['pop_b.wav', pop(0.045), 'Bubble pop b', ['pop']],
		['pop_c.wav', pop(0.055), 'Bubble pop c', ['pop']],
		['click_a.wav', click(1), 'Mouse click', ['click']],
		['click_b.wav', click(2), 'Switch click', ['click']],
		['typing.wav', typing(), 'Keyboard typing run', ['key']],
	];
	for (const [file, x] of files) writeFileSync(join(dir, file), encodeWav([x, x], SR, 's16'));
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: files.map(([file, , title, types]) => ({
				file,
				title,
				types,
				tags: ['test'],
				author: 'Test Author',
				license: 'CC0-1.0',
			})),
		}),
	);
	return dir;
}

/** The fixture (30 fps): a typewriter at 30, four Pop cards from 120 every 15 frames, clicks at 240 / 270 / 300. */
function fixtureDoc(): { doc: ProjectDocument; seqId: string } {
	const b = new DocBuilder('hd-1080p-30', 61);
	b.tx([
		{
			type: 'clip.addText',
			at: 30,
			duration: 60,
			track: 'V2',
			content: { text: 'TYPE IT' },
			textAnimation: { in: { preset: 'typewriter', durationFrames: 40 } },
		},
	]);
	for (const [i, at] of [120, 135, 150, 165].entries())
		b.tx([
			{
				type: 'clip.addText',
				at,
				// the last card stays up to 12 s: the sequence covers the click markers
				duration: i === 3 ? 195 : 60,
				track: `V${i + 3}`,
				content: { text: `Card ${i + 1}` },
				textAnimation: { in: { preset: 'pop', durationFrames: 10 } },
			},
		]);
	b.tx([
		{ type: 'marker.add', frame: 240, name: 'sfx: click' },
		{ type: 'marker.add', frame: 270, name: 'sfx: click' },
		{ type: 'marker.add', frame: 300, name: 'sfx: click' },
	]);
	return { doc: b.doc, seqId: b.seqId };
}

function decodeF32(file: string): Float32Array {
	const out = execFileSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-'], {
		maxBuffer: 1 << 30,
	});
	return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

/** Frequency of a tone in `x[from, from + n)`: zero crossings (upward) with linear interpolation, over whole periods. */
function frequencyOf(x: Float32Array, from: number, n: number): number {
	const ups: number[] = [];
	for (let i = from + 1; i < from + n && i < x.length; i++)
		if (x[i - 1]! < 0 && x[i]! >= 0) ups.push(i - 1 + x[i - 1]! / (x[i - 1]! - x[i]!));
	if (ups.length < 3) return Number.NaN;
	return ((ups.length - 1) * SR) / (ups[ups.length - 1]! - ups[0]!);
}

let app: TestApp;
let projectId = '';
let seqId = '';
let result: SoundDesignPlanResult;
let exported: Float32Array;
let applied: ProjectDocument;

async function waitJob(id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-grammar-kit-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	app = await makeApp();
	const idx = await app.inject({ method: 'POST', url: '/api/sounds/index', headers: JSON_H, payload: {} });
	expect(idx.statusCode, idx.body).toBe(202);
	expect((await waitJob((idx.json() as EngineJob).id)).state).toBe('succeeded');
	const f = fixtureDoc();
	seqId = f.seqId;
	projectId = 'prj_00000000000000E6';
	const doc = { ...f.doc, projectId };
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' })),
	);
	// the plan job (Auto Sound Pass / plan_sound_design): every derived cue, grammar on its defaults
	const plan = await app.inject({
		method: 'POST',
		url: '/api/sound-design/plan',
		headers: JSON_H,
		payload: { projectId, sequenceId: seqId, style: { seed: 4, cueSources: ['text', 'markers'] } },
	});
	expect(plan.statusCode, plan.body).toBe(202);
	const job = await waitJob((plan.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	result = SoundDesignPlanResultSchema.parse(job.result);
	const pr = await app.inject({
		method: 'GET',
		url: `/api/projects/${projectId}/proposals/${result.proposalId}`,
		headers: JSON_H,
	});
	const proposal = (pr.json() as { proposal: Proposal }).proposal;
	const accept = await app.inject({
		method: 'POST',
		url: `/api/projects/${projectId}/proposals/${proposal.id}/accept`,
		headers: JSON_H,
		payload: { itemIds: proposal.items.filter((i) => !isSetupItem(i)).map((i) => i.id) },
	});
	expect(accept.statusCode, accept.body).toBe(200);
	const q = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: JSON_H,
		payload: { projectId, query: 'doc.get', args: {} },
	});
	const live = q.json() as { result: ProjectDocument; revision: number };
	applied = live.result;
	const settings = {
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mov',
		video: {
			codec: 'h264',
			width: 320,
			height: 180,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 35 },
			encoderSpeed: 'fast',
		},
		audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
		engine: 'native',
	};
	const envelope = makeEnvelope(applied, {
		revision: live.revision,
		savedAt: '2026-10-18T00:00:00.000Z',
		platform: 'test',
	});
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope, sequenceId: seqId, settings },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await waitJob(start.json().id);
	expect(done.error).toBeUndefined();
	const out = (await coreServices(app).exports.outputFile(start.json().id))!;
	exported = decodeF32(out);
	mkdirSync(join(ROOT, 'test-results', 'sd-grammar'), { recursive: true });
	// a picture of the exported audio to look at (not an assertion)
	try {
		execFileSync(TEST_FFMPEG, [
		'-v',
		'error',
		'-y',
		'-i',
		out,
		'-filter_complex',
		'[0:a]showwavespic=s=1600x300:split_channels=0',
		'-frames:v',
		'1',
		join(ROOT, 'test-results', 'sd-grammar', 'export-waveform.png'),
		]);
	} catch {
		// the waveform picture is optional
	}
}, 900_000);

afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const fps = { num: 30, den: 1 };
const clipAt = (frame: number) => {
	const seq = applied.sequences[seqId]!;
	const cue = soundCuesOf(seq).find((c) => c.frame === frame)!;
	return seq.clips[cue.placedClipIds![0]!] as AudioClip & { sfx: ClipSfx };
};

describe('the cue grammar in the exported audio (measured)', { timeout: 900_000 }, () => {
	it('the 4-card stagger climbs 0 / +1 / +2 / +3 semitones', () => {
		const st = [120, 135, 150, 165].map((f) => {
			const at = frameToSample(f, fps, SR);
			// 60 ms from the cue frame (the pops are peak-aligned on it): ≈ 60 periods of 1 kHz
			return frequencyOf(exported, at + Math.round(0.003 * SR), Math.round(0.06 * SR));
		});
		const semis = st.map((hz) => 12 * Math.log2(hz / POP_HZ));
		console.log(`[grammar export] pop frequencies ${st.map((x) => x.toFixed(1)).join(' / ')} Hz = ${semis.map((x) => x.toFixed(3)).join(' / ')} st`);
		for (const [i, s] of semis.entries()) expect(Math.abs(s - i), `card ${i + 1}: ${s} st`).toBeLessThan(0.05);
		const ev = result.report.events.filter((e) => e.run);
		expect(ev.map((e) => e.run!.st)).toEqual([0, 1, 2, 3]);
		expect(ev.map((e) => e.frame)).toEqual([120, 135, 150, 165]);
		expect(result.report.grammar?.runCount).toBe(1);
	});

	it('the clicks share one sound and one level, measured', () => {
		const clips = [240, 270, 300].map(clipAt);
		expect(new Set(clips.map((c) => c.sfx.soundId)).size).toBe(1);
		expect(new Set(clips.map((c) => c.gainDb)).size).toBe(1);
		for (const c of clips) expect(c.speed.rate).toBe(1);
		const peaks = [240, 270, 300].map((f) => {
			const at = frameToSample(f, fps, SR);
			let p = 0;
			for (let i = at - Math.round(0.01 * SR); i < at + Math.round(0.03 * SR); i++) p = Math.max(p, Math.abs(exported[i]!));
			return 20 * Math.log10(p);
		});
		console.log(`[grammar export] click peaks ${peaks.map((x) => x.toFixed(2)).join(' / ')} dBFS`);
		expect(Math.max(...peaks) - Math.min(...peaks)).toBeLessThan(0.1);
		expect(peaks[0]!).toBeGreaterThan(-40);
		const voice = result.report.grammar?.voices.click;
		expect(voice).toBe(clips[0]!.sfx.soundId);
	});

	it('the keys are takes of the typing run at speed 1, never the same take twice in a row', () => {
		const keys = result.report.events.filter((e) => e.variation === 'takes');
		expect(keys.length).toBeGreaterThan(3);
		const ids = keys.map((k) => k.sound.soundId);
		for (const id of ids) expect(id).toMatch(/~t\d+$/);
		for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
		for (const k of keys) {
			expect(k.rate).toBe(1);
			const clip = clipAt(k.frame);
			expect(clip.speed.rate).toBe(1);
			expect(clip.sfx.pitch).toBeUndefined();
		}
	});
});
