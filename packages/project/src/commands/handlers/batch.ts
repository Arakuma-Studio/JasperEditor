// Batch commands (spec 15 EA-031): `clip.addAdjustmentBatch` (adjustment clips with effects and keys relative to each
// item's start: cut kits) and `keyframe.addBatch` (keys on many clip properties: punch-ins, Ken Burns). They run the
// same handlers as `clip.addAdjustment`, `effect.add` and `keyframe.add` item by item inside one command, so the
// rules (track kinds and locks, effect registry, value ranges, interpolation sides, the shape box) are exactly those of
// the single commands; a refusal is re-labelled with the offending item and key, and the transaction applies nothing.
import { type DDoc, type HandlerContext, isTempRef } from '../context.ts';
import { findTrackIn, resolveTrackIn } from '../placement.ts';
import { BATCH_LIMITS, type BatchEffect, type CommandOf } from '../schemas/index.ts';
import { CommandError } from '../types.ts';
import { effectHandlers } from './effect.ts';
import { keyframeHandlers } from './keyframe.ts';
import { structureHandlers } from './structure.ts';
import type { HandlerMap } from './util.ts';

export const BATCH_OWNER = 'edit-automation' as const;

/** Runs `f`; a refusal comes back prefixed with `where` and its path under `path` (nothing else is caught). */
function within<T>(where: string, path: string[], f: () => T): T {
	try {
		return f();
	} catch (e) {
		if (e instanceof CommandError)
			throw new CommandError(e.code, `${where}: ${e.message}`, {
				path: [...path, ...(e.path ?? [])],
				...(e.blocking ? { blocking: e.blocking } : {}),
			});
		throw e;
	}
}

type AddAdjustment = (d: DDoc, c: CommandOf<'clip.addAdjustment'>, h: HandlerContext) => { clipId: string };
type AddEffect = (d: DDoc, c: CommandOf<'effect.add'>, h: HandlerContext) => { effectInstanceId: string };
type AddKey = (
	d: DDoc,
	c: CommandOf<'keyframe.add'>,
	h: HandlerContext,
) => { keyframeId: string; time: number };

/** effect.add params of one batch effect: static values, and animated ones as `{value, keyframes}` in content time. */
function effectParams(
	e: BatchEffect,
	length: number,
	timeOf: (frame: number) => number,
	h: HandlerContext,
): Record<string, unknown> {
	const params: Record<string, unknown> = { ...(e.params ?? {}) };
	for (const [name, keys] of Object.entries(e.keyframes ?? {})) {
		keys.forEach((k, i) => {
			if (k.frame > length)
				within(`keyframes.${name}[${i}]`, ['keyframes', name, String(i)], () =>
					h.fail(
						'E_INVALID_PARAM',
						`frame ${k.frame} is after the item's end (its length is ${length} frames)`,
					),
				);
		});
		params[name] = {
			value: e.params && Object.hasOwn(e.params, name) ? e.params[name] : keys[0]!.value,
			keyframes: keys.map((k) => ({
				time: timeOf(k.frame),
				value: k.value,
				...(k.interpolation ? { interpolation: k.interpolation } : {}),
				...(k.inInterpolation ? { inInterpolation: k.inInterpolation } : {}),
				...(k.easeIn ? { easeIn: k.easeIn } : {}),
				...(k.easeOut ? { easeOut: k.easeOut } : {}),
			})),
		};
	}
	return params;
}

const keyCount = (items: CommandOf<'clip.addAdjustmentBatch'>['items']) => {
	let n = 0;
	for (const it of items)
		for (const e of it.effects ?? []) for (const keys of Object.values(e.keyframes ?? {})) n += keys.length;
	return n;
};

export const batchHandlers = {
	'clip.addAdjustmentBatch': (doc, cmd, h: HandlerContext) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const keys = keyCount(cmd.items);
		if (keys > BATCH_LIMITS.maxKeys)
			h.fail('E_LIMIT', `A batch holds at most ${BATCH_LIMITS.maxKeys} keys (got ${keys})`);
		const spans = cmd.items.map((it, i) =>
			within(`items[${i}]`, ['items', String(i)], () => {
				const at = h.frame(seq, it.start);
				const length = h.durationFrames(seq, it.length);
				if (at < 0) h.fail('E_INVALID_PARAM', 'start must be >= 0');
				if (length < 1) h.fail('E_INVALID_PARAM', 'length must be >= 1 frame');
				return { i, at, end: at + length, length };
			}),
		);
		// items never overlap each other (each would overwrite the one before it)
		const sorted = [...spans].sort((a, b) => a.at - b.at || a.i - b.i);
		for (let k = 1; k < sorted.length; k++) {
			const a = sorted[k - 1]!;
			const b = sorted[k]!;
			if (b.at < a.end)
				h.fail(
					'E_OVERLAP',
					`items[${b.i}] (frames ${b.at}–${b.end}) overlaps items[${a.i}] (frames ${a.at}–${a.end})`,
					{ path: ['items', String(b.i)] },
				);
		}
		// over clips already on the track: refused unless the caller asks to overwrite them
		const existing = resolveTrackIn(seq, cmd.trackId);
		if (existing && !cmd.overwrite) {
			const label = findTrackIn(seq, existing);
			const name = label
				? `${label.kind === 'video' ? 'V' : label.kind === 'audio' ? 'A' : 'C'}${label.index + 1}`
				: existing;
			const onTrack = Object.values(seq.clips)
				.filter((c) => c.trackId === existing)
				.sort((a, b) => a.start - b.start);
			for (const s of sorted)
				for (const c of onTrack) {
					if (c.start >= s.end) break;
					if (c.start + c.duration > s.at)
						h.fail(
							'E_OVERLAP',
							`items[${s.i}] (frames ${s.at}–${s.end}) overlaps “${c.name}” (${c.id}) on ${name}: choose an empty track or pass overwrite: true`,
							{ path: ['items', String(s.i)], blocking: [c.id] },
						);
				}
		}
		const addAdjustment = structureHandlers['clip.addAdjustment'] as unknown as AddAdjustment;
		const addEffect = effectHandlers['effect.add'] as unknown as AddEffect;
		let trackRef = cmd.trackId;
		const clipIds: string[] = [];
		const effectInstanceIds: string[][] = [];
		cmd.items.forEach((it, i) => {
			const span = spans[i]!;
			within(`items[${i}]`, ['items', String(i)], () => {
				const { clipId } = addAdjustment(
					doc,
					{
						type: 'clip.addAdjustment',
						...(cmd.sequenceId ? { sequenceId: cmd.sequenceId } : {}),
						at: span.at,
						duration: span.length,
						track: trackRef,
						...(it.name ? { name: it.name } : {}),
						...(it.ref ? { ref: it.ref } : {}),
					} as CommandOf<'clip.addAdjustment'>,
					h,
				);
				const clip = seq.clips[clipId]!;
				// the first item may have created the track from its label: the rest go on that same track
				trackRef = clip.trackId;
				clipIds.push(clipId);
				const fxIds: string[] = [];
				for (const [k, e] of (it.effects ?? []).entries())
					within(`effects[${k}] (${e.effectId})`, ['effects', String(k)], () => {
						const params = effectParams(
							e,
							span.length,
							(f) => h.clipContentTime(seq, clip, { frames: f }),
							h,
						);
						const r = addEffect(
							doc,
							{
								type: 'effect.add',
								target: { clipId },
								effectId: e.effectId,
								...(Object.keys(params).length ? { params } : {}),
							} as CommandOf<'effect.add'>,
							h,
						);
						fxIds.push(r.effectInstanceId);
					});
				effectInstanceIds.push(fxIds);
			});
		});
		return { clipIds, effectInstanceIds, trackId: trackRef };
	},

	'keyframe.addBatch': (doc, cmd, h: HandlerContext) => {
		let total = 0;
		for (const t of cmd.targets) total += t.keys.length;
		if (total > BATCH_LIMITS.maxKeys)
			h.fail('E_LIMIT', `A batch holds at most ${BATCH_LIMITS.maxKeys} keys (got ${total})`);
		const addKey = keyframeHandlers['keyframe.add'] as unknown as AddKey;
		const keyframeIds: string[][] = [];
		cmd.targets.forEach((t, i) => {
			const where = `targets[${i}] (${t.clipId} ${t.path.join('.')})`;
			within(where, ['targets', String(i)], () => {
				const { clip } = h.clip(doc, t.clipId);
				let target: string[];
				if (t.path[0] === 'effect') {
					if (t.path.length !== 3)
						h.fail('E_INVALID_PARAM', 'an effect path is ["effect", effectInstanceId, param]', {
							path: ['path'],
						});
					// a temp ref of an effect added earlier in the transaction (`path` is not an id key: resolved here)
					const raw = t.path[1]!;
					const fxId = isTempRef(raw) ? h.refs.get(raw) : raw;
					if (!fxId) h.fail('E_NOT_FOUND', `Unknown temp ref ${raw}`, { path: ['path'] });
					const fx = ((clip as { effects?: { id: string }[] }).effects ?? []).find((f) => f.id === fxId);
					if (!fx)
						h.fail('E_NOT_FOUND', `Effect instance ${raw} is not on clip ${clip.id}`, { path: ['path'] });
					target = ['effect', fxId, t.path[2]!];
				} else target = ['clip', clip.id, ...t.path];
				const times = new Map<number, number>();
				const ids: string[] = [];
				for (const [j, k] of t.keys.entries())
					within(`keys[${j}]`, ['keys', String(j)], () => {
						const r = addKey(
							doc,
							{
								type: 'keyframe.add',
								target,
								at: k.at,
								...(k.value !== undefined ? { value: k.value } : {}),
								...(k.interpolation ? { interpolation: k.interpolation } : {}),
								...(k.inInterpolation ? { inInterpolation: k.inInterpolation } : {}),
								...(k.easeIn ? { easeIn: k.easeIn } : {}),
								...(k.easeOut ? { easeOut: k.easeOut } : {}),
								...(k.spatial ? { spatial: k.spatial } : {}),
								...(cmd.sequenceId ? { sequenceId: cmd.sequenceId } : {}),
							} as CommandOf<'keyframe.add'>,
							h,
						);
						const prev = times.get(r.time);
						if (prev !== undefined)
							h.fail('E_INVALID_PARAM', `lands on the same frame as keys[${prev}] (one key per frame)`);
						times.set(r.time, j);
						ids.push(r.keyframeId);
					});
				keyframeIds.push(ids);
			});
		});
		return { keyframeIds, targets: cmd.targets.length };
	},
} satisfies HandlerMap;
