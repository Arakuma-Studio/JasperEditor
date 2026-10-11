// OMF 2.0 objects (Bento) → composition model.
//
// Port of FilmCraft `crates/interchange/src/omf/read.rs` (MIT OR Apache-2.0).
import {
	type CDocument,
	type CItem,
	type Composition,
	type Gain,
	type Source,
	unitsToFlicks,
} from '../comp.ts';
import { CONSTANT_POWER } from '../effects.ts';
import { decodeUtf8Lossy, fileUrlToPath } from '../paths.ts';
import { InterchangeError, parseError, type Report } from '../report.ts';
import { flicksToFrames, RATE_25 } from '../time.ts';
import { parseAiff, parseWav } from '../wav.ts';
import type { BentoContainer } from './bento.ts';

type Rat = [number, number];

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const MAX_DEPTH = 32;

class R {
	readonly mobs = new Map<string, number>();
	readonly media = new Map<string, Uint8Array>();
	readonly doc: CDocument = { compositions: [], sources: [] };
	readonly sources = new Map<string, number>();
	be = true;
	constructor(
		readonly c: BentoContainer,
		readonly report: Report,
	) {}

	class(o: number): string {
		const v = this.c.get(o, 'OMFI:OOBJ:ObjClass');
		if (!v || v.length < 4) return '????';
		return String.fromCharCode(v[0]!, v[1]!, v[2]!, v[3]!);
	}
	private dv(v: Uint8Array) {
		return new DataView(v.buffer, v.byteOffset, v.byteLength);
	}
	u32Of(v: Uint8Array, at = 0): number | null {
		return v.length >= at + 4 ? this.dv(v).getUint32(at, !this.be) : null;
	}
	i32(o: number, p: string): number | null {
		const v = this.c.get(o, p);
		return v && v.length >= 4 ? this.dv(v).getInt32(0, !this.be) : null;
	}
	u32(o: number, p: string): number | null {
		const v = this.c.get(o, p);
		return v ? this.u32Of(v) : null;
	}
	u16(o: number, p: string): number | null {
		const v = this.c.get(o, p);
		return v && v.length >= 2 ? this.dv(v).getUint16(0, !this.be) : null;
	}
	rationalOf(v: Uint8Array): Rat | null {
		if (v.length < 8) return null;
		const dv = this.dv(v);
		return [dv.getInt32(0, !this.be), dv.getInt32(4, !this.be)];
	}
	rational(o: number, p: string): Rat | null {
		const v = this.c.get(o, p);
		return v ? this.rationalOf(v) : null;
	}
	positiveRate(o: number, p: string): Rat | null {
		const r = this.rational(o, p);
		return r && r[0] > 0 && r[1] > 0 ? r : null;
	}
	string(o: number, p: string): string | null {
		const v = this.c.get(o, p);
		if (!v) return null;
		// Decoding is linear in the value, and any value may be the whole file: it is charged.
		this.c.charge(v.length);
		return decodeUtf8Lossy(v).replace(/\0+$/, '');
	}
	uid(o: number, p: string): Uint8Array | null {
		const v = this.c.get(o, p);
		return v && v.length >= 12 ? v.subarray(0, 12) : null;
	}
	ref(o: number, p: string): number | null {
		const v = this.c.get(o, p);
		if (!v || v.length < 4) return null;
		return this.c.resolve(o, this.dv(v).getUint32(0));
	}
	refs(o: number, p: string): number[] {
		const v = this.c.get(o, p);
		if (!v || v.length < 2) return [];
		const dv = this.dv(v);
		const n = dv.getUint16(0);
		const out: number[] = [];
		this.c.charge(n);
		for (let i = 0; i < n && 2 + i * 4 + 4 <= v.length; i++)
			out.push(this.c.resolve(o, dv.getUint32(2 + i * 4)));
		return out;
	}
	dataKind(o: number): string {
		const d = this.ref(o, 'OMFI:CPNT:DataKind');
		return (d !== null ? this.string(d, 'OMFI:DDEF:DataKindID') : null) ?? '';
	}
	len(o: number): number {
		return Math.max(0, this.i32(o, 'OMFI:CPNT:Length') ?? 0);
	}

	private readonly collected = new Set<number>();

	collectRefs(o: number, out: Set<string>, depth: number) {
		if (depth > 64) return;
		// Objects form a graph (references are object ids): each is collected once. Without this an object that
		// lists itself twice among its components is walked 2⁶⁴ times.
		if (this.collected.has(o)) return;
		this.collected.add(o);
		if (this.class(o) === 'SCLP') {
			const id = this.uid(o, 'OMFI:SCLP:SourceID');
			if (id) out.add(hex(id));
		}
		for (const p of ['OMFI:MOBJ:Slots', 'OMFI:SEQU:Components', 'OMFI:EFFE:EffectSlots'])
			for (const c of this.refs(o, p)) this.collectRefs(c, out, depth + 1);
		for (const p of ['OMFI:MSLT:Segment', 'OMFI:ESLT:ArgValue']) {
			const c = this.ref(o, p);
			if (c !== null) this.collectRefs(c, out, depth + 1);
		}
	}

	composition(m: number): Composition {
		const comp: Composition = {
			name: this.string(m, 'OMFI:MOBJ:Name') || 'Sequence',
			rate: RATE_25,
			sampleRate: 48_000,
			width: 1920,
			height: 1080,
			startTc: 0,
			drop: false,
			tracks: [],
			markers: [],
		};
		let na = 0;
		for (const s of this.refs(m, 'OMFI:MOBJ:Slots')) {
			const seg = this.ref(s, 'OMFI:MSLT:Segment');
			if (seg === null) continue;
			const rate = this.positiveRate(s, 'OMFI:MSLT:EditRate') ?? [25, 1];
			const kind = this.dataKind(seg);
			const cls = this.class(seg);
			if (cls === 'TCCP' || kind === 'omfi:data:Timecode') {
				comp.rate = { num: rate[0], den: rate[1] };
				if (cls === 'TCCP') {
					comp.startTc = Math.max(0, this.i32(seg, 'OMFI:TCCP:Start') ?? 0);
					comp.drop = (this.c.get(seg, 'OMFI:TCCP:Drop')?.[0] ?? 0) !== 0;
				}
				continue;
			}
			if (kind === 'omfi:data:Picture' || kind === 'omfi:data:PictureWithMatte') {
				this.report.info('OMF picture slots are not imported (audio only)');
				continue;
			}
			if (kind !== 'omfi:data:Sound') {
				this.report.info('an OMF slot of an unsupported data kind was skipped');
				continue;
			}
			if (rate[1] === 1 && rate[0] >= 8000) comp.sampleRate = rate[0];
			const items = this.segment(seg, rate, 0);
			na++;
			const td = this.ref(s, 'OMFI:MSLT:TrackDesc');
			const name = (td !== null ? this.string(td, 'OMFI:TRKD:TrackName') : null) ?? `A${na}`;
			const number = (td !== null ? this.u32(td, 'OMFI:TRKD:PhysicalTrack') : null) ?? na;
			const channels = Math.min(
				6,
				Math.max(1, ...items.map((i) => (i.type === 'clip' ? this.doc.sources[i.clip.source]!.channels : 1))),
			);
			comp.tracks.push({ kind: 'sound', name, number, channels, items });
		}
		return comp;
	}

	segment(seg: number, rate: Rat, depth: number): CItem[] {
		// A segment that contains itself is walked along every path down to MAX_DEPTH: the walk is charged, so a
		// file that needs more work than its size justifies is refused (bento.ts `charge`).
		this.c.charge(8);
		const len = unitsToFlicks(this.len(seg), rate[0], rate[1]);
		if (depth > MAX_DEPTH) return [{ type: 'filler', len }];
		switch (this.class(seg)) {
			case 'SEQU':
				return this.refs(seg, 'OMFI:SEQU:Components').flatMap((c) => this.segment(c, rate, depth + 1));
			case 'FILL':
				return [{ type: 'filler', len }];
			case 'SCLP':
				return [this.clip(seg, rate)];
			case 'TRAN': {
				const cut = unitsToFlicks(this.i32(seg, 'OMFI:TRAN:CutPoint') ?? 0, rate[0], rate[1]);
				const e = this.ref(seg, 'OMFI:TRAN:Effect');
				const effect = (e !== null ? this.string(e, 'JasperEditor:EFFE:EffectID') : null) ?? CONSTANT_POWER;
				return [{ type: 'transition', tr: { len, cut: Math.max(0, Math.min(len, cut)), effect } }];
			}
			case 'EFFE': {
				const k = this.ref(seg, 'OMFI:EFFE:EffectKind');
				const kind = (k !== null ? this.string(k, 'OMFI:EDEF:EffectID') : null) ?? '';
				const slots = this.refs(seg, 'OMFI:EFFE:EffectSlots');
				const arg = (id: number) => {
					const s = slots.find((x) => this.i32(x, 'OMFI:ESLT:ArgID') === id);
					return s === undefined ? null : this.ref(s, 'OMFI:ESLT:ArgValue');
				};
				const isGain = kind === 'omfi:effect:MonoAudioGain';
				const input = arg(-1) ?? (isGain ? null : arg(1));
				if (input === null) return [{ type: 'filler', len }];
				let gain: Gain | null = null;
				if (isGain) {
					const v = arg(1);
					gain = v !== null ? this.gain(v, len) : null;
				} else this.report.warn('OMF effects other than audio gain are not imported (their input is used)');
				const items = this.segment(input, rate, depth + 1);
				const only = items.length === 1 ? items[0]! : null;
				if (gain && only?.type === 'clip') only.clip.gain = gain;
				return items;
			}
			default:
				this.report.info('an unsupported OMF component was imported as a gap');
				return [{ type: 'filler', len }];
		}
	}

	amp(v: Uint8Array | null): number | null {
		const r = v ? this.rationalOf(v) : null;
		return r && r[1] !== 0 ? r[0] / r[1] : null;
	}

	gain(v: number, len: number): Gain | null {
		switch (this.class(v)) {
			case 'CVAL': {
				const a = this.amp(this.c.get(v, 'OMFI:CVAL:Value'));
				return a === null ? null : { type: 'constant', value: a };
			}
			case 'VVAL': {
				const linear = this.u16(v, 'OMFI:VVAL:Interpolation') !== 1;
				const points: [number, number][] = [];
				for (const p of this.refs(v, 'OMFI:VVAL:PointList')) {
					const t = this.rational(p, 'OMFI:CTLP:Time');
					const a = this.amp(this.c.get(p, 'OMFI:CTLP:Value'));
					if (!t || t[1] === 0 || a === null) continue;
					const off = Number((BigInt(Math.round(len)) * BigInt(t[0])) / BigInt(t[1]));
					points.push([Math.max(-(2 ** 47), Math.min(2 ** 47, off)), a]);
				}
				return points.length ? { type: 'varying', linear, points } : null;
			}
			default:
				return null;
		}
	}

	clip(c: number, rate: Rat): CItem {
		const len = unitsToFlicks(this.len(c), rate[0], rate[1]);
		const start = unitsToFlicks(this.i32(c, 'OMFI:SCLP:StartTime') ?? 0, rate[0], rate[1]);
		const name = this.string(c, 'JasperEditor:SCLP:ClipName') ?? '';
		const id = this.uid(c, 'OMFI:SCLP:SourceID');
		const track = this.u32(c, 'OMFI:SCLP:SourceTrackID');
		if (!id || track === null || id.every((b) => b === 0)) return { type: 'filler', len };
		const r = this.resolve(id, track, start, null, 0);
		return r
			? { type: 'clip', clip: { len, source: r[0], start: r[1], gain: null, name } }
			: { type: 'filler', len };
	}

	slotOf(mob: number, track: number): number | null {
		for (const s of this.refs(mob, 'OMFI:MOBJ:Slots')) {
			const t = this.ref(s, 'OMFI:MSLT:TrackDesc');
			if (t !== null && this.u32(t, 'OMFI:TRKD:TrackID') === track) return s;
		}
		return null;
	}

	firstClip(seg: number, depth = 0): number | null {
		if (depth > MAX_DEPTH) return null;
		this.c.charge(4);
		const cls = this.class(seg);
		if (cls === 'SCLP') return seg;
		if (cls !== 'SEQU') return null;
		for (const c of this.refs(seg, 'OMFI:SEQU:Components')) {
			const f = this.firstClip(c, depth + 1);
			if (f !== null) return f;
		}
		return null;
	}

	resolve(
		id: Uint8Array,
		track: number,
		start: number,
		master: string | null,
		depth: number,
	): [number, number] | null {
		if (depth > 16) return null;
		const mob = this.mobs.get(hex(id));
		if (mob === undefined) {
			this.report.warn('a clip references a mob that is not in the file (imported as a gap)');
			return null;
		}
		const slot = this.slotOf(mob, track);
		if (slot === null) return null;
		const rate = this.positiveRate(slot, 'OMFI:MSLT:EditRate') ?? [48_000, 1];
		const seg = this.ref(slot, 'OMFI:MSLT:Segment');
		if (seg === null) return null;
		const cls = this.class(mob);
		if (cls === 'MMOB') {
			const key = master ?? hex(id);
			const clip = this.firstClip(seg);
			if (clip === null) return null;
			const inner = unitsToFlicks(this.i32(clip, 'OMFI:SCLP:StartTime') ?? 0, rate[0], rate[1]);
			const next = this.uid(clip, 'OMFI:SCLP:SourceID');
			const nextTrack = this.u32(clip, 'OMFI:SCLP:SourceTrackID');
			if (!next || nextTrack === null) return null;
			const name = this.string(mob, 'OMFI:MOBJ:Name');
			const r = this.resolve(next, nextTrack, start + inner, key, depth + 1);
			if (r && name) this.doc.sources[r[0]]!.name = name;
			return r;
		}
		if (cls !== 'SMOB') {
			this.report.warn('nested OMF compositions are not supported (imported as gaps)');
			return null;
		}
		const desc = this.ref(mob, 'OMFI:SMOB:MediaDescription');
		if (desc === null) return null;
		const sr = this.rational(desc, 'OMFI:MDFL:SampleRate');
		const idHex = hex(id);
		if (!sr && !this.media.has(idHex)) return null; // a tape / physical source
		const key = master ?? idHex;
		const skey = `${idHex}|${track}|${key}`;
		const known = this.sources.get(skey);
		if (known !== undefined) return [known, start];
		const fileRate: Rat = sr && sr[0] > 0 && sr[1] > 0 ? sr : rate;
		const length = unitsToFlicks(
			Math.max(0, this.i32(desc, 'OMFI:MDFL:Length') ?? 0),
			fileRate[0],
			fileRate[1],
		);
		const summary = this.c.get(desc, 'OMFI:WAVD:Summary') ?? this.c.get(desc, 'OMFI:AIFD:Summary');
		const fmt = summary ? (parseWav(summary) ?? parseAiff(summary)) : null;
		let path: string | null = null;
		for (const l of this.refs(desc, 'OMFI:MDES:Locator')) {
			const lc = this.class(l);
			const p =
				lc === 'UNXL'
					? this.string(l, 'OMFI:UNXL:PathName')
					: lc === 'DOSL'
						? this.string(l, 'OMFI:DOSL:PathName')
						: lc === 'MACL'
							? this.string(l, 'OMFI:MACL:PathName')
							: lc === 'TXTL'
								? this.string(l, 'OMFI:TXTL:Name')
								: lc === 'NETL'
									? (() => {
											const u = this.string(l, 'OMFI:NETL:URLString');
											return u ? fileUrlToPath(u) : null;
										})()
									: null;
			if (p) {
				path = p;
				break;
			}
		}
		const soundSlots = this.refs(mob, 'OMFI:MOBJ:Slots').length;
		const fileChannels = Math.max(1, fmt?.channels ?? 1);
		const sampleRate = fmt?.sampleRate || fileRate[0];
		const bits = fmt?.bits || 16;
		const channel =
			fileChannels > 1 && soundSlots > 1 ? Math.min(Math.max(0, track - 1), fileChannels - 1) : null;
		const tc = this.tapeTimecode(seg, rate);
		const s: Source = {
			key,
			name: this.string(mob, 'OMFI:MOBJ:Name') ?? '',
			kind: 'sound',
			path,
			channel,
			channels: channel !== null ? 1 : fileChannels,
			fileChannels,
			width: 0,
			height: 0,
			frameRate: RATE_25,
			sampleRate,
			bits,
			length,
			offset: 0,
			startTc: tc?.[0] ?? null,
			tcRate: tc?.[1] ?? RATE_25,
			embedded: null,
			markers: [],
		};
		const data = this.media.get(idHex);
		if (data) {
			const pcm = parseWav(data) ?? parseAiff(data);
			if (pcm) {
				s.embedded = pcm.pcm;
				s.fileChannels = Math.max(1, pcm.channels);
				s.channels = s.channel !== null ? 1 : s.fileChannels;
				s.sampleRate = pcm.sampleRate;
				s.bits = pcm.bits;
			} else this.report.warn('embedded OMF audio in an unsupported format was skipped');
		}
		const i = this.doc.sources.length;
		this.doc.sources.push(s);
		this.sources.set(skey, i);
		return [i, start];
	}

	/** Start timecode of the physical source behind a file mob segment. */
	tapeTimecode(seg: number, rate: Rat): [number, { num: number; den: number }] | null {
		const clip = this.firstClip(seg);
		if (clip === null) return null;
		const tid = this.uid(clip, 'OMFI:SCLP:SourceID');
		const tape = tid ? this.mobs.get(hex(tid)) : undefined;
		if (tape === undefined) return null;
		for (const s of this.refs(tape, 'OMFI:MOBJ:Slots')) {
			const g = this.ref(s, 'OMFI:MSLT:Segment');
			if (g === null || this.class(g) !== 'TCCP') continue;
			const startTc = this.i32(g, 'OMFI:TCCP:Start') ?? 0;
			const fps = this.u16(g, 'OMFI:TCCP:FPS') ?? 25;
			const tr = this.positiveRate(s, 'OMFI:MSLT:EditRate');
			const tcr = tr ? { num: tr[0], den: tr[1] } : { num: Math.max(1, fps), den: 1 };
			const off = unitsToFlicks(this.i32(clip, 'OMFI:SCLP:StartTime') ?? 0, rate[0], rate[1]);
			return [Math.max(0, startTc + flicksToFrames(off, tcr, 'floor')), tcr];
		}
		return null;
	}
}

/** Read the compositions of an OMF 2.0 file. */
export function readOmf(c: BentoContainer, report: Report): CDocument {
	const r = new R(c, report);
	const classOf = (o: number) => r.class(o);
	const objects = [...c.objects.keys()];
	const head = objects.find((o) => classOf(o) === 'HEAD');
	if (head === undefined) throw parseError('OMF', 'no OMF header object');
	r.be = c.get(head, 'OMFI:HEAD:ByteOrder')?.[0] !== 0x49;
	let mobList = r.refs(head, 'OMFI:HEAD:Mobs');
	if (!mobList.length) mobList = objects.filter((o) => ['CMOB', 'MMOB', 'SMOB'].includes(classOf(o)));
	for (const m of mobList) {
		const id = r.uid(m, 'OMFI:MOBJ:MobID');
		if (id) r.mobs.set(hex(id), m);
	}
	let md = r.refs(head, 'OMFI:HEAD:MediaData');
	if (!md.length) md = objects.filter((o) => ['WAVE', 'AIFC'].includes(classOf(o)));
	for (const m of md) {
		const id = r.uid(m, 'OMFI:MDAT:MobID');
		if (!id) continue;
		const d = c.get(m, 'OMFI:WAVE:Data') ?? c.get(m, 'OMFI:AIFC:Data');
		if (d) r.media.set(hex(id), d);
	}
	const cmobs = mobList.filter((m) => classOf(m) === 'CMOB');
	const referenced = new Set<string>();
	for (const m of cmobs) r.collectRefs(m, referenced, 0);
	const primary = r.refs(head, 'OMFI:HEAD:PrimaryMobs').filter((m) => cmobs.includes(m));
	const top = primary.length
		? primary
		: cmobs.filter((m) => {
				const id = r.uid(m, 'OMFI:MOBJ:MobID');
				return !id || !referenced.has(hex(id));
			});
	for (const m of top) r.doc.compositions.push(r.composition(m));
	if (!r.doc.compositions.length) throw new InterchangeError('EMPTY', 'the OMF file holds no composition');
	return r.doc;
}
