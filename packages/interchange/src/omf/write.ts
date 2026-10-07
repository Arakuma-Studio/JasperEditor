// Composition model → OMF 2.0 objects in a Bento container.
//
// Port of FilmCraft `crates/interchange/src/omf/write.rs` (MIT OR Apache-2.0).
import { type CDocument, flicksToUnits, type Gain, type Source } from '../comp.ts';
import { encodeUtf8, extension, fileStem, isAbsolutePath, pathToFileUrl } from '../paths.ts';
import { InterchangeError, type Report } from '../report.ts';
import { timecodeBase } from '../time.ts';
import { aiffHeader, wavFile, wavHeader } from '../wav.ts';
import { BentoWriter } from './bento.ts';

/** An OMF mob id (omfi:UID): prefix, major, minor (big-endian). */
export type Uid = Uint8Array;

/** "JEDT": the UID prefix of mobs JasperEditor writes. */
export const UID_PREFIX = 0x4a454454;

export function uid(prefix: number, major: number, minor: number): Uid {
	const u = new Uint8Array(12);
	const dv = new DataView(u.buffer);
	dv.setUint32(0, prefix >>> 0);
	dv.setUint32(4, major >>> 0);
	dv.setUint32(8, minor >>> 0);
	return u;
}

const NULL_UID = uid(0, 0, 0);
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const clamp32 = (v: number) => Math.max(I32_MIN, Math.min(I32_MAX, Math.round(v)));

function be(bytes: number, f: (dv: DataView) => void): Uint8Array {
	const b = new Uint8Array(bytes);
	f(new DataView(b.buffer));
	return b;
}
const i32 = (v: number) => be(4, (dv) => dv.setInt32(0, clamp32(v)));
const u32 = (v: number) => be(4, (dv) => dv.setUint32(0, v >>> 0));
const u16 = (v: number) => be(2, (dv) => dv.setUint16(0, v & 0xffff));
const rational = (n: number, d: number) =>
	be(8, (dv) => {
		dv.setInt32(0, clamp32(n));
		dv.setInt32(4, clamp32(d));
	});
const cstr = (s: string) => encodeUtf8(`${s}\0`);
const amp = (a: number) => rational(Math.min(I32_MAX, Math.round(Math.max(0, a) * 65536)), 65536);
/** 1970-01-01 (reproducible files): omfi:TimeStamp is u32 seconds + a "is GMT" flag. */
const TIMESTAMP = Uint8Array.of(0, 0, 0, 0, 1);

const rateOf = (s: Source): [number, number] =>
	s.kind === 'picture' ? [s.frameRate.num, s.frameRate.den] : [Math.max(1, s.sampleRate), 1];

class W {
	b = new BentoWriter();
	refMap = new Map<number, number[]>();
	ddefs = new Map<string, number>();
	edefs = new Map<string, number>();
	defs: number[] = [];
	inexact = false;
	clamped = false;
	constructor(readonly report: Report) {}

	obj(cls: string): number {
		const id = this.b.newObject();
		this.b.set(id, 'OMFI:OOBJ:ObjClass', 'omfi:ClassID', encodeUtf8(cls));
		return id;
	}
	str(o: number, p: string, v: string) {
		this.b.set(o, p, 'omfi:String', cstr(v));
	}
	int(o: number, p: string, ty: string, v: number) {
		if (v > I32_MAX || v < I32_MIN) this.clamped = true;
		this.b.set(o, p, ty, i32(v));
	}
	ref(o: number, p: string, target: number) {
		this.b.set(o, p, 'omfi:ObjRef', u32(target));
		this.refsOf(o).push(target);
	}
	refs(o: number, p: string, targets: readonly number[]) {
		const v = new Uint8Array(2 + targets.length * 4);
		const dv = new DataView(v.buffer);
		dv.setUint16(0, Math.min(0xffff, targets.length));
		for (const [i, t] of targets.entries()) dv.setUint32(2 + i * 4, t);
		this.b.set(o, p, 'omfi:ObjRefArray', v);
		this.refsOf(o).push(...targets);
	}
	private refsOf(o: number) {
		let l = this.refMap.get(o);
		if (!l) this.refMap.set(o, (l = []));
		return l;
	}
	u(t: number, rate: [number, number]): number {
		const r = flicksToUnits(t, rate[0], rate[1]);
		if (!r.exact) this.inexact = true;
		return r.n;
	}
	ddef(kind: string): number {
		const known = this.ddefs.get(kind);
		if (known !== undefined) return known;
		const d = this.obj('DDEF');
		this.b.set(d, 'OMFI:DDEF:DataKindID', 'omfi:UniqueName', cstr(kind));
		this.ddefs.set(kind, d);
		this.defs.push(d);
		return d;
	}
	edef(id: string, name: string): number {
		const known = this.edefs.get(id);
		if (known !== undefined) return known;
		const d = this.obj('EDEF');
		this.b.set(d, 'OMFI:EDEF:EffectID', 'omfi:UniqueName', cstr(id));
		this.str(d, 'OMFI:EDEF:EffectName', name);
		this.b.set(d, 'OMFI:EDEF:Bypass', 'omfi:ArgIDType', i32(-1));
		this.edefs.set(id, d);
		this.defs.push(d);
		return d;
	}
	cpnt(o: number, kind: string, len: number) {
		this.ref(o, 'OMFI:CPNT:DataKind', this.ddef(kind));
		this.int(o, 'OMFI:CPNT:Length', 'omfi:Length32', len);
	}
	mob(cls: string, id: Uid, name: string, slots: number[]): number {
		const m = this.obj(cls);
		this.b.set(m, 'OMFI:MOBJ:MobID', 'omfi:UID', id);
		this.str(m, 'OMFI:MOBJ:Name', name);
		this.refs(m, 'OMFI:MOBJ:Slots', slots);
		this.b.set(m, 'OMFI:MOBJ:LastModified', 'omfi:TimeStamp', TIMESTAMP);
		this.b.set(m, 'OMFI:MOBJ:CreationTime', 'omfi:TimeStamp', TIMESTAMP);
		return m;
	}
	slot(rate: [number, number], segment: number, trackId: number, name: string, physical: number): number {
		const t = this.obj('TRKD');
		this.int(t, 'OMFI:TRKD:Origin', 'omfi:Position32', 0);
		this.b.set(t, 'OMFI:TRKD:TrackID', 'omfi:UInt32', u32(trackId));
		this.str(t, 'OMFI:TRKD:TrackName', name);
		if (physical > 0) this.b.set(t, 'OMFI:TRKD:PhysicalTrack', 'omfi:UInt32', u32(physical));
		const s = this.obj('MSLT');
		this.b.set(s, 'OMFI:MSLT:EditRate', 'omfi:Rational', rational(rate[0], rate[1]));
		this.ref(s, 'OMFI:MSLT:Segment', segment);
		this.ref(s, 'OMFI:MSLT:TrackDesc', t);
		return s;
	}
	sclp(kind: string, len: number, source: Uid, track: number, start: number): number {
		const c = this.obj('SCLP');
		this.cpnt(c, kind, len);
		this.b.set(c, 'OMFI:SCLP:SourceID', 'omfi:UID', source);
		this.b.set(c, 'OMFI:SCLP:SourceTrackID', 'omfi:UInt32', u32(track));
		this.int(c, 'OMFI:SCLP:StartTime', 'omfi:Position32', start);
		return c;
	}
	tccp(len: number, start: number, fps: number, drop: boolean): number {
		const t = this.obj('TCCP');
		this.cpnt(t, 'omfi:data:Timecode', len);
		this.int(t, 'OMFI:TCCP:Start', 'omfi:Position32', start);
		this.b.set(t, 'OMFI:TCCP:FPS', 'omfi:UInt16', u16(Math.max(1, Math.min(0xffff, fps))));
		this.b.set(t, 'OMFI:TCCP:Drop', 'omfi:Boolean', Uint8Array.of(drop ? 1 : 0));
		return t;
	}
	value(len: number, g: Gain, rate: [number, number], base: number): number {
		if (g.type === 'constant') {
			const v = this.obj('CVAL');
			this.cpnt(v, 'omfi:data:Rational', len);
			this.b.set(v, 'OMFI:CVAL:Value', 'omfi:DataValue', amp(g.value));
			return v;
		}
		const pts = g.points.map(([off, a]) => {
			const o = this.u(base + off, rate) - this.u(base, rate);
			const p = this.obj('CTLP');
			this.b.set(p, 'OMFI:CTLP:Time', 'omfi:Rational', rational(o, Math.max(1, len)));
			this.b.set(p, 'OMFI:CTLP:Value', 'omfi:DataValue', amp(a));
			this.b.set(p, 'OMFI:CTLP:EditHint', 'omfi:EditHintType', Uint8Array.of(0));
			return p;
		});
		const v = this.obj('VVAL');
		this.cpnt(v, 'omfi:data:Rational', len);
		this.b.set(v, 'OMFI:VVAL:Interpolation', 'omfi:InterpKind', u16(g.linear ? 2 : 1));
		this.refs(v, 'OMFI:VVAL:PointList', pts);
		return v;
	}
}

function fnv(s: string, h0: bigint): bigint {
	let h = h0;
	for (const b of encodeUtf8(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
}

/** Serialise the first composition of `doc` (sound slots only) as an OMF 2.0 Bento file. */
export function writeOmf(doc: CDocument, report: Report): Uint8Array {
	const comp = doc.compositions[0];
	if (!comp) throw new InterchangeError('EMPTY', 'nothing to export');
	const w = new W(report);
	let seed = fnv(comp.name, 0xcbf29ce484222325n);
	for (const s of doc.sources) seed = fnv(s.path ?? '', fnv(s.key, seed));
	const major = Number((seed >> 32n) ^ (seed & 0xffffffffn));
	let minor = 0;
	const newUid = () => uid(UID_PREFIX, major, ++minor);
	const mobs: number[] = [];
	const mediaData: number[] = [];
	const masterRef = new Map<number, [Uid, number]>();
	const groups: { key: string; members: number[] }[] = [];
	doc.sources.forEach((s, i) => {
		if (s.kind !== 'sound') return;
		const g = groups.find((x) => x.key === s.key);
		if (g) g.members.push(i);
		else groups.push({ key: s.key, members: [i] });
	});
	for (const { members } of groups) {
		const first = doc.sources[members[0]!]!;
		const master = newUid();
		const tcSrc = members.map((i) => doc.sources[i]!).find((s) => s.startTc !== null);
		const tc = tcSrc ? { start: tcSrc.startTc!, rate: tcSrc.tcRate } : null;
		const tape = newUid();
		const tapeSlots: number[] = [];
		if (tc) {
			const len = Math.max(0, ...members.map((i) => doc.sources[i]!.length));
			const r: [number, number] = [tc.rate.num, tc.rate.den];
			const t = w.tccp(w.u(len, r), tc.start, timecodeBase(tc.rate), false);
			tapeSlots.push(w.slot(r, t, 1, 'TC1', 0));
		}
		const masterSlots: number[] = [];
		members.forEach((si, k) => {
			const s = doc.sources[si]!;
			const rate = rateOf(s);
			const len = w.u(s.length, rate);
			const file = newUid();
			const fileTrack = s.channel === null ? 1 : s.channel + 1;
			const tapeTrack = 2 + k;
			const toTape = tc
				? w.sclp('omfi:data:Sound', len, tape, tapeTrack, 0)
				: w.sclp('omfi:data:Sound', len, NULL_UID, 0, 0);
			const fslot = w.slot(rate, toTape, fileTrack, `A${fileTrack}`, fileTrack);
			const desc = descriptor(w, s, len);
			const fm = w.mob('SMOB', file, s.name, [fslot]);
			w.ref(fm, 'OMFI:SMOB:MediaDescription', desc);
			mobs.push(fm);
			if (s.embedded) {
				const md = w.obj('WAVE');
				w.b.set(md, 'OMFI:MDAT:MobID', 'omfi:UID', file);
				w.b.set(
					md,
					'OMFI:WAVE:Data',
					'omfi:DataValue',
					wavFile(s.embedded, Math.max(1, s.fileChannels), s.sampleRate, s.bits),
				);
				mediaData.push(md);
			}
			if (tc) {
				const c = w.sclp('omfi:data:Sound', len, NULL_UID, 0, 0);
				tapeSlots.push(w.slot(rate, c, tapeTrack, `A${k + 1}`, k + 1));
			}
			const mclip = w.sclp('omfi:data:Sound', len, file, fileTrack, 0);
			masterSlots.push(w.slot(rate, mclip, k + 1, `A${k + 1}`, k + 1));
			masterRef.set(si, [master, k + 1]);
		});
		mobs.push(w.mob('MMOB', master, first.name, masterSlots));
		if (tc) {
			const d = w.obj('MDTP');
			const reel = first.path ? fileStem(first.path) : first.name;
			const tm = w.mob('SMOB', tape, reel, tapeSlots);
			w.ref(tm, 'OMFI:SMOB:MediaDescription', d);
			mobs.push(tm);
		}
	}
	// composition
	const crate: [number, number] = [comp.rate.num, comp.rate.den];
	const slots: number[] = [];
	const total = Math.max(
		0,
		...comp.tracks.map((t) =>
			t.items.reduce(
				(a, i) => (i.type === 'transition' ? a - i.tr.len : a + (i.type === 'filler' ? i.len : i.clip.len)),
				0,
			),
		),
	);
	const tcc = w.tccp(w.u(total, crate), comp.startTc, timecodeBase(comp.rate), comp.drop);
	slots.push(w.slot(crate, tcc, 1, 'TC1', 0));
	let trackId = 2;
	for (const t of comp.tracks) {
		if (t.kind !== 'sound') continue;
		const rate: [number, number] = [Math.max(1, comp.sampleRate), 1];
		const comps: number[] = [];
		let cursor = 0;
		for (const it of t.items) {
			if (it.type === 'filler') {
				const n = w.u(cursor + it.len, rate) - w.u(cursor, rate);
				cursor += it.len;
				const f = w.obj('FILL');
				w.cpnt(f, 'omfi:data:Sound', n);
				comps.push(f);
			} else if (it.type === 'clip') {
				const c = it.clip;
				const n = w.u(cursor + c.len, rate) - w.u(cursor, rate);
				const [mid, mtrack] = masterRef.get(c.source) ?? [NULL_UID, 0];
				const sc = w.sclp('omfi:data:Sound', n, mid, mtrack, w.u(c.start, rate));
				if (c.name) w.str(sc, 'JasperEditor:SCLP:ClipName', c.name);
				let seg = sc;
				if (c.gain) {
					const v = w.value(n, c.gain, rate, cursor);
					const input = w.obj('ESLT');
					w.b.set(input, 'OMFI:ESLT:ArgID', 'omfi:ArgIDType', i32(-1));
					w.ref(input, 'OMFI:ESLT:ArgValue', sc);
					const level = w.obj('ESLT');
					w.b.set(level, 'OMFI:ESLT:ArgID', 'omfi:ArgIDType', i32(1));
					w.ref(level, 'OMFI:ESLT:ArgValue', v);
					const kind = w.edef('omfi:effect:MonoAudioGain', 'Mono Audio Gain');
					seg = w.obj('EFFE');
					w.cpnt(seg, 'omfi:data:Sound', n);
					w.ref(seg, 'OMFI:EFFE:EffectKind', kind);
					w.refs(seg, 'OMFI:EFFE:EffectSlots', [input, level]);
				}
				comps.push(seg);
				cursor += c.len;
			} else {
				const x = it.tr;
				const ts = cursor - x.len;
				const n = w.u(cursor, rate) - w.u(ts, rate);
				const cut = w.u(ts + x.cut, rate) - w.u(ts, rate);
				cursor = ts;
				const kind = w.edef('omfi:effect:SimpleMonoAudioDissolve', 'Simple Mono Audio Dissolve');
				const e = w.obj('EFFE');
				w.cpnt(e, 'omfi:data:Sound', n);
				w.ref(e, 'OMFI:EFFE:EffectKind', kind);
				w.refs(e, 'OMFI:EFFE:EffectSlots', []);
				w.str(e, 'JasperEditor:EFFE:EffectID', x.effect);
				const tr = w.obj('TRAN');
				w.cpnt(tr, 'omfi:data:Sound', n);
				w.int(tr, 'OMFI:TRAN:CutPoint', 'omfi:Position32', cut);
				w.ref(tr, 'OMFI:TRAN:Effect', e);
				comps.push(tr);
			}
		}
		const seq = w.obj('SEQU');
		w.cpnt(seq, 'omfi:data:Sound', w.u(Math.max(0, cursor), rate));
		w.refs(seq, 'OMFI:SEQU:Components', comps);
		slots.push(w.slot(rate, seq, trackId++, t.name, t.number));
	}
	const cmob = w.mob('CMOB', newUid(), comp.name, slots);
	mobs.unshift(cmob);
	if (w.inexact) report.info('some times are not on whole samples / frames and were rounded');
	if (w.clamped) report.warn("a time does not fit OMF's 32-bit positions and was clamped");
	const ident = w.obj('IDNT');
	w.str(ident, 'OMFI:IDNT:CompanyName', 'JasperEditor');
	w.str(ident, 'OMFI:IDNT:ProductName', 'JasperEditor');
	w.str(ident, 'OMFI:IDNT:ProductVersionString', '1.0');
	w.str(ident, 'OMFI:IDNT:Platform', 'JasperEditor');
	w.b.set(ident, 'OMFI:IDNT:Date', 'omfi:TimeStamp', TIMESTAMP);
	const head = w.obj('HEAD');
	w.b.set(head, 'OMFI:HEAD:ByteOrder', 'omfi:Int16', u16(0x4d4d));
	w.b.set(head, 'OMFI:HEAD:LastModified', 'omfi:TimeStamp', TIMESTAMP);
	w.b.set(head, 'OMFI:HEAD:Version', 'omfi:VersionType', Uint8Array.of(2, 0));
	w.refs(head, 'OMFI:HEAD:Mobs', mobs);
	w.refs(head, 'OMFI:HEAD:MediaData', mediaData);
	w.refs(head, 'OMFI:HEAD:PrimaryMobs', [cmob]);
	w.refs(head, 'OMFI:HEAD:DefinitionObjects', [...w.defs]);
	w.refs(head, 'OMFI:HEAD:IdentificationList', [ident]);
	for (const k of [...w.refMap.keys()].sort((a, b) => a - b)) {
		const t = [...new Set(w.refMap.get(k)!)].sort((a, b) => a - b);
		w.b.setReferences(k, t);
	}
	return w.b.finish();
}

function descriptor(w: W, s: Source, len: number): number {
	const aiff = !s.embedded && !!s.path && ['aif', 'aiff', 'aifc'].includes(extension(s.path));
	const d = w.obj(aiff ? 'AIFD' : 'WAVD');
	w.b.set(d, 'OMFI:MDFL:IsOMFI', 'omfi:Boolean', Uint8Array.of(s.embedded ? 1 : 0));
	const r = rateOf(s);
	w.b.set(d, 'OMFI:MDFL:SampleRate', 'omfi:Rational', rational(r[0], r[1]));
	w.int(d, 'OMFI:MDFL:Length', 'omfi:Length32', len);
	const frames = Math.max(0, len);
	const ch = Math.max(1, s.fileChannels);
	if (aiff) w.b.set(d, 'OMFI:AIFD:Summary', 'omfi:DataValue', aiffHeader(frames, ch, s.sampleRate, s.bits));
	else
		w.b.set(
			d,
			'OMFI:WAVD:Summary',
			'omfi:DataValue',
			wavHeader(Math.min(0xffffffff, frames * ch * Math.ceil(s.bits / 8)), ch, s.sampleRate, s.bits),
		);
	if (s.path) {
		const locs: number[] = [];
		const dos = /^[A-Za-z]:/.test(s.path);
		const l = w.obj(dos ? 'DOSL' : 'UNXL');
		w.str(l, dos ? 'OMFI:DOSL:PathName' : 'OMFI:UNXL:PathName', s.path);
		locs.push(l);
		if (isAbsolutePath(s.path)) {
			const n = w.obj('NETL');
			w.str(n, 'OMFI:NETL:URLString', pathToFileUrl(s.path, false));
			locs.push(n);
		}
		w.refs(d, 'OMFI:MDES:Locator', locs);
	}
	return d;
}
