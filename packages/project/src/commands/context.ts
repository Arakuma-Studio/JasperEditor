import type { Draft } from 'immer';
import { contentTimeAt } from '../derive/index.ts';
import { type IdPrefix, isValidId } from '../ids.ts';
import { interpretedFrameRate } from '../interpret/model.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { Clip, Sequence, Track } from '../schema/sequence.ts';
import { flicksPerFrame, nominalFps, type Rational, secondsToFlicks, secondsToFrames } from '../time.ts';
import { parseTimecode } from '../timecode.ts';
import { peek, peekKeys } from './handlers/util.ts';
import { findTrackIn, resolveTrackIn } from './placement.ts';
import type { ContentTimeInput, ParamAt, TimeInput } from './schemas/common.ts';
import { type CommandContext, CommandError, type ErrorCode, type Issue, type Origin } from './types.ts';

export type DSeq = Draft<Sequence>;
export type DTrack = Draft<Track>;
export type DClip = Draft<Clip>;
export type DDoc = Draft<ProjectDocument>;

export class HandlerContext {
	readonly warnings: Issue[] = [];
	commandIndex = 0;
	constructor(
		readonly ctx: CommandContext,
		readonly tx: { origin: Origin; sequenceId?: string },
		readonly refs: Map<string, string>,
	) {}

	get ids() {
		return this.ctx.ids;
	}
	get registries() {
		return this.ctx.registries;
	}

	fail(code: ErrorCode, message: string, opts?: { path?: string[]; blocking?: string[] }): never {
		throw new CommandError(code, message, opts);
	}

	warn(code: string, message: string, path?: string[]): void {
		this.warnings.push({ commandIndex: this.commandIndex, code, message, ...(path ? { path } : {}) });
	}

	defineRef(ref: string | undefined, id: string): void {
		if (!ref) return;
		if (this.refs.has(ref)) this.fail('E_INVALID_PARAM', `Temp ref ${ref} is already defined`);
		this.refs.set(ref, id);
	}

	/** A new id, or the caller-supplied one if well-formed and unused (S01:ID-004). */
	newId(doc: DDoc, prefix: IdPrefix, supplied?: string): string {
		if (supplied === undefined) return this.ctx.ids.next(prefix);
		if (!isValidId(supplied, prefix)) this.fail('E_INVALID_PARAM', `Malformed ${prefix} id: ${supplied}`);
		if (idExists(doc, supplied)) this.fail('E_INVALID_PARAM', `Id already in use: ${supplied}`);
		return supplied;
	}

	agentAuthor(): 'user' | { agent: string } {
		const o = this.tx.origin;
		return typeof o === 'object' ? { agent: o.agent } : 'user';
	}

	sequence(doc: DDoc, sequenceId?: string): DSeq {
		const id = sequenceId ?? this.tx.sequenceId;
		if (id) {
			const seq = doc.sequences[id];
			if (!seq) this.fail('E_NOT_FOUND', `Sequence not found: ${id}`);
			return seq;
		}
		const all = Object.values(doc.sequences);
		if (all.length === 1) return all[0]!;
		return this.fail('E_INVALID_PARAM', 'sequenceId is required when the project has several sequences');
	}

	clip(doc: DDoc, clipId: string): { seq: DSeq; clip: DClip } {
		const sid = this.sequenceOfClip(doc, clipId);
		if (sid === null) return this.fail('E_NOT_FOUND', `Clip not found: ${clipId}`);
		const seq = doc.sequences[sid]!;
		return { seq, clip: seq.clips[clipId]! };
	}

	private clipLookups = 0;
	private clipIndex: Map<string, string> | null = null;

	/**
	 * The id of the sequence holding clip `clipId` (read with `peek`, nothing drafted), or null. perf-core: after a
	 * few lookups in one transaction (a 300-clip edit across 200 sequences) an index of the document's clips answers
	 * them; a hit is confirmed on the current document, a miss (a clip added since) falls back to the scan.
	 */
	sequenceOfClip(doc: DDoc, clipId: string): string | null {
		const sequences = peek<Record<string, Sequence>>(doc, 'sequences')!;
		const has = (sid: string) => {
			const s = peek<Sequence>(sequences, sid);
			return !!s && !!peek(peek<Record<string, Clip>>(s, 'clips')!, clipId);
		};
		if (++this.clipLookups > 8) {
			if (!this.clipIndex) {
				this.clipIndex = new Map();
				for (const sid of peekKeys(sequences))
					for (const cid of peekKeys(peek<Record<string, Clip>>(peek<Sequence>(sequences, sid)!, 'clips')!))
						this.clipIndex.set(cid, sid);
			}
			const sid = this.clipIndex.get(clipId);
			if (sid !== undefined && has(sid)) return sid;
		}
		for (const sid of peekKeys(sequences)) if (has(sid)) return sid;
		return null;
	}

	/** Clips of one sequence; all ids must exist and share a sequence. */
	clipsOf(doc: DDoc, clipIds: readonly string[]): { seq: DSeq; clips: DClip[] } {
		if (clipIds.length === 0) this.fail('E_INVALID_PARAM', 'No clips given');
		const first = this.clip(doc, clipIds[0]!);
		const clips = clipIds.map((id) => {
			const c = first.seq.clips[id];
			if (!c) {
				this.clip(doc, id); // throws E_NOT_FOUND if missing anywhere
				this.fail('E_INVALID_PARAM', 'Clips must belong to one sequence');
			}
			return c;
		});
		return { seq: first.seq, clips: [...new Set(clips)] };
	}

	track(seq: DSeq, ref: string): Draft<Track> {
		const id = resolveTrackIn(seq, ref);
		if (!id) this.fail('E_NOT_FOUND', `Track not found: ${ref}`);
		return findTrackIn(seq, id)!.track;
	}

	/** Sequence time input → frame (S01:TIME-006). */
	frame(seq: DSeq, input: TimeInput): number {
		const rate = seq.settings.frameRate as Rational;
		if (typeof input === 'number') return input;
		if (typeof input === 'string') {
			const f = parseTimecode(input, rate, {
				dropFrame: input.includes(';') || seq.settings.dropFrame,
				startFrames: seq.settings.startTimecodeFrames,
			});
			if (f === null) this.fail('E_INVALID_PARAM', `Invalid timecode: ${input}`);
			return f;
		}
		if ('frames' in input) return input.frames;
		return secondsToFrames(input.seconds, rate, 'round');
	}

	/** Duration input → frames (same forms as sequence time; timecode strings count from 0). */
	durationFrames(seq: DSeq, input: TimeInput): number {
		if (typeof input === 'string') {
			const rate = seq.settings.frameRate as Rational;
			const f = parseTimecode(input, rate, { dropFrame: input.includes(';') || seq.settings.dropFrame });
			if (f === null) this.fail('E_INVALID_PARAM', `Invalid timecode: ${input}`);
			return f;
		}
		return this.frame(seq, input);
	}

	/**
	 * Content time input → flicks; `sourceFrames` uses the asset's nominal rate, else `fallbackRate` (a still has no
	 * rate of its own: the rate ffprobe reports for an image, 25 fps, is not one).
	 */
	flicks(input: ContentTimeInput, asset: MediaAsset | null | undefined, fallbackRate: Rational): number {
		if ('flicks' in input) return input.flicks;
		if ('seconds' in input) return secondsToFlicks(input.seconds);
		const vs = asset?.kind === 'image' ? undefined : asset?.probe.streams.find((s) => s.type === 'video');
		// media frames count at the interpreted (assumed) frame rate.
		const rate =
			vs && vs.type === 'video' && asset ? (interpretedFrameRate(asset) ?? vs.frameRate) : fallbackRate;
		return Math.round(input.sourceFrames * flicksPerFrame({ num: nominalFps(rate), den: 1 }));
	}

	/** `at` for parameters (S01:CMD-013) → content time (flicks) of `clip`. */
	clipContentTime(seq: DSeq, clip: DClip, at: ParamAt | undefined): number {
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const fromSeqFrame = (f: number) => contentTimeAt(clip, f, rate);
		let t: number;
		if (at === undefined) t = fromSeqFrame(clip.start);
		else if (typeof at === 'string') t = fromSeqFrame(this.frame(seq, at));
		else if (typeof at === 'number') t = fromSeqFrame(clip.start + at);
		else if ('frames' in at) t = fromSeqFrame(clip.start + at.frames);
		else if ('sequenceFrame' in at) t = fromSeqFrame(at.sequenceFrame);
		else t = at.flicks;
		// Snap to the clip's frame grid in content time (S01:KF-005).
		const step = F * clip.speed.rate;
		const k = Math.round((t - clip.sourceIn) / step);
		return Math.max(0, Math.round(clip.sourceIn + k * step));
	}

	/** `at` for track/master parameters → sequence time in flicks. */
	sequenceContentTime(seq: DSeq, at: ParamAt | undefined): number {
		const F = flicksPerFrame(seq.settings.frameRate as Rational);
		if (at === undefined) return 0;
		if (typeof at === 'string') return this.frame(seq, at) * F;
		if (typeof at === 'number') return at * F;
		if ('frames' in at) return at.frames * F;
		if ('sequenceFrame' in at) return at.sequenceFrame * F;
		return Math.round(at.flicks / F) * F;
	}
}

function idExists(doc: DDoc | ProjectDocument, id: string): boolean {
	if (doc.projectId === id || doc.items[id] || doc.media[id] || doc.synthetics[id] || doc.transcripts[id])
		return true;
	if (doc.fonts[id] || doc.sequences[id]) return true;
	const styles = peek<Record<string, unknown>>(doc, 'textStyles');
	if (styles && typeof styles === 'object' && peek(styles, id)) return true;
	const looks = peek<Record<string, unknown>>(doc, 'titleLooks');
	if (looks && typeof looks === 'object' && peek(looks, id)) return true;
	const sequences = peek<Record<string, Sequence>>(doc, 'sequences')!;
	for (const sid of peekKeys(sequences)) {
		const seq = peek<Sequence>(sequences, sid)!;
		for (const k of ['clips', 'transitions', 'links', 'groups'] as const)
			if (peek(peek<Record<string, unknown>>(seq, k)!, id)) return true;
	}
	return false;
}

const REF_RE = /^\$[A-Za-z_][\w.-]*$/;
// `matteTrack` (Track Matte Key's track param) takes a temp ref of a track added in the same transaction.
const ID_KEY_RE = /(?:Id|Ids)$|^(?:target|track|tracks|matteTrack)$/;
// `payload` (clipboard commands) is data from another document, `preset` (effect.applyPreset) library data: their
// ids are never refs or selections.
const DECL_KEYS = new Set(['ref', 'itemRef', 'type', 'payload', 'preset']);

/** True for a temp ref (`$name`); `$selection` forms are not refs. */
export function isTempRef(v: unknown): v is string {
	return typeof v === 'string' && REF_RE.test(v) && v !== '$selection' && v !== '$selection.primary';
}

/**
 * Replaces the temp refs named in `refs` in id-bearing arguments (the same positions `substituteRefs` resolves) and
 * leaves every other value untouched. Proposals use it to point a later item at what an earlier, already accepted
 * item created (its refs no longer exist in a new transaction).
 */
export function substituteKnownRefs<T>(value: T, refs: ReadonlyMap<string, string>): T {
	if (refs.size === 0) return value;
	const walk = (v: unknown, idContext: boolean): unknown => {
		if (typeof v === 'string') return idContext && REF_RE.test(v) ? (refs.get(v) ?? v) : v;
		if (Array.isArray(v)) return v.map((x) => walk(x, idContext));
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) {
				const nx = DECL_KEYS.has(k) ? x : walk(x, idContext || ID_KEY_RE.test(k));
				// A JSON key "__proto__" stays an own property (assignment would set the prototype).
				Object.defineProperty(out, k, { value: nx, enumerable: true, writable: true, configurable: true });
			}
			return out;
		}
		return v;
	};
	return walk(value, false) as T;
}

/** `clip.properties` / `get_clip_properties` key prefix of an effect instance (`effects.<id>.<param>`). */
const EFFECT_KEY_PREFIX = 'effects.';

/**
 * An effect instance id given as itself (`fx_…`) or as its properties key `effects.<id>` (what `props` prints, without
 * the parameter): the bare id.
 */
export function effectInstanceIdOf(raw: string): string {
	return raw.startsWith(EFFECT_KEY_PREFIX) && raw.length > EFFECT_KEY_PREFIX.length
		? raw.slice(EFFECT_KEY_PREFIX.length)
		: raw;
}

/** The refusal message of an effect instance id that names no effect (with the forms it accepts). */
export function effectNotFoundMessage(raw: string): string {
	return `Effect instance not found: ${raw} (give the instance id "fx_…" or its properties key "effects.fx_…", without a parameter name)`;
}

/** `effectInstanceId` / `effectInstanceIds` arguments in the `effects.<id>` form → the bare ids (`effectInstanceIdOf`). */
export function normalizeEffectInstanceIds<T>(value: T): T {
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (!v || typeof v !== 'object') return v;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			let nx: unknown;
			if (k === 'effectInstanceId' && typeof x === 'string') nx = effectInstanceIdOf(x);
			else if (k === 'effectInstanceIds' && Array.isArray(x))
				nx = x.map((s) => (typeof s === 'string' ? effectInstanceIdOf(s) : s));
			else nx = DECL_KEYS.has(k) ? x : walk(x);
			Object.defineProperty(out, k, { value: nx, enumerable: true, writable: true, configurable: true });
		}
		return out;
	};
	return walk(value) as T;
}

/**
 * Replaces temp refs (`$name`), `"$selection"` and `"$selection.primary"` in id-bearing arguments
 * (keys ending in `Id`/`Ids`, `target`, `track`, `tracks`) at execution time (S01:CMD-006, SEL-009).
 */
export function substituteRefs<T>(
	value: T,
	refs: ReadonlyMap<string, string>,
	selection: CommandContext['selection'],
): T {
	const resolveOne = (s: string): string => {
		if (s === '$selection.primary') {
			if (!selection?.primaryClip) throw new CommandError('E_INVALID_PARAM', 'No primary selected clip');
			return selection.primaryClip;
		}
		const id = refs.get(s);
		if (!id) {
			const known = [...refs.keys()];
			throw new CommandError(
				'E_NOT_FOUND',
				`Unknown temp ref ${s}: ${
					known.length ? `the refs declared so far are ${known.join(', ')}` : 'no ref has been declared yet'
				}. Declare it with \`ref: "${s}"\` on an earlier command of the same transaction (refs do not carry over between transactions; use the created id instead).`,
			);
		}
		return id;
	};
	const walk = (v: unknown, idContext: boolean): unknown => {
		if (typeof v === 'string') return idContext && REF_RE.test(v) ? resolveOne(v) : v;
		if (Array.isArray(v)) {
			const out: unknown[] = [];
			for (const x of v) {
				if (idContext && x === '$selection') {
					if (!selection)
						throw new CommandError('E_INVALID_PARAM', '$selection used without a session selection');
					out.push(...selection.clips);
				} else out.push(walk(x, idContext));
			}
			return out;
		}
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, x] of Object.entries(v)) {
				if (DECL_KEYS.has(k)) out[k] = x;
				else if (x === '$selection' && /Ids$/.test(k)) {
					if (!selection)
						throw new CommandError('E_INVALID_PARAM', '$selection used without a session selection');
					out[k] = [...selection.clips];
				} else out[k] = walk(x, idContext || ID_KEY_RE.test(k));
			}
			return out;
		}
		return v;
	};
	return walk(value, false) as T;
}
