import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { audioNeeds } from '../src/essence.ts';
import { detectFormat } from '../src/formats.ts';
import type { IProject, Rate } from '../src/model.ts';
import { BentoContainer, BentoWriter, LABEL_SIZE, MAGIC } from '../src/omf/bento.ts';
import { exportOmf, importOmf, sniffOmf } from '../src/omf/index.ts';
import type { AudioEssence, ExportOptions } from '../src/options.ts';
import { Report } from '../src/report.ts';
import { framesToFlicks, RATE_23_976, RATE_25, RATE_29_97, timecodeBase } from '../src/time.ts';
import { parseWav } from '../src/wav.ts';
import { arbProject, BASIC } from './support/arbitraries.ts';
import { expectOnlyInterchangeErrors } from './support/fuzz.ts';
import { clip, key, link, marker, media, project, sequence, structure, transition } from './support/ir.ts';

/** A1: two clips of one file with a constant power crossfade and +6 dB on the first; A2 music with volume keys; V1 picture. */
function sample(rate: Rate, df = false) {
	const p = project();
	const a = media(p, '/media/A001.mov', true, true, rate);
	const m = media(p, '/media/music.aif', false, true, rate);
	p.media[a]!.timecode = { frames: timecodeBase(rate) * 3600 + 12, rate, dropFrame: false };
	const s = sequence(p, 'Mix', rate, df);
	const v = clip(p, s, 'video', 0, a, 0, 100, 10);
	const a1 = clip(p, s, 'audio', 0, a, 0, 50, 10);
	const a2 = clip(p, s, 'audio', 0, a, 50, 50, 300);
	transition(p, s, 'audio', 0, 'jasper.constant-power', a1, a2, 45, 10, 'center');
	const mu = clip(p, s, 'audio', 1, m, 20, 150, 0);
	link(v, a1);
	a1.volumeDb = { value: 6, keyframes: [] };
	mu.volumeDb = {
		value: 0,
		keyframes: [key(framesToFlicks(0, rate), -12), key(framesToFlicks(48, rate), 0)],
	};
	const seq = p.sequences[s]!;
	seq.startTimecode = timecodeBase(rate) * 3600;
	seq.markers.push(marker(framesToFlicks(5, rate), 0, 'm', '', 'rose'));
	return { p, s };
}

const rt = (p: IProject, s: string, opts: ExportOptions = {}) => {
	const report = new Report();
	const bytes = exportOmf(p, s, opts, report);
	expect(sniffOmf(bytes)).toBe(true);
	expect(detectFormat(bytes, 'x.omf')).toBe('omf');
	const q = importOmf(bytes, { baseDir: '/proj' }, new Report());
	return { q, n: q.top[0]!, bytes, report };
};

/** Structure with times rounded to frames (sound edits are on samples, which frames at 29.97 are not). */
const rounded = (st: ReturnType<typeof structure>) =>
	st.map((t) => ({
		clips: t.clips.map((c) => c.map((x) => (typeof x === 'number' ? Math.round(x) : x))),
		transitions: t.transitions.map((c) => c.map((x) => (typeof x === 'number' ? Math.round(x) : x))),
	}));

function ramp(frames: number, channels: number, seed: number): Uint8Array {
	const out = new Uint8Array(frames * channels * 2);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < frames; i++)
		for (let c = 0; c < channels; c++)
			dv.setInt16((i * channels + c) * 2, (i * 31 + c * 977 + seed) % 30000, true);
	return out;
}

describe('OMF', () => {
	it('export → import keeps every audio clip and crossfade, at every rate (property)', () => {
		fc.assert(
			fc.property(arbProject({ ...BASIC, transitions: true, timecode: true }), (p) => {
				const s = p.top[0]!;
				const q = importOmf(exportOmf(p, s, {}, new Report()), {}, new Report());
				const n = q.top[0]!;
				expect(rounded(structure(q, n, 'audio'))).toEqual(structure(p, s, 'audio'));
				expect(structure(q, n, 'video')).toEqual([]);
				expect([q.sequences[n]!.rate, q.sequences[n]!.dropFrame]).toEqual([
					p.sequences[s]!.rate,
					p.sequences[s]!.dropFrame,
				]);
			}),
			{ numRuns: Number(process.env.FC_RUNS ?? 60) },
		);
	});

	it('round trips the audio edit at 25, 23.976 and 29.97 DF and reports what it leaves out', () => {
		for (const [rate, df] of [
			[RATE_25, false],
			[RATE_23_976, false],
			[RATE_29_97, true],
		] as const) {
			const { p, s } = sample(rate, df);
			const { q, n, bytes, report } = rt(p, s);
			expect(rounded(structure(q, n, 'audio'))).toEqual(structure(p, s, 'audio'));
			expect(structure(q, n, 'video')).toEqual([]);
			const qs = q.sequences[n]!;
			expect(qs.name).toBe('Mix');
			expect(qs.rate).toEqual(rate);
			expect(qs.dropFrame).toBe(df);
			expect(qs.startTimecode).toBe(timecodeBase(rate) * 3600);
			expect(Math.abs(qs.audio[0]!.clips[0]!.volumeDb!.value - 6)).toBeLessThan(1e-3);
			const ks = qs.audio[1]!.clips[0]!.volumeDb!.keyframes;
			expect(ks.map((k) => Math.round(k.value * 1000) / 1000)).toEqual([-12, 0]);
			expect(Math.abs(ks[1]!.time - framesToFlicks(48, rate))).toBeLessThan(705_600_000 / 48_000);
			const ma = Object.values(q.media).find((m) => m.path === '/media/A001.mov')!;
			expect(ma.timecode!.frames).toBe(timecodeBase(rate) * 3600 + 12);
			expect(ma.audio!.sampleRate).toBe(48000);
			expect(report.mentions('audio only')).toBe(true);
			expect(report.mentions('marker')).toBe(true);
			expect(exportOmf(p, s, {}, new Report())).toEqual(bytes);
		}
	});

	it('embeds audio as WAVE media data', () => {
		const { p, s } = sample(RATE_25);
		const needs = audioNeeds(p, s, { handles: framesToFlicks(2, RATE_25) });
		const essence: AudioEssence[] = needs.map((nd, k) => {
			const frames = Math.floor((nd.end - nd.start) / (705_600_000 / 48_000));
			return {
				key: nd.key,
				channel: null,
				start: nd.start,
				frames,
				sampleRate: 48000,
				bits: 16,
				channels: 2,
				data: { embedded: ramp(frames, 2, k) },
				effectsRendered: false,
			};
		});
		const { q, n } = rt(p, s, { media: { essence } });
		const emb = Object.values(q.media).filter((m) => m.embedded);
		expect(emb.length).toBe(2);
		for (const m of emb) {
			const w = parseWav(m.embedded!.bytes)!;
			expect([w.channels, w.sampleRate, w.bits]).toEqual([2, 48000, 16]);
			expect(
				essence.some(
					(e) =>
						'embedded' in e.data &&
						e.data.embedded.length === w.pcm.length &&
						e.data.embedded.every((v, i) => v === w.pcm[i]),
				),
			).toBe(true);
		}
		const orig = p.sequences[s]!;
		for (const [ti, t] of q.sequences[n]!.audio.entries())
			for (const [ci, c] of t.clips.entries()) {
				const oc = orig.audio[ti]!.clips[ci]!;
				const need = needs.find((x) => x.mediaId === (oc.source as { mediaId: string }).mediaId)!;
				expect(c.sourceIn).toBe(oc.sourceIn - need.start);
			}
	});

	it('links separate AIFF files and breaks stereo out to mono', () => {
		const { p, s } = sample(RATE_25);
		const needs = audioNeeds(p, s, { perClip: true });
		const essence: AudioEssence[] = needs.flatMap((nd) =>
			[0, 1].map((c) => ({
				key: nd.key,
				channel: c,
				start: nd.start,
				frames: 4800,
				sampleRate: 48000,
				bits: 24 as const,
				channels: 1,
				data: { file: `/out/${'clip' in nd.key ? nd.key.clip : ''}_${c}.aif` },
				effectsRendered: true,
			})),
		);
		const { q, n, bytes } = rt(p, s, { media: { essence, breakoutToMono: true } });
		const qs = q.sequences[n]!;
		expect(qs.audio.length).toBe(4);
		for (const t of qs.audio)
			for (const c of t.clips) {
				const m = q.media[(c.source as { mediaId: string }).mediaId]!;
				expect(m.path!.startsWith('/out/')).toBe(true);
				expect(m.path!.endsWith('.aif')).toBe(true);
				expect(c.volumeDb === undefined || c.volumeDb.value === 0).toBe(true);
			}
		const c = BentoContainer.open(bytes);
		const classes = [...c.objects.keys()].map((o) => {
			const v = c.get(o, 'OMFI:OOBJ:ObjClass');
			return v ? String.fromCharCode(...v) : '';
		});
		expect(classes.filter((k) => k === 'AIFD').length).toBe(essence.length);
		expect(classes.includes('WAVE')).toBe(false);
	});

	it('writes the required properties of every OMF class', () => {
		const { p, s } = sample(RATE_25);
		const needs = audioNeeds(p, s);
		const essence: AudioEssence[] = needs.map((nd) => ({
			key: nd.key,
			channel: null,
			start: nd.start,
			frames: 480,
			sampleRate: 48000,
			bits: 16,
			channels: 2,
			data: { embedded: new Uint8Array(480 * 4).fill(7) },
			effectsRendered: false,
		}));
		const bytes = exportOmf(p, s, { media: { essence } }, new Report());
		const l = bytes.subarray(bytes.length - LABEL_SIZE);
		expect([...l.subarray(0, 8)]).toEqual([...MAGIC]);
		expect((l[12]! << 8) | l[13]!).toBe(1);
		const c = BentoContainer.open(bytes);
		const classOf = (o: number) => {
			const v = c.get(o, 'OMFI:OOBJ:ObjClass');
			return v ? String.fromCharCode(...v) : null;
		};
		const by = new Map<string, number[]>();
		for (const o of c.objects.keys()) {
			const k = classOf(o);
			if (k) by.set(k, [...(by.get(k) ?? []), o]);
		}
		const required: [string, string[]][] = [
			[
				'HEAD',
				[
					'OMFI:HEAD:ByteOrder',
					'OMFI:HEAD:LastModified',
					'OMFI:HEAD:Version',
					'OMFI:HEAD:Mobs',
					'OMFI:HEAD:MediaData',
					'OMFI:HEAD:DefinitionObjects',
				],
			],
			['CMOB', ['OMFI:MOBJ:MobID', 'OMFI:MOBJ:Slots', 'OMFI:MOBJ:LastModified', 'OMFI:MOBJ:CreationTime']],
			['MMOB', ['OMFI:MOBJ:MobID', 'OMFI:MOBJ:Slots', 'OMFI:MOBJ:LastModified', 'OMFI:MOBJ:CreationTime']],
			['SMOB', ['OMFI:MOBJ:MobID', 'OMFI:MOBJ:Slots', 'OMFI:SMOB:MediaDescription']],
			['MSLT', ['OMFI:MSLT:Segment', 'OMFI:MSLT:EditRate', 'OMFI:MSLT:TrackDesc']],
			['TRKD', ['OMFI:TRKD:Origin', 'OMFI:TRKD:TrackID']],
			['SEQU', ['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:SEQU:Components']],
			[
				'SCLP',
				[
					'OMFI:CPNT:DataKind',
					'OMFI:CPNT:Length',
					'OMFI:SCLP:SourceID',
					'OMFI:SCLP:SourceTrackID',
					'OMFI:SCLP:StartTime',
				],
			],
			['TRAN', ['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:TRAN:CutPoint', 'OMFI:TRAN:Effect']],
			['EFFE', ['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:EFFE:EffectKind']],
			['ESLT', ['OMFI:ESLT:ArgID', 'OMFI:ESLT:ArgValue']],
			['CVAL', ['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:CVAL:Value']],
			['VVAL', ['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:VVAL:Interpolation', 'OMFI:VVAL:PointList']],
			['EDEF', ['OMFI:EDEF:EffectID']],
			['DDEF', ['OMFI:DDEF:DataKindID']],
			[
				'TCCP',
				['OMFI:CPNT:DataKind', 'OMFI:CPNT:Length', 'OMFI:TCCP:Start', 'OMFI:TCCP:FPS', 'OMFI:TCCP:Drop'],
			],
			['WAVD', ['OMFI:MDFL:IsOMFI', 'OMFI:MDFL:SampleRate', 'OMFI:MDFL:Length', 'OMFI:WAVD:Summary']],
			['WAVE', ['OMFI:MDAT:MobID', 'OMFI:WAVE:Data']],
			['IDNT', ['OMFI:IDNT:CompanyName', 'OMFI:IDNT:ProductName']],
		];
		for (const [k, props] of required) {
			const objs = by.get(k);
			expect(objs?.length, k).toBeGreaterThan(0);
			for (const o of objs!) for (const prop of props) expect(c.get(o, prop), `${k} ${prop}`).not.toBeNull();
		}
		expect(by.get('HEAD')!.length).toBe(1);
		expect(by.get('CMOB')!.length).toBe(1);
		const head = by.get('HEAD')![0]!;
		expect([...c.get(head, 'OMFI:HEAD:Version')!]).toEqual([2, 0]);
		expect(String.fromCharCode(...c.get(head, 'OMFI:HEAD:ByteOrder')!)).toBe('MM');
		const refs = (o: number, p: string) => {
			const v = c.get(o, p)!;
			const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
			return Array.from({ length: dv.getUint16(0) }, (_, i) => c.resolve(o, dv.getUint32(2 + i * 4)));
		};
		const one = (o: number, p: string) => {
			const v = c.get(o, p)!;
			return c.resolve(o, new DataView(v.buffer, v.byteOffset, v.byteLength).getUint32(0));
		};
		for (const m of refs(head, 'OMFI:HEAD:Mobs')) {
			expect(['CMOB', 'MMOB', 'SMOB']).toContain(classOf(m));
			for (const sl of refs(m, 'OMFI:MOBJ:Slots')) {
				expect(classOf(sl)).toBe('MSLT');
				expect(classOf(one(sl, 'OMFI:MSLT:TrackDesc'))).toBe('TRKD');
			}
		}
		for (const w of by.get('WAVE')!) {
			const pcm = parseWav(c.get(w, 'OMFI:WAVE:Data')!)!;
			expect([pcm.pcm.length, pcm.channels, pcm.sampleRate, pcm.bits]).toEqual([480 * 4, 2, 48000, 16]);
			const id = [...c.get(w, 'OMFI:MDAT:MobID')!].join();
			expect(by.get('SMOB')!.some((sm) => [...(c.get(sm, 'OMFI:MOBJ:MobID') ?? [])].join() === id)).toBe(
				true,
			);
		}
		const cm = by.get('CMOB')![0]!;
		const slots = refs(cm, 'OMFI:MOBJ:Slots');
		expect(classOf(one(slots[0]!, 'OMFI:MSLT:Segment'))).toBe('TCCP');
		const seq = one(slots[1]!, 'OMFI:MSLT:Segment');
		const comps = refs(seq, 'OMFI:SEQU:Components');
		expect(comps.map(classOf)).toEqual(['EFFE', 'TRAN', 'SCLP']);
		const len = (o: number) => {
			const v = c.get(o, 'OMFI:CPNT:Length')!;
			return new DataView(v.buffer, v.byteOffset, v.byteLength).getInt32(0);
		};
		const samples = (f: number) => (f * 48000) / 25;
		expect(comps.map(len)).toEqual([samples(55), samples(10), samples(55)]);
		expect(len(seq)).toBe(samples(100));
		expect(String.fromCharCode(...c.get(one(comps[0]!, 'OMFI:EFFE:EffectKind'), 'OMFI:EDEF:EffectID')!)).toBe(
			'omfi:effect:MonoAudioGain\0',
		);
	});

	it('Bento values and references round trip', () => {
		const w = new BentoWriter();
		const a = w.newObject();
		const b = w.newObject();
		w.set(a, 'Test:Small', 'test:Bytes', Uint8Array.of(1, 2));
		w.set(a, 'Test:Empty', 'test:Bytes', new Uint8Array(0));
		w.set(b, 'Test:Big', 'test:Bytes', new Uint8Array(100_000).fill(9));
		w.setReferences(a, [b]);
		const bytes = w.finish();
		const c = BentoContainer.open(bytes);
		expect([...c.get(a, 'Test:Small')!]).toEqual([1, 2]);
		expect(c.get(a, 'Test:Empty')!.length).toBe(0);
		expect(c.get(b, 'Test:Big')!.length).toBe(100_000);
		expect(c.resolve(a, b)).toBe(b);
		expect(c.nameOf(c.idOf('Test:Big')!)).toBe('Test:Big');
		expect(() => BentoContainer.open(bytes.subarray(0, bytes.length - 1))).toThrow();
	});

	it('empty sequences, truncation and corruption never throw anything but InterchangeError', () => {
		const p = project();
		const s = sequence(p, 'Empty', { num: 24, den: 1 });
		const q = importOmf(exportOmf(p, s, {}, new Report()), {}, new Report());
		expect(q.top.length).toBe(1);
		const { p: p2, s: s2 } = sample(RATE_25);
		const bytes = exportOmf(p2, s2, {}, new Report());
		expectOnlyInterchangeErrors((b) => importOmf(b, {}, new Report()), bytes, { runs: 300, truncations: 97 });
	});
});
