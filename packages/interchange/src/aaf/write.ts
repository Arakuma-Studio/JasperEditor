// Composition model → AAF objects (Edit Protocol). Port of FilmCraft `crates/interchange/src/aaf/write.rs`
// (MIT OR Apache-2.0).
import type { CfbVersion } from '../cfb.ts';
import {
	amplitudeRational,
	type CDocument,
	type CItem,
	type CKind,
	type CMarker,
	flicksToUnits,
	type Source,
} from '../comp.ts';
import { fileStem, isAbsolutePath, pathToFileUrl } from '../paths.ts';
import type { Report } from '../report.ts';
import { InterchangeError } from '../report.ts';
import { timecodeBase } from '../time.ts';
import { CLS, DDEF, DEF, guid, META_DICTIONARY, PATHS, PID, ROOT } from './ids.ts';
import {
	type Auid,
	auidEq,
	i32le,
	i64,
	Obj,
	rational,
	u16le,
	u32le,
	utf16z,
	type Value,
	writeStore,
} from './store.ts';

const M64 = (1n << 64n) - 1n;
function mix(z0: bigint): bigint {
	let z = z0 & M64;
	z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
	z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
	return z ^ (z >> 31n);
}

/** UMID-style mob id (SMPTE 330 basic UMID): label, length 0x13, instance 0, material number. */
export function mobId(seed: bigint, n: number): Uint8Array {
	const id = new Uint8Array(32);
	id.set([0x06, 0x0a, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x05, 0x01, 0x01, 0x0f, 0x20], 0);
	id[12] = 0x13;
	const a = mix(seed ^ ((BigInt(n) * 0x9e3779b97f4a7c15n) & M64));
	const b = mix(a ^ 0xd6e8feb86659fd93n);
	const dv = new DataView(id.buffer);
	dv.setBigUint64(16, a, true);
	dv.setBigUint64(24, b, true);
	id[22] = (id[22]! & 0x0f) | 0x40;
	id[24] = (id[24]! & 0x3f) | 0x80;
	return id;
}

export function fnv(s: Uint8Array, h0: bigint): bigint {
	let h = h0;
	for (const b of s) h = ((h ^ BigInt(b)) * 0x100000001b3n) & M64;
	return h;
}

const enc = (s: string) => {
	const out: number[] = [];
	for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
	return Uint8Array.from(out);
};

/** 1970-01-01 00:00:00.00: reproducible files. */
const timestamp = () => Uint8Array.of(0xb2, 0x07, 1, 1, 0, 0, 0, 0);

const weak = (path: number[], key: Auid): Value => ({ t: 'weak', path, keyPid: PID.IDENTIFICATION, key });
const dataDef = (kind: CKind) => (kind === 'picture' ? DDEF.PICTURE : DDEF.SOUND);

/** An indirect value: byte order, type id, value. */
export function indirect(ty: Auid, v: Uint8Array): Uint8Array {
	const out = new Uint8Array(17 + v.length);
	out[0] = 0x4c;
	out.set(ty, 1);
	out.set(v, 17);
	return out;
}

const tagged = (name: string, value: string) =>
	new Obj(CLS.TAGGED_VALUE)
		.data(PID.TAG_NAME, utf16z(name))
		.data(PID.TAG_VALUE, indirect(DEF.TYPE_STRING, utf16z(value)));

const gainRational = (g: number) => rational(...amplitudeRational(g));

const definition = (cls: Auid, id: Auid, name: string) =>
	new Obj(cls).data(PID.IDENTIFICATION, id).data(PID.NAME, utf16z(name)).data(PID.DESCRIPTION, utf16z(''));

const sourceRate = (s: Source): [number, number] =>
	s.kind === 'picture' ? [s.frameRate.num, s.frameRate.den] : [Math.max(1, s.sampleRate), 1];

function timelineSlot(id: number, name: string, number: number, rate: [number, number], segment: Obj): Obj {
	const o = new Obj(CLS.TIMELINE_MOB_SLOT)
		.data(PID.SLOT_ID, u32le(id))
		.data(PID.SLOT_NAME, utf16z(name))
		.data(PID.EDIT_RATE, rational(rate[0], rate[1]))
		.data(PID.ORIGIN, i64(0))
		.set(PID.SEGMENT, { t: 'strong', o: segment });
	if (number > 0) o.data(PID.PHYSICAL_TRACK_NUMBER, u32le(number));
	return o;
}

function sourceClip(kind: CKind, len: number, source: Uint8Array, slot: number, start: number): Obj {
	return new Obj(CLS.SOURCE_CLIP)
		.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dataDef(kind)))
		.data(PID.LENGTH, i64(len))
		.data(PID.SOURCE_ID, source)
		.data(PID.SOURCE_MOB_SLOT_ID, u32le(slot))
		.data(PID.START_TIME, i64(start));
}

const slotName = (kind: CKind, n: number) => `${kind === 'picture' ? 'V' : 'A'}${n}`;

class Units {
	inexact = false;
	u(t: number, rate: [number, number]): number {
		const r = flicksToUnits(t, rate[0], rate[1]);
		if (!r.exact) this.inexact = true;
		return r.n;
	}
}

function eventSlot(w: Units, id: number, rate: [number, number], markers: CMarker[]): Obj {
	const comps = markers.map((m) => {
		const pos = w.u(m.start, rate);
		const len = w.u(m.start + m.duration, rate) - pos;
		const tags = [tagged('Name', m.name), tagged('Comment', m.comment)];
		if (m.color) tags.push(tagged('Color', m.color));
		return new Obj(CLS.COMMENT_MARKER)
			.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, DDEF.DESCRIPTIVE_METADATA))
			.data(PID.LENGTH, i64(len))
			.data(PID.POSITION, i64(pos))
			.data(PID.COMMENT, utf16z(m.comment || m.name))
			.set(PID.COMPONENT_USER_COMMENTS, { t: 'strongVec', items: tags });
	});
	return new Obj(CLS.EVENT_MOB_SLOT)
		.data(PID.SLOT_ID, u32le(id))
		.data(PID.SLOT_NAME, utf16z('Markers'))
		.data(PID.EVENT_EDIT_RATE, rational(rate[0], rate[1]))
		.set(PID.SEGMENT, {
			t: 'strong',
			o: new Obj(CLS.SEQUENCE)
				.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, DDEF.DESCRIPTIVE_METADATA))
				.set(PID.COMPONENTS, { t: 'strongVec', items: comps }),
		});
}

function transitionOp(kind: CKind, effect: string): Auid {
	if (kind === 'sound') return DEF.MONO_AUDIO_DISSOLVE;
	if (effect === 'jasper.dip-to-black') return DEF.VIDEO_FADE_TO_BLACK;
	if (effect.includes('wipe')) return DEF.SMPTE_VIDEO_WIPE;
	return DEF.VIDEO_DISSOLVE;
}

function descriptor(w: Units, s: Source): Obj {
	const rate = sourceRate(s);
	const len = w.u(s.length, rate);
	const container = s.embedded ? DEF.CONTAINER_AAF : DEF.CONTAINER_EXTERNAL;
	let d: Obj;
	if (s.kind === 'picture') {
		const lineMap = new Uint8Array(16);
		lineMap.set(u32le(2), 0);
		lineMap.set(u32le(4), 4);
		d = new Obj(CLS.CDCI_DESCRIPTOR)
			.data(PID.STORED_WIDTH, u32le(s.width))
			.data(PID.STORED_HEIGHT, u32le(s.height))
			.data(PID.FRAME_LAYOUT, Uint8Array.of(0))
			.data(PID.IMAGE_ASPECT_RATIO, rational(Math.max(1, s.width), Math.max(1, s.height)))
			.data(PID.VIDEO_LINE_MAP, lineMap)
			.data(PID.COMPONENT_WIDTH, u32le(8))
			.data(PID.HORIZONTAL_SUBSAMPLING, u32le(2));
	} else {
		const block = Math.max(1, s.fileChannels) * Math.ceil(s.bits / 8);
		d = new Obj(CLS.PCM_DESCRIPTOR)
			.data(PID.AUDIO_SAMPLING_RATE, rational(s.sampleRate, 1))
			.data(PID.LOCKED, Uint8Array.of(1))
			.data(PID.CHANNELS, u32le(Math.max(1, s.fileChannels)))
			.data(PID.QUANTIZATION_BITS, u32le(s.bits))
			.data(PID.BLOCK_ALIGN, u16le(block))
			.data(PID.AVERAGE_BPS, u32le(block * s.sampleRate));
	}
	d.data(PID.SAMPLE_RATE, rational(rate[0], rate[1]));
	d.data(PID.FILE_LENGTH, i64(len));
	d.set(PID.CONTAINER_FORMAT, weak(PATHS.CONTAINER_DEFS, container));
	if (s.path) {
		const url = isAbsolutePath(s.path) ? pathToFileUrl(s.path) : s.path;
		d.set(PID.LOCATOR, {
			t: 'strongVec',
			items: [new Obj(CLS.NETWORK_LOCATOR).data(PID.URL_STRING, utf16z(url))],
		});
	}
	return d;
}

/** Serialises a composition document as an AAF file. */
export function writeAaf(doc: CDocument, version: CfbVersion, report: Report): Uint8Array {
	const comp = doc.compositions[0];
	if (!comp) throw new InterchangeError('EMPTY', 'nothing to export');
	const w = new Units();
	let seed = fnv(enc(comp.name), 0xcbf29ce484222325n);
	for (const s of doc.sources) seed = fnv(enc(s.path ?? ''), fnv(enc(s.key), seed));
	seed = fnv(u32le(comp.tracks.length), seed);
	let next = 0;
	const newId = () => mobId(seed, ++next);
	const mobs: Obj[] = [];
	const essence: Obj[] = [];
	const usedOps: Auid[] = [];
	let usesVarying = false;
	const useOp = (op: Auid) => {
		if (!usedOps.some((x) => auidEq(x, op))) usedOps.push(op);
	};

	const groups: { key: string; members: number[] }[] = [];
	doc.sources.forEach((s, i) => {
		const g = groups.find((x) => x.key === s.key);
		if (g) g.members.push(i);
		else groups.push({ key: s.key, members: [i] });
	});
	const masterRef = new Map<number, [Uint8Array, number]>();
	for (const g of groups) {
		const masterId = newId();
		const first = doc.sources[g.members[0]!]!;
		const tcSrc = g.members.map((i) => doc.sources[i]!).find((s) => s.startTc !== null);
		const tc = tcSrc ? { start: tcSrc.startTc!, rate: tcSrc.tcRate } : null;
		const tapeId = newId();
		const tapeSlots: Obj[] = [];
		if (tc) {
			const tcr: [number, number] = [tc.rate.num, tc.rate.den];
			const len = Math.max(0, ...g.members.map((i) => doc.sources[i]!.length));
			tapeSlots.push(
				timelineSlot(
					1,
					'TC1',
					0,
					tcr,
					new Obj(CLS.TIMECODE)
						.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, DDEF.TIMECODE))
						.data(PID.LENGTH, i64(w.u(len, tcr)))
						.data(PID.TC_START, i64(tc.start))
						.data(PID.TC_FPS, u16le(Math.min(0xffff, Math.max(1, timecodeBase(tc.rate)))))
						.data(PID.TC_DROP, Uint8Array.of(0)),
				),
			);
		}
		const files: { key: string; id: Uint8Array; slots: Obj[]; si: number }[] = [];
		const masterSlots: Obj[] = [];
		g.members.forEach((si, k) => {
			const s = doc.sources[si]!;
			const rate = sourceRate(s);
			const fkey = `${s.path ?? ''}|${s.embedded ? si : -1}|${s.kind}`;
			const fileSlot = s.channel !== null ? s.channel + 1 : 1;
			const lenUnits = w.u(s.length, rate);
			let f = files.find((x) => x.key === fkey);
			if (!f) {
				f = { key: fkey, id: newId(), slots: [], si };
				files.push(f);
			}
			const tapeSlotId = 2 + k;
			const clip = sourceClip(s.kind, lenUnits, tc ? tapeId : new Uint8Array(32), tc ? tapeSlotId : 0, 0);
			if (!f.slots.some((o) => o.u32(PID.SLOT_ID) === fileSlot))
				f.slots.push(timelineSlot(fileSlot, slotName(s.kind, fileSlot), fileSlot, rate, clip));
			if (tc)
				tapeSlots.push(
					timelineSlot(
						tapeSlotId,
						slotName(s.kind, k + 1),
						k + 1,
						rate,
						sourceClip(s.kind, lenUnits, new Uint8Array(32), 0, 0),
					),
				);
			const masterSlot = k + 1;
			masterSlots.push(
				timelineSlot(
					masterSlot,
					slotName(s.kind, masterSlot),
					masterSlot,
					rate,
					sourceClip(s.kind, lenUnits, f.id, fileSlot, 0),
				),
			);
			masterRef.set(si, [masterId, masterSlot]);
		});
		const pic = g.members.map((i) => doc.sources[i]!).find((s) => s.kind === 'picture');
		const markerRate = pic ? sourceRate(pic) : sourceRate(first);
		const markers = g.members.flatMap((i) => doc.sources[i]!.markers);
		if (markers.length) {
			const uniq = markers
				.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
				.filter((m, i, l) => i === 0 || JSON.stringify(m) !== JSON.stringify(l[i - 1]));
			masterSlots.push(eventSlot(w, g.members.length + 1, markerRate, uniq));
		}
		mobs.push(
			new Obj(CLS.MASTER_MOB)
				.data(PID.MOB_ID, masterId)
				.data(PID.MOB_NAME, utf16z(first.name))
				.data(PID.MOB_LAST_MODIFIED, timestamp())
				.data(PID.MOB_CREATION_TIME, timestamp())
				.set(PID.SLOTS, { t: 'strongVec', items: masterSlots }),
		);
		for (const f of files) {
			const s = doc.sources[f.si]!;
			mobs.push(
				new Obj(CLS.SOURCE_MOB)
					.data(PID.MOB_ID, f.id)
					.data(PID.MOB_NAME, utf16z(s.name))
					.data(PID.MOB_LAST_MODIFIED, timestamp())
					.data(PID.MOB_CREATION_TIME, timestamp())
					.set(PID.SLOTS, { t: 'strongVec', items: f.slots })
					.set(PID.ESSENCE_DESCRIPTION, { t: 'strong', o: descriptor(w, s) }),
			);
			if (s.embedded)
				essence.push(
					new Obj(CLS.ESSENCE_DATA)
						.data(PID.ESSENCE_MOB_ID, f.id)
						.set(PID.ESSENCE_STREAM, { t: 'stream', d: s.embedded }),
				);
		}
		if (tc) {
			const reel = first.path ? fileStem(first.path) : first.name;
			mobs.push(
				new Obj(CLS.SOURCE_MOB)
					.data(PID.MOB_ID, tapeId)
					.data(PID.MOB_NAME, utf16z(reel))
					.data(PID.MOB_LAST_MODIFIED, timestamp())
					.data(PID.MOB_CREATION_TIME, timestamp())
					.set(PID.SLOTS, { t: 'strongVec', items: tapeSlots })
					.set(PID.ESSENCE_DESCRIPTION, { t: 'strong', o: new Obj(CLS.TAPE_DESCRIPTOR) }),
			);
		}
	}

	const crate: [number, number] = [comp.rate.num, comp.rate.den];
	const slots: Obj[] = [];
	const trackLen = (items: CItem[]) =>
		items.reduce(
			(c, i) => (i.type === 'transition' ? c - i.tr.len : c + (i.type === 'filler' ? i.len : i.clip.len)),
			0,
		);
	const total = Math.max(0, ...comp.tracks.map((t) => trackLen(t.items)));
	slots.push(
		timelineSlot(
			1,
			'TC1',
			0,
			crate,
			new Obj(CLS.TIMECODE)
				.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, DDEF.TIMECODE))
				.data(PID.LENGTH, i64(w.u(total, crate)))
				.data(PID.TC_START, i64(comp.startTc))
				.data(PID.TC_FPS, u16le(Math.min(0xffff, Math.max(1, timecodeBase(comp.rate)))))
				.data(PID.TC_DROP, Uint8Array.of(comp.drop ? 1 : 0)),
		),
	);
	let slotId = 2;
	for (const t of comp.tracks) {
		const rate: [number, number] = t.kind === 'picture' ? crate : [Math.max(1, comp.sampleRate), 1];
		const dd = dataDef(t.kind);
		const comps: Obj[] = [];
		let cursor = 0;
		for (const it of t.items) {
			if (it.type === 'filler') {
				const n = w.u(cursor + it.len, rate) - w.u(cursor, rate);
				cursor += it.len;
				comps.push(
					new Obj(CLS.FILLER).set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd)).data(PID.LENGTH, i64(n)),
				);
			} else if (it.type === 'clip') {
				const c = it.clip;
				const n = w.u(cursor + c.len, rate) - w.u(cursor, rate);
				const s = doc.sources[c.source]!;
				const [mid, mslot] = masterRef.get(c.source) ?? [new Uint8Array(32), 0];
				const sc = sourceClip(t.kind, n, mid, mslot, w.u(c.start, rate));
				if (c.name && c.name !== s.name)
					sc.set(PID.COMPONENT_USER_COMMENTS, { t: 'strongVec', items: [tagged('Clip Name', c.name)] });
				let seg = sc;
				if (c.gain && t.kind === 'sound') {
					useOp(DEF.MONO_AUDIO_GAIN);
					let param: Obj;
					if (c.gain.type === 'constant')
						param = new Obj(CLS.CONSTANT_VALUE)
							.data(PID.PARAMETER_DEFINITION, DEF.PARAM_AMPLITUDE)
							.data(PID.CONSTANT_VALUE, indirect(DEF.TYPE_RATIONAL, gainRational(c.gain.value)));
					else {
						usesVarying = true;
						const pts = c.gain.points.map(([off, a]) => {
							const o = w.u(cursor + off, rate) - w.u(cursor, rate);
							return new Obj(CLS.CONTROL_POINT)
								.data(PID.CP_TIME, rational(o, Math.max(1, n)))
								.data(PID.CP_VALUE, indirect(DEF.TYPE_RATIONAL, gainRational(a)))
								.data(PID.CP_EDIT_HINT, Uint8Array.of(0));
						});
						param = new Obj(CLS.VARYING_VALUE)
							.data(PID.PARAMETER_DEFINITION, DEF.PARAM_AMPLITUDE)
							.set(
								PID.INTERPOLATION,
								weak(PATHS.INTERPOLATION_DEFS, c.gain.linear ? DEF.INTERP_LINEAR : DEF.INTERP_CONSTANT),
							)
							.set(PID.POINT_LIST, { t: 'strongVec', items: pts });
					}
					seg = new Obj(CLS.OPERATION_GROUP)
						.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd))
						.data(PID.LENGTH, i64(n))
						.set(PID.OPERATION, weak(PATHS.OPERATION_DEFS, DEF.MONO_AUDIO_GAIN))
						.set(PID.INPUT_SEGMENTS, { t: 'strongVec', items: [sc] })
						.set(PID.PARAMETERS, { t: 'strongVec', items: [param] });
				}
				comps.push(seg);
				cursor += c.len;
			} else {
				const x = it.tr;
				const ts = cursor - x.len;
				const n = w.u(cursor, rate) - w.u(ts, rate);
				const cut = w.u(ts + x.cut, rate) - w.u(ts, rate);
				cursor = ts;
				const op = transitionOp(t.kind, x.effect);
				useOp(op);
				const og = new Obj(CLS.OPERATION_GROUP)
					.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd))
					.data(PID.LENGTH, i64(n))
					.set(PID.OPERATION, weak(PATHS.OPERATION_DEFS, op))
					.set(PID.COMPONENT_USER_COMMENTS, {
						t: 'strongVec',
						items: [tagged('JasperEditor Effect', x.effect)],
					});
				if (auidEq(op, DEF.VIDEO_DISSOLVE)) {
					usesVarying = true;
					const pts = [
						[0, 0],
						[1, 1],
					].map(([tt, v]) =>
						new Obj(CLS.CONTROL_POINT)
							.data(PID.CP_TIME, rational(tt!, 1))
							.data(PID.CP_VALUE, indirect(DEF.TYPE_RATIONAL, rational(v!, 1)))
							.data(PID.CP_EDIT_HINT, Uint8Array.of(0)),
					);
					og.set(PID.PARAMETERS, {
						t: 'strongVec',
						items: [
							new Obj(CLS.VARYING_VALUE)
								.data(PID.PARAMETER_DEFINITION, DEF.PARAM_LEVEL)
								.set(PID.INTERPOLATION, weak(PATHS.INTERPOLATION_DEFS, DEF.INTERP_LINEAR))
								.set(PID.POINT_LIST, { t: 'strongVec', items: pts }),
						],
					});
				}
				comps.push(
					new Obj(CLS.TRANSITION)
						.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd))
						.data(PID.LENGTH, i64(n))
						.data(PID.CUT_POINT, i64(cut))
						.set(PID.OPERATION_GROUP, { t: 'strong', o: og }),
				);
			}
		}
		const len = comps.reduce(
			(a, c) => a + (auidEq(c.cls, CLS.TRANSITION) ? -(c.i64(PID.LENGTH) ?? 0) : (c.i64(PID.LENGTH) ?? 0)),
			0,
		);
		const seq = new Obj(CLS.SEQUENCE)
			.set(PID.DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd))
			.data(PID.LENGTH, i64(len))
			.set(PID.COMPONENTS, { t: 'strongVec', items: comps });
		slots.push(timelineSlot(slotId++, t.name, t.number, rate, seq));
	}
	if (comp.markers.length) slots.push(eventSlot(w, slotId, crate, comp.markers));
	const compId = newId();
	mobs.unshift(
		new Obj(CLS.COMPOSITION_MOB)
			.data(PID.MOB_ID, compId)
			.data(PID.MOB_NAME, utf16z(comp.name))
			.data(PID.MOB_LAST_MODIFIED, timestamp())
			.data(PID.MOB_CREATION_TIME, timestamp())
			.data(PID.USAGE_CODE, DEF.USAGE_TOP_LEVEL)
			.set(PID.SLOTS, { t: 'strongVec', items: slots })
			.set(PID.MOB_USER_COMMENTS, {
				t: 'strongVec',
				items: [
					tagged('JasperEditor Frame Size', `${comp.width}x${comp.height}`),
					tagged('JasperEditor Audio Sample Rate', String(comp.sampleRate)),
				],
			}),
	);
	if (w.inexact) report.info('some times are not on whole edit units and were rounded');

	const ddefs = (
		[
			[DDEF.PICTURE, 'Picture'],
			[DDEF.SOUND, 'Sound'],
			[DDEF.TIMECODE, 'Timecode'],
			[DDEF.DESCRIPTIVE_METADATA, 'DescriptiveMetadata'],
		] as const
	).map(([id, name]) => definition(CLS.DATA_DEFINITION, id, name));
	const opdefs = usedOps.map((op) => {
		const [name, dd, inputs]: [string, Auid, number] = auidEq(op, DEF.VIDEO_DISSOLVE)
			? ['Video Dissolve', DDEF.PICTURE, 2]
			: auidEq(op, DEF.VIDEO_FADE_TO_BLACK)
				? ['Video Fade To Black', DDEF.PICTURE, 1]
				: auidEq(op, DEF.SMPTE_VIDEO_WIPE)
					? ['SMPTE Video Wipe', DDEF.PICTURE, 2]
					: auidEq(op, DEF.MONO_AUDIO_DISSOLVE)
						? ['Mono Audio Dissolve', DDEF.SOUND, 2]
						: ['Mono Audio Gain', DDEF.SOUND, 1];
		const o = definition(CLS.OPERATION_DEFINITION, op, name)
			.set(PID.OPDEF_DATA_DEFINITION, weak(PATHS.DATA_DEFS, dd))
			.data(PID.OPDEF_IS_TIME_WARP, Uint8Array.of(0))
			.data(PID.OPDEF_NUMBER_INPUTS, i32le(inputs));
		const params = auidEq(op, DEF.MONO_AUDIO_GAIN)
			? [DEF.PARAM_AMPLITUDE]
			: auidEq(op, DEF.VIDEO_DISSOLVE)
				? [DEF.PARAM_LEVEL]
				: [];
		if (params.length)
			o.set(PID.OPDEF_PARAMETERS_DEFINED, {
				t: 'weakVec',
				path: PATHS.PARAMETER_DEFS,
				keyPid: PID.IDENTIFICATION,
				keys: params,
			});
		return o;
	});
	const pdefs = [
		definition(CLS.PARAMETER_DEFINITION, DEF.PARAM_LEVEL, 'Level').data(
			PID.PARAMDEF_DISPLAY_UNITS,
			utf16z(''),
		),
		definition(CLS.PARAMETER_DEFINITION, DEF.PARAM_AMPLITUDE, 'Amplitude').data(
			PID.PARAMDEF_DISPLAY_UNITS,
			utf16z(''),
		),
	];
	const idefs =
		usesVarying || usedOps.length
			? [
					definition(CLS.INTERPOLATION_DEFINITION, DEF.INTERP_LINEAR, 'Linear'),
					definition(CLS.INTERPOLATION_DEFINITION, DEF.INTERP_CONSTANT, 'Constant'),
				]
			: [];
	const cdefs = [
		definition(CLS.CONTAINER_DEFINITION, DEF.CONTAINER_EXTERNAL, 'External Container'),
		definition(CLS.CONTAINER_DEFINITION, DEF.CONTAINER_AAF, 'AAF Container'),
	];
	const dict = new Obj(CLS.DICTIONARY)
		.set(PID.DATA_DEFINITIONS, { t: 'strongSet', items: ddefs, keyPid: PID.IDENTIFICATION })
		.set(PID.PARAMETER_DEFINITIONS, { t: 'strongSet', items: pdefs, keyPid: PID.IDENTIFICATION })
		.set(PID.CONTAINER_DEFINITIONS, { t: 'strongSet', items: cdefs, keyPid: PID.IDENTIFICATION });
	if (opdefs.length)
		dict.set(PID.OPERATION_DEFINITIONS, { t: 'strongSet', items: opdefs, keyPid: PID.IDENTIFICATION });
	if (idefs.length)
		dict.set(PID.INTERPOLATION_DEFINITIONS, { t: 'strongSet', items: idefs, keyPid: PID.IDENTIFICATION });
	const content = new Obj(CLS.CONTENT_STORAGE).set(PID.MOBS, {
		t: 'strongSet',
		items: mobs,
		keyPid: PID.MOB_ID,
	});
	if (essence.length)
		content.set(PID.ESSENCE_DATA, { t: 'strongSet', items: essence, keyPid: PID.ESSENCE_MOB_ID });
	const ident = new Obj(CLS.IDENTIFICATION)
		.data(PID.COMPANY_NAME, utf16z('JasperEditor'))
		.data(PID.PRODUCT_NAME, utf16z('JasperEditor'))
		.data(PID.PRODUCT_VERSION_STRING, utf16z('0.1.0'))
		.data(PID.PRODUCT_ID, guid(0x4a415350, 0x4552, 0x4544, [0x54, 0x2d, 0x41, 0x41, 0x46, 0x2d, 0x45, 0x50]))
		.data(PID.DATE, timestamp())
		.data(PID.PLATFORM, utf16z('JasperEditor'))
		.data(PID.GENERATION_AUID, mobId(seed, 0).subarray(16));
	const header = new Obj(CLS.HEADER)
		.data(PID.BYTE_ORDER, u16le(0x4949))
		.data(PID.LAST_MODIFIED, timestamp())
		.data(PID.VERSION, Uint8Array.of(1, 1))
		.data(PID.OBJECT_MODEL_VERSION, u32le(1))
		.data(PID.OPERATIONAL_PATTERN, DEF.OP_EDIT_PROTOCOL)
		.set(PID.CONTENT, { t: 'strong', o: content })
		.set(PID.DICTIONARY, { t: 'strong', o: dict })
		.set(PID.IDENTIFICATION_LIST, { t: 'strongVec', items: [ident] });
	const root = new Obj(ROOT)
		.set(PID.ROOT_META_DICTIONARY, {
			t: 'strong',
			// Only the baseline model is used: the class and type definition sets are empty (keyed by AUID, pid 0x0005).
			o: new Obj(META_DICTIONARY)
				.set(0x0003, { t: 'strongSet', items: [], keyPid: 0x0005, keySize: 16 })
				.set(0x0004, { t: 'strongSet', items: [], keyPid: 0x0005, keySize: 16 }),
		})
		.set(PID.ROOT_HEADER, { t: 'strong', o: header });
	return writeStore(root, version);
}
