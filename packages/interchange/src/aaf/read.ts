// AAF objects → composition model. Reads the Edit Protocol structures written by JasperEditor, Premiere Pro, Avid
// Media Composer, DaVinci Resolve and Pro Tools (and pyaaf2): top-level composition mobs, timeline / event slots,
// sequences of fillers, source clips and transitions, operation groups (gain; other effects pass their first input),
// selectors, nested scopes, essence groups, legacy data definitions, master → file → tape mob chains, embedded
// essence. Port of FilmCraft `crates/interchange/src/aaf/read.rs` (MIT OR Apache-2.0).
import {
	type CDocument,
	type CItem,
	type CKind,
	type CMarker,
	type Composition,
	type Gain,
	itemLen,
	type Source,
	unitsToFlicks,
} from '../comp.ts';
import { fileUrlToPath } from '../paths.ts';
import { InterchangeError, type Report } from '../report.ts';
import { reduceRate } from '../time.ts';
import { parseAiff, parseWav } from '../wav.ts';
import { CLS, DDEF, DEF, PID } from './ids.ts';
import { auidEq, type Obj, rationalOf, utf16Of } from './store.ts';

type DataKind = 'picture' | 'sound' | 'timecode' | 'other';

function dataKind(o: Obj): DataKind {
	const k = o.weakKey(PID.DATA_DEFINITION) ?? o.auid(PID.DATA_DEFINITION);
	if (auidEq(k, DDEF.PICTURE) || auidEq(k, DDEF.LEGACY_PICTURE)) return 'picture';
	if (auidEq(k, DDEF.SOUND) || auidEq(k, DDEF.LEGACY_SOUND)) return 'sound';
	if (auidEq(k, DDEF.TIMECODE) || auidEq(k, DDEF.LEGACY_TIMECODE)) return 'timecode';
	return 'other';
}

const lenOf = (o: Obj) => Math.max(0, o.i64(PID.LENGTH) ?? 0);

/** The value of an indirect property: [type id, bytes]. */
function indirect(d: Uint8Array): [Uint8Array, Uint8Array] | null {
	if (d.length >= 17 && (d[0] === 0x4c || d[0] === 0x42)) return [d.subarray(1, 17), d.subarray(17)];
	if (d.length >= 16) return [d.subarray(0, 16), d.subarray(16)];
	return null;
}

function taggedValues(o: Obj, pid: number): [string, string][] {
	const out: [string, string][] = [];
	for (const t of o.objs(pid)) {
		const name = t.string(PID.TAG_NAME);
		const raw = t.bytes(PID.TAG_VALUE);
		const ind = raw ? indirect(raw) : null;
		if (name === null || !ind) continue;
		const [ty, v] = ind;
		out.push([name, auidEq(ty, DEF.TYPE_STRING) || v.length % 2 === 0 ? utf16Of(v) : '']);
	}
	return out;
}

function indirectNumber(d: Uint8Array): number | null {
	const ind = indirect(d);
	if (!ind) return null;
	const v = ind[1];
	if (v.length === 8) {
		const r = rationalOf(v);
		return r && r[1] !== 0 ? r[0] / r[1] : null;
	}
	if (v.length === 4) return new DataView(v.buffer, v.byteOffset, 4).getInt32(0, true);
	return null;
}

const rateOf = (o: Obj, pid: number): [number, number] | null => {
	const r = o.rational(pid);
	return r && r[0] > 0 && r[1] > 0 ? r : null;
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function readAaf(root: Obj, report: Report): CDocument {
	const header = root.strong(PID.ROOT_HEADER);
	if (!header) throw new InterchangeError('PARSE', 'AAF: no header object');
	const content = header.strong(PID.CONTENT);
	if (!content) throw new InterchangeError('PARSE', 'AAF: no content storage');
	const mobs = new Map<string, Obj>();
	for (const m of content.objs(PID.MOBS)) {
		const id = m.mobId(PID.MOB_ID);
		if (id) mobs.set(hex(id), m);
	}
	const essence = new Map<string, Uint8Array>();
	for (const e of content.objs(PID.ESSENCE_DATA)) {
		const id = e.mobId(PID.ESSENCE_MOB_ID);
		const d = e.stream(PID.ESSENCE_STREAM);
		if (id && d) essence.set(hex(id), d);
	}
	const r = new AafReader(report, mobs, essence);
	const comps = content.objs(PID.MOBS).filter((m) => auidEq(m.cls, CLS.COMPOSITION_MOB));
	const referenced = new Set<string>();
	for (const c of comps) collectRefs(c, referenced, 0);
	const tagged = comps.filter(
		(c) =>
			auidEq(c.auid(PID.USAGE_CODE), DEF.USAGE_TOP_LEVEL) ||
			auidEq(c.auid(PID.USAGE_CODE), DEF.USAGE_TOP_LEVEL_EP),
	);
	const top = tagged.length
		? tagged
		: comps.filter((c) => !referenced.has(hex(c.mobId(PID.MOB_ID) ?? new Uint8Array(32))));
	for (const c of top) r.doc.compositions.push(r.composition(c));
	if (!r.doc.compositions.length) throw new InterchangeError('EMPTY', 'the AAF file has no composition');
	return r.doc;
}

function collectRefs(o: Obj, out: Set<string>, depth: number): void {
	if (depth > 200) return;
	if (auidEq(o.cls, CLS.SOURCE_CLIP)) {
		const id = o.mobId(PID.SOURCE_ID);
		if (id) out.add(hex(id));
	}
	for (const [, v] of o.props) {
		if (v.t === 'strong') collectRefs(v.o, out, depth + 1);
		else if (v.t === 'strongVec' || v.t === 'strongSet')
			for (const c of v.items) collectRefs(c, out, depth + 1);
	}
}

class AafReader {
	readonly doc: CDocument = { compositions: [], sources: [] };
	private readonly sources = new Map<string, number>();

	constructor(
		private readonly report: Report,
		private readonly mobs: Map<string, Obj>,
		private readonly essence: Map<string, Uint8Array>,
	) {}

	composition(c: Obj): Composition {
		const name = c.string(PID.MOB_NAME) || 'Sequence';
		const slots = c.objs(PID.SLOTS);
		const picRate = slots
			.filter((s) => auidEq(s.cls, CLS.TIMELINE_MOB_SLOT))
			.find((s) => {
				const g = s.strong(PID.SEGMENT);
				return g && (dataKind(g) === 'picture' || dataKind(g) === 'timecode');
			})
			?.rational(PID.EDIT_RATE) ??
			slots.map((s) => rateOf(s, PID.EDIT_RATE)).find((x) => !!x) ?? [25, 1];
		const pic: [number, number] = picRate[0] > 0 && picRate[1] > 0 ? picRate : [25, 1];
		const tags = taggedValues(c, PID.MOB_USER_COMMENTS);
		const tag = (n: string) =>
			tags.find(([k]) => k === n || k === n.replace('JasperEditor', 'FilmCraft'))?.[1];
		const size = /^(\d+)\s*x\s*(\d+)$/.exec(tag('JasperEditor Frame Size') ?? '');
		let width = size ? Number(size[1]) : 0;
		let height = size ? Number(size[2]) : 0;
		let sampleRate = Number(tag('JasperEditor Audio Sample Rate') ?? 0) || 0;
		const comp: Composition = {
			name,
			rate: reduceRate({ num: pic[0], den: pic[1] }),
			sampleRate: 48000,
			width: 1920,
			height: 1080,
			startTc: 0,
			drop: false,
			tracks: [],
			markers: [],
		};
		let nv = 0;
		let na = 0;
		for (const s of slots) {
			const seg = s.strong(PID.SEGMENT);
			if (!seg) continue;
			if (auidEq(s.cls, CLS.EVENT_MOB_SLOT)) {
				comp.markers.push(...markersOf(seg, rateOf(s, PID.EVENT_EDIT_RATE) ?? pic));
				continue;
			}
			const er = rateOf(s, PID.EDIT_RATE) ?? pic;
			const origin = s.i64(PID.ORIGIN) ?? 0;
			const dk = dataKind(seg);
			if (dk === 'timecode') {
				const tc = findClass(seg, CLS.TIMECODE, 0);
				if (tc) {
					comp.startTc = Math.max(0, tc.i64(PID.TC_START) ?? 0);
					comp.drop = (tc.u8(PID.TC_DROP) ?? 0) !== 0;
				}
			} else if (dk === 'picture' || dk === 'sound') {
				const kind: CKind = dk;
				if (kind === 'sound' && sampleRate === 0 && er[1] === 1 && er[0] >= 8000) sampleRate = er[0];
				const items = this.segment(seg, er, kind, 0);
				if (origin > 0) trimFront(items, unitsToFlicks(origin, er[0], er[1]));
				const number = s.u32(PID.PHYSICAL_TRACK_NUMBER) ?? 0;
				const channels =
					kind === 'sound'
						? Math.min(
								6,
								Math.max(
									1,
									...items.map((i) =>
										i.type === 'clip' ? (this.doc.sources[i.clip.source]?.channels ?? 1) : 1,
									),
								),
							)
						: 0;
				const n = kind === 'picture' ? ++nv : ++na;
				comp.tracks.push({
					kind,
					name: s.string(PID.SLOT_NAME) ?? '',
					number: number > 0 ? number : n,
					channels,
					items,
				});
			} else this.report.info('a slot of an unsupported data kind was skipped');
		}
		if (!width) {
			const p = this.doc.sources.find((x) => x.kind === 'picture' && x.width > 0);
			width = p?.width ?? 1920;
			height = p?.height ?? 1080;
		}
		comp.width = width;
		comp.height = height;
		if (sampleRate > 0) comp.sampleRate = sampleRate;
		return comp;
	}

	segment(seg: Obj, rate: [number, number], kind: CKind, depth: number): CItem[] {
		if (depth > 32) {
			this.report.warn('segments nested too deeply were skipped');
			return [{ type: 'filler', len: unitsToFlicks(lenOf(seg), rate[0], rate[1]) }];
		}
		if (auidEq(seg.cls, CLS.SEQUENCE))
			return seg.objs(PID.COMPONENTS).flatMap((c) => this.component(c, rate, kind, depth + 1));
		return this.component(seg, rate, kind, depth + 1);
	}

	component(c: Obj, rate: [number, number], kind: CKind, depth: number): CItem[] {
		const len = unitsToFlicks(lenOf(c), rate[0], rate[1]);
		if (auidEq(c.cls, CLS.FILLER)) return [{ type: 'filler', len }];
		if (auidEq(c.cls, CLS.SOURCE_CLIP)) return [this.clip(c, rate, kind)];
		if (auidEq(c.cls, CLS.SEQUENCE)) return this.segment(c, rate, kind, depth);
		if (auidEq(c.cls, CLS.TRANSITION)) {
			const cut = unitsToFlicks(c.i64(PID.CUT_POINT) ?? 0, rate[0], rate[1]);
			const og = c.strong(PID.OPERATION_GROUP);
			const tagged = og
				? taggedValues(og, PID.COMPONENT_USER_COMMENTS).find(([k]) => k === 'JasperEditor Effect')?.[1]
				: undefined;
			const op = og?.weakKey(PID.OPERATION) ?? null;
			const effect =
				tagged ??
				(kind === 'sound'
					? 'jasper.constant-power'
					: auidEq(op, DEF.VIDEO_FADE_TO_BLACK)
						? 'jasper.dip-to-black'
						: auidEq(op, DEF.SMPTE_VIDEO_WIPE)
							? 'jasper.wipe'
							: 'jasper.cross-dissolve');
			return [{ type: 'transition', tr: { len, cut: Math.min(len, Math.max(0, cut)), effect } }];
		}
		if (auidEq(c.cls, CLS.OPERATION_GROUP)) {
			const op = c.weakKey(PID.OPERATION);
			const input = c.objs(PID.INPUT_SEGMENTS)[0];
			if (!input) {
				this.report.info('an effect without input was imported as a gap');
				return [{ type: 'filler', len }];
			}
			let gain: Gain | null = null;
			if (auidEq(op, DEF.MONO_AUDIO_GAIN)) gain = this.gain(c, len);
			else this.report.warn('effects other than audio gain are not imported (their first input is used)');
			const items = this.segment(input, rate, kind, depth);
			fit(items, len);
			if (gain) {
				const only = items.length === 1 ? items[0] : undefined;
				if (only?.type === 'clip') only.clip.gain = gain;
				else this.report.warn('audio gain around several clips was not imported');
			}
			return items;
		}
		if (auidEq(c.cls, CLS.SELECTOR)) {
			const s = c.strong(PID.SELECTED);
			if (!s) return [{ type: 'filler', len }];
			const items = this.segment(s, rate, kind, depth);
			fit(items, len);
			return items;
		}
		if (auidEq(c.cls, CLS.NESTED_SCOPE)) {
			const s = c.objs(PID.NESTED_SLOTS).at(-1);
			if (!s) return [{ type: 'filler', len }];
			const items = this.segment(s, rate, kind, depth);
			fit(items, len);
			return items;
		}
		if (auidEq(c.cls, CLS.ESSENCE_GROUP)) {
			const s = c.objs(PID.CHOICES)[0];
			if (!s) return [{ type: 'filler', len }];
			const items = this.segment(s, rate, kind, depth);
			fit(items, len);
			return items;
		}
		this.report.info('an unsupported component was imported as a gap');
		return [{ type: 'filler', len }];
	}

	gain(og: Obj, len: number): Gain | null {
		const params = og.objs(PID.PARAMETERS);
		const p = params.find((x) => auidEq(x.auid(PID.PARAMETER_DEFINITION), DEF.PARAM_AMPLITUDE)) ?? params[0];
		if (!p) return null;
		if (auidEq(p.cls, CLS.CONSTANT_VALUE)) {
			const d = p.bytes(PID.CONSTANT_VALUE);
			const v = d ? indirectNumber(d) : null;
			return v === null ? null : { type: 'constant', value: v };
		}
		if (auidEq(p.cls, CLS.VARYING_VALUE)) {
			const linear = !auidEq(p.weakKey(PID.INTERPOLATION), DEF.INTERP_CONSTANT);
			const points: [number, number][] = [];
			for (const cp of p.objs(PID.POINT_LIST)) {
				const t = cp.rational(PID.CP_TIME);
				const d = cp.bytes(PID.CP_VALUE);
				const v = d ? indirectNumber(d) : null;
				if (!t || t[1] === 0 || v === null) continue;
				points.push([Math.round((len * t[0]) / t[1]), v]);
			}
			return points.length ? { type: 'varying', linear, points } : null;
		}
		return null;
	}

	clip(c: Obj, rate: [number, number], kind: CKind): CItem {
		const len = unitsToFlicks(lenOf(c), rate[0], rate[1]);
		const start = unitsToFlicks(c.i64(PID.START_TIME) ?? 0, rate[0], rate[1]);
		const name = taggedValues(c, PID.COMPONENT_USER_COMMENTS).find(([k]) => k === 'Clip Name')?.[1] ?? '';
		const id = c.mobId(PID.SOURCE_ID);
		const slot = c.u32(PID.SOURCE_MOB_SLOT_ID);
		if (!id || slot === null || id.every((b) => b === 0)) return { type: 'filler', len };
		const r = this.resolve(id, slot, start, kind, null, 0);
		return r
			? { type: 'clip', clip: { len, source: r[0], start: r[1], gain: null, name } }
			: { type: 'filler', len };
	}

	/** Follows a source reference to a file source mob: [source index, file time]. */
	resolve(
		id: Uint8Array,
		slotId: number,
		start: number,
		kind: CKind,
		masterKey: string | null,
		depth: number,
	): [number, number] | null {
		if (depth > 16) return null;
		const mob = this.mobs.get(hex(id));
		if (!mob) {
			this.report.warn('a clip references a mob that is not in the file (imported as a gap)');
			return null;
		}
		const slot = mob.objs(PID.SLOTS).find((s) => s.u32(PID.SLOT_ID) === slotId);
		if (!slot) return null;
		const rate = rateOf(slot, PID.EDIT_RATE) ?? [25, 1];
		const seg = slot.strong(PID.SEGMENT);
		if (!seg) return null;
		if (auidEq(mob.cls, CLS.COMPOSITION_MOB)) {
			this.report.warn('nested compositions are not supported (imported as gaps)');
			return null;
		}
		if (auidEq(mob.cls, CLS.MASTER_MOB)) {
			const key = masterKey ?? hex(id);
			const clip = firstClip(seg, 0);
			if (!clip) return null;
			const inner = unitsToFlicks(clip.i64(PID.START_TIME) ?? 0, rate[0], rate[1]);
			const next = clip.mobId(PID.SOURCE_ID);
			const nextSlot = clip.u32(PID.SOURCE_MOB_SLOT_ID);
			if (!next || nextSlot === null || next.every((b) => b === 0)) return null;
			const markers = mob
				.objs(PID.SLOTS)
				.filter((s) => auidEq(s.cls, CLS.EVENT_MOB_SLOT))
				.flatMap((s) => {
					const g = s.strong(PID.SEGMENT);
					return g ? markersOf(g, rateOf(s, PID.EVENT_EDIT_RATE) ?? rate) : [];
				});
			const r = this.resolve(next, nextSlot, start + inner, kind, key, depth + 1);
			if (!r) return null;
			const src = this.doc.sources[r[0]]!;
			if (!src.markers.length) src.markers = markers;
			const mn = mob.string(PID.MOB_NAME);
			if (mn) src.name = mn;
			return r;
		}
		const desc = mob.strong(PID.ESSENCE_DESCRIPTION);
		const isFile =
			!!desc &&
			(desc.get(PID.SAMPLE_RATE) !== undefined ||
				desc.get(PID.LOCATOR) !== undefined ||
				this.essence.has(hex(id)));
		if (!isFile || !desc) return null;
		const key = masterKey ?? hex(id);
		const skey = `${hex(id)}|${slotId}|${key}`;
		const known = this.sources.get(skey);
		if (known !== undefined) return [known, start];
		const sdk = dataKind(seg);
		const segKind: CKind = sdk === 'picture' ? 'picture' : sdk === 'sound' ? 'sound' : kind;
		const url =
			desc
				.objs(PID.LOCATOR)
				.map((l) => l.string(PID.URL_STRING))
				.find((u) => !!u) ?? null;
		const path = url ? fileUrlToPath(url) : null;
		const fileRate = rateOf(desc, PID.SAMPLE_RATE) ?? rate;
		const fl = desc.i64(PID.FILE_LENGTH);
		const length =
			fl !== null ? unitsToFlicks(fl, fileRate[0], fileRate[1]) : unitsToFlicks(lenOf(seg), rate[0], rate[1]);
		const soundSlots = mob.objs(PID.SLOTS).filter((s) => {
			const g = s.strong(PID.SEGMENT);
			return g && dataKind(g) === 'sound';
		}).length;
		const fileChannels = Math.max(1, desc.u32(PID.CHANNELS) ?? 1);
		const channel =
			segKind === 'sound' && fileChannels > 1 && soundSlots > 1
				? Math.min(fileChannels - 1, Math.max(0, (slot.u32(PID.PHYSICAL_TRACK_NUMBER) ?? slotId) - 1))
				: null;
		let layout = desc.u8(PID.FRAME_LAYOUT) ?? 0;
		if (layout > 4) layout = 0;
		const storedH = desc.u32(PID.STORED_HEIGHT) ?? 0;
		const fr = reduceRate({ num: fileRate[0], den: fileRate[1] });
		// Timecode from the physical source mob.
		let tc: { start: number; rate: { num: number; den: number } } | null = null;
		const fc = firstClip(seg, 0);
		const tid = fc?.mobId(PID.SOURCE_ID);
		const tape = tid ? this.mobs.get(hex(tid)) : undefined;
		if (tape && fc) {
			for (const s of tape.objs(PID.SLOTS)) {
				const g = s.strong(PID.SEGMENT);
				const t = g ? findClass(g, CLS.TIMECODE, 0) : null;
				if (!t) continue;
				const tr = rateOf(s, PID.EDIT_RATE);
				const tcr = tr
					? reduceRate({ num: tr[0], den: tr[1] })
					: { num: Math.max(1, t.u16(PID.TC_FPS) ?? 25), den: 1 };
				const off = unitsToFlicks(fc.i64(PID.START_TIME) ?? 0, rate[0], rate[1]);
				tc = {
					start: (t.i64(PID.TC_START) ?? 0) + Math.floor((off * tcr.num) / (tcr.den * 705_600_000)),
					rate: tcr,
				};
				break;
			}
		}
		const asr = desc.rational(PID.AUDIO_SAMPLING_RATE);
		const src: Source = {
			key,
			name: mob.string(PID.MOB_NAME) ?? '',
			kind: segKind,
			path,
			channel,
			channels: channel !== null ? 1 : fileChannels,
			fileChannels,
			width: desc.u32(PID.STORED_WIDTH) ?? 0,
			height: layout === 1 || layout === 3 ? storedH * 2 : storedH,
			frameRate: segKind === 'picture' ? fr : { num: 25, den: 1 },
			sampleRate: asr && asr[0] > 0 && asr[1] > 0 ? Math.floor(asr[0] / asr[1]) : fileRate[0],
			bits: Math.min(32, Math.max(8, desc.u32(PID.QUANTIZATION_BITS) ?? 16)),
			length,
			offset: 0,
			startTc: tc?.start ?? null,
			tcRate: tc?.rate ?? fr,
			embedded: null,
			markers: [],
		};
		if (src.kind === 'sound') {
			const data = this.essence.get(hex(id));
			if (data) {
				// Embedded essence may be a whole WAVE / AIFF file.
				const parsed = parseWav(data) ?? parseAiff(data);
				if (parsed) {
					src.embedded = parsed.pcm;
					src.fileChannels = Math.max(1, parsed.channels);
					src.channels = src.channel !== null ? 1 : src.fileChannels;
					src.sampleRate = parsed.sampleRate;
					src.bits = parsed.bits;
				} else src.embedded = data;
			}
		}
		if (src.kind === 'picture' && src.width === 0) {
			src.width = 1920;
			src.height = 1080;
		}
		this.doc.sources.push(src);
		this.sources.set(skey, this.doc.sources.length - 1);
		return [this.doc.sources.length - 1, start];
	}
}

/** Drops `t` from the front of a track's items (slot origin). */
function trimFront(items: CItem[], t0: number): void {
	let t = t0;
	while (t > 0 && items.length) {
		const it = items[0]!;
		if (it.type === 'transition') {
			items.shift();
			continue;
		}
		const l = itemLen(it);
		if (l <= t) {
			items.shift();
			t -= l;
		} else {
			if (it.type === 'filler') it.len -= t;
			else {
				it.clip.len -= t;
				it.clip.start += t;
			}
			t = 0;
		}
	}
}

/** Makes the items exactly `len` long (an operation group / selector is as long as itself). */
function fit(items: CItem[], len: number): void {
	const total = items.reduce((a, i) => (i.type === 'transition' ? a - i.tr.len : a + itemLen(i)), 0);
	if (!items.length) {
		items.push({ type: 'filler', len });
		return;
	}
	if (total === len) return;
	if (total < len) {
		items.push({ type: 'filler', len: len - total });
		return;
	}
	let excess = total - len;
	let guard = 0;
	while (excess > 0 && items.length && guard++ < 100_000) {
		const last = items[items.length - 1]!;
		if (last.type === 'transition') {
			items.pop();
			continue;
		}
		const l = itemLen(last);
		if (l > excess) {
			if (last.type === 'filler') last.len -= excess;
			else last.clip.len -= excess;
			excess = 0;
		} else {
			excess -= l;
			items.pop();
		}
	}
}

function firstClip(seg: Obj, depth: number): Obj | null {
	if (depth > 64) return null;
	if (auidEq(seg.cls, CLS.SOURCE_CLIP)) return seg;
	if (auidEq(seg.cls, CLS.SEQUENCE)) {
		for (const c of seg.objs(PID.COMPONENTS)) {
			const r = firstClip(c, depth + 1);
			if (r) return r;
		}
		return null;
	}
	for (const c of [...seg.objs(PID.CHOICES), ...seg.objs(PID.INPUT_SEGMENTS)]) {
		const r = firstClip(c, depth + 1);
		if (r) return r;
	}
	return null;
}

function findClass(seg: Obj, cls: Uint8Array, depth: number): Obj | null {
	if (depth > 64) return null;
	if (auidEq(seg.cls, cls)) return seg;
	for (const c of seg.objs(PID.COMPONENTS)) {
		const r = findClass(c, cls, depth + 1);
		if (r) return r;
	}
	return null;
}

function markersOf(seg: Obj, rate: [number, number]): CMarker[] {
	const events = auidEq(seg.cls, CLS.SEQUENCE) ? seg.objs(PID.COMPONENTS) : [seg];
	return events
		.filter(
			(e) =>
				auidEq(e.cls, CLS.COMMENT_MARKER) ||
				auidEq(e.cls, CLS.DESCRIPTIVE_MARKER) ||
				e.get(PID.POSITION) !== undefined,
		)
		.map((e) => {
			const tags = taggedValues(e, PID.COMPONENT_USER_COMMENTS);
			const tag = (n: string) => tags.find(([k]) => k === n)?.[1];
			const comment = e.string(PID.COMMENT) ?? '';
			return {
				start: unitsToFlicks(e.i64(PID.POSITION) ?? 0, rate[0], rate[1]),
				duration: unitsToFlicks(Math.max(0, e.i64(PID.LENGTH) ?? 0), rate[0], rate[1]),
				name: tag('Name') ?? comment,
				comment: tag('Comment') ?? (tags.length ? comment : ''),
				color: tag('Color') ?? null,
			};
		});
}
