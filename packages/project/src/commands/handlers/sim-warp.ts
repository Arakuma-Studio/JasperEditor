import type { Draft } from 'immer';
import { anim } from '../../factories.ts';
import { evaluate } from '../../keyframes.ts';
import { resolveMasks } from '../../masks/model.ts';
import { flattenPath } from '../../path/model.ts';
import { inside, type Pt } from '../../puppet/mesh.ts';
import { meshAt, resolvePuppet } from '../../puppet/model.ts';
import { hashString } from '../../registry/fx/shader.ts';
import {
	LIQUIFY_TOOLS,
	liquifyApplyStroke,
	liquifyEmpty,
	liquifyOf,
	meshWarpOf,
	meshWarpRest,
	meshWarpSetVertex,
	RECONSTRUCTION_MODES,
} from '../../registry/fx/simulation-warp/meshes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import type { Animatable } from '../../schema/common.ts';
import type { Mask } from '../../schema/mask.ts';
import type { Puppet, PuppetPinKind, PuppetPinProp } from '../../schema/puppet.ts';
import type { Clip, EffectInstance } from '../../schema/sequence.ts';
import { type DDoc, effectNotFoundMessage, type HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf, ParamAt } from '../schemas/index.ts';
import { finish } from './keyframe.ts';
import { locateEffect, newKeyframe, paramHandlers } from './param.ts';
import { locatePin, PUPPET_PIN_RANGES, type PuppetPinLocation } from './puppet-location.ts';
import type { ClipEffectLocation as FxLoc, HandlerMap } from './util.ts';

export const SIM_WARP_OWNER = 'sim-warp' as const;

/** A clip effect instance of one of `effectIds` (refusing tracks, master and other effects). */
function clipEffect(doc: DDoc, id: string, effectIds: readonly string[], h: HandlerContext): FxLoc {
	const loc = locateEffect(doc, id);
	if (!loc) return h.fail('E_NOT_FOUND', effectNotFoundMessage(id));
	if (!effectIds.includes(loc.fx.effectId))
		return h.fail('E_INVALID_PARAM', `${id} is a ${loc.fx.effectId}, not ${effectIds.join(' / ')}`);
	if (!loc.clip)
		return h.fail(
			'E_INVALID_PARAM',
			`${loc.fx.effectId} edits need an effect on a clip (not a track or the master)`,
		);
	assertUnlocked(findTrackIn(loc.seq, loc.clip.trackId)!.track, h);
	return { seq: loc.seq, clip: loc.clip, fx: loc.fx };
}

const boxOf = (doc: DDoc, l: FxLoc) =>
	intrinsicBoxOf({ doc: doc as never, seq: l.seq as never, clip: l.clip as Clip });

/** The value of an effect param at content time `t` (keys evaluated; no expressions in handlers). */
function paramAt(l: FxLoc, name: string, t: number, d: unknown) {
	const a = l.fx.params[name] as Animatable<unknown> | undefined;
	return a ? evaluate(a, t) : d;
}

/** Writes a param of the instance with stopwatch semantics (param.set). */
function writeParam(
	doc: DDoc,
	l: FxLoc,
	name: string,
	value: unknown,
	at: ParamAt | undefined,
	h: HandlerContext,
) {
	return paramHandlers['param.set']!(
		doc,
		{
			type: 'param.set',
			target: ['effect', l.fx.id, name],
			value,
			...(at !== undefined ? { at } : {}),
		} as never,
		h,
	) as { keyframeId?: string; time?: number };
}

const MASK_INDEX = ['none', 'mask1', 'mask2', 'mask3', 'mask4', 'mask5', 'mask6', 'mask7', 'mask8'];

/** The clip's mask chosen by a "Mask n" value, as a polygon in layer px at time t (null: none). */
function maskPolygon(
	l: FxLoc,
	v: unknown,
	t: number,
	w: number,
	h: number,
): { pts: Pt[]; inverted: boolean } | null {
	const i = typeof v === 'string' ? MASK_INDEX.indexOf(v) : -1;
	const masks = (l.clip as { masks?: Mask[] }).masks;
	if (i <= 0 || !masks?.[i - 1]) return null;
	const m = resolveMasks([masks[i - 1]!], t)[0]!;
	const pts = flattenPath(m.path, 0.5 / Math.max(1, w, h)).pts.map(([x, y]) => [x * w, y * h] as Pt);
	return pts.length >= 3 ? { pts, inverted: m.inverted } : null;
}

function mustPin(doc: DDoc, pinId: string, h: HandlerContext): PuppetPinLocation {
	const l = locatePin(doc, pinId);
	if (!l) return h.fail('E_NOT_FOUND', `Puppet pin not found: ${pinId}`);
	assertUnlocked(findTrackIn(l.seq, l.clip.trackId)!.track, h);
	return l;
}
function locateMesh(doc: DDoc, meshId: string) {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips))
			for (const fx of (clip as { effects?: Draft<EffectInstance>[] }).effects ?? []) {
				const meshes = fx.puppet?.meshes ?? [];
				const index = meshes.findIndex((m) => m.id === meshId);
				if (index >= 0) return { seq, clip, fx, mesh: meshes[index]!, index };
			}
	return null;
}

const PIN_DEFAULTS: Record<Exclude<PuppetPinProp, 'position'>, number> = {
	scale: 100,
	rotation: 0,
	amount: 50,
	extent: 15,
	inFront: 50,
};
const PIN_LABELS: Record<PuppetPinKind, string> = {
	position: 'Puppet Pin',
	advanced: 'Puppet Pin',
	bend: 'Puppet Pin',
	starch: 'Starch',
	overlap: 'Overlap',
};

function newMesh(
	h: HandlerContext,
	pup: Draft<Puppet>,
	o: { seed?: Pt; outline?: Pt[]; density?: number; expansion?: number; triangles?: number; name?: string },
) {
	const id = h.ids.next('pms');
	pup.meshes.push({
		id,
		name: o.name ?? `Mesh ${pup.meshes.length + 1}`,
		...(o.outline ? { outline: o.outline } : {}),
		seed: o.seed ?? [0.5, 0.5],
		density: o.density ?? 50,
		expansion: o.expansion ?? 3,
		triangles: o.triangles ?? 350,
	} as never);
	return id;
}

const finite2 = (p: readonly number[], h: HandlerContext, what: string): Pt => {
	if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
		return h.fail('E_INVALID_PARAM', `${what} must be finite`);
	return [p[0]!, p[1]!];
};

export const simWarpHandlers = {
	'liquify.stroke': (doc, cmd: CommandOf<'liquify.stroke'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.liquify'], h);
		const box = boxOf(doc, l);
		const t = h.clipContentTime(l.seq, l.clip, cmd.at);
		const toolV = paramAt(l, 'tool', t, 'warp');
		const tool =
			cmd.tool ??
			((LIQUIFY_TOOLS as readonly string[]).includes(toolV as string)
				? (toolV as (typeof LIQUIFY_TOOLS)[number])
				: 'warp');
		const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
		const freeze = maskPolygon(l, paramAt(l, 'freezeAreaMask', t, 'none'), t, box.width, box.height);
		const recon = paramAt(l, 'reconstructionMode', t, 'revert');
		const cur = liquifyOf(paramAt(l, 'distortionMesh', t, []), box.width, box.height);
		const clone = paramAt(l, 'cloneOffset', t, [0, 0]) as number[];
		const next = liquifyApplyStroke(cur, box.width, box.height, {
			tool,
			points: cmd.points.map((p) => finite2(p, h, 'points')),
			size: cmd.size ?? num(paramAt(l, 'brushSize', t, 64), 64),
			pressure: cmd.pressure ?? num(paramAt(l, 'brushPressure', t, 50), 50),
			jitter: cmd.jitter ?? num(paramAt(l, 'turbulentJitter', t, 70), 70),
			cloneOffset: cmd.cloneOffset ?? [num(clone?.[0], 0), num(clone?.[1], 0)],
			reconstruction:
				cmd.reconstruction ??
				((RECONSTRUCTION_MODES as readonly string[]).includes(recon as string)
					? (recon as (typeof RECONSTRUCTION_MODES)[number])
					: 'revert'),
			seed: hashString(JSON.stringify(cmd.points)) | 0,
			...(freeze ? { frozen: (x: number, y: number) => inside(freeze.pts, [x, y]) !== freeze.inverted } : {}),
		});
		const r = writeParam(doc, l, 'distortionMesh', next, cmd.at, h);
		return {
			effectInstanceId: l.fx.id,
			tool,
			...(r.keyframeId ? { keyframeId: r.keyframeId } : {}),
			time: t,
		};
	},
	'liquify.reset': (doc, cmd: CommandOf<'liquify.reset'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.liquify'], h);
		const box = boxOf(doc, l);
		const r = writeParam(doc, l, 'distortionMesh', liquifyEmpty(box.width, box.height), cmd.at, h);
		return { effectInstanceId: l.fx.id, ...(r.keyframeId ? { keyframeId: r.keyframeId } : {}) };
	},
	'meshWarp.setVertex': (doc, cmd: CommandOf<'meshWarp.setVertex'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.mesh-warp'], h);
		const t = h.clipContentTime(l.seq, l.clip, cmd.at);
		const int = (v: unknown, d: number) =>
			Math.min(31, Math.max(1, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : d)));
		const cols = int(paramAt(l, 'columns', t, 7), 7);
		const rows = int(paramAt(l, 'rows', t, 7), 7);
		if (cmd.column > cols || cmd.row > rows)
			return h.fail(
				'E_INVALID_PARAM',
				`No vertex (${cmd.column}, ${cmd.row}): the mesh has ${cols + 1} × ${rows + 1}`,
			);
		if (!cmd.position && !cmd.tangents) return h.fail('E_INVALID_PARAM', 'Give a position and/or tangents');
		const cur = meshWarpOf(paramAt(l, 'distortionMesh', t, []), cols, rows);
		const next = meshWarpSetVertex(cur, cmd.column, cmd.row, cmd.position, cmd.tangents);
		const r = writeParam(doc, l, 'distortionMesh', next, cmd.at, h);
		return { effectInstanceId: l.fx.id, ...(r.keyframeId ? { keyframeId: r.keyframeId } : {}), time: t };
	},
	'meshWarp.reset': (doc, cmd: CommandOf<'meshWarp.reset'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.mesh-warp'], h);
		const t = h.clipContentTime(l.seq, l.clip, cmd.at);
		const int = (v: unknown, d: number) =>
			Math.min(31, Math.max(1, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : d)));
		const r = writeParam(
			doc,
			l,
			'distortionMesh',
			meshWarpRest(int(paramAt(l, 'columns', t, 7), 7), int(paramAt(l, 'rows', t, 7), 7)),
			cmd.at,
			h,
		);
		return { effectInstanceId: l.fx.id, ...(r.keyframeId ? { keyframeId: r.keyframeId } : {}) };
	},
	'puppet.addMesh': (doc, cmd: CommandOf<'puppet.addMesh'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.puppet'], h);
		l.fx.puppet ??= { meshes: [], pins: [] } as never;
		const id = newMesh(h, l.fx.puppet!, {
			...(cmd.seed ? { seed: finite2(cmd.seed, h, 'seed') } : {}),
			...(cmd.outline ? { outline: cmd.outline.map((p) => finite2(p, h, 'outline')) } : {}),
			...(cmd.density !== undefined ? { density: cmd.density } : {}),
			...(cmd.expansion !== undefined ? { expansion: cmd.expansion } : {}),
			...(cmd.triangles !== undefined ? { triangles: cmd.triangles } : {}),
			...(cmd.name ? { name: cmd.name } : {}),
		});
		h.defineRef(cmd.ref, id);
		return { meshId: id };
	},
	'puppet.updateMesh': (doc, cmd: CommandOf<'puppet.updateMesh'>, h) => {
		const m = locateMesh(doc, cmd.meshId);
		if (!m) return h.fail('E_NOT_FOUND', `Puppet mesh not found: ${cmd.meshId}`);
		assertUnlocked(findTrackIn(m.seq, m.clip.trackId)!.track, h);
		if (cmd.outline === null) delete (m.mesh as { outline?: unknown }).outline;
		else if (cmd.outline) m.mesh.outline = cmd.outline.map((p) => finite2(p, h, 'outline')) as never;
		if (cmd.density !== undefined) m.mesh.density = cmd.density;
		if (cmd.expansion !== undefined) m.mesh.expansion = cmd.expansion;
		if (cmd.triangles !== undefined) m.mesh.triangles = cmd.triangles;
		if (cmd.name) m.mesh.name = cmd.name;
		return { meshId: cmd.meshId };
	},
	'puppet.removeMesh': (doc, cmd: CommandOf<'puppet.removeMesh'>, h) => {
		const m = locateMesh(doc, cmd.meshId);
		if (!m) return h.fail('E_NOT_FOUND', `Puppet mesh not found: ${cmd.meshId}`);
		assertUnlocked(findTrackIn(m.seq, m.clip.trackId)!.track, h);
		const pup = m.fx.puppet!;
		pup.meshes.splice(m.index, 1);
		const before = pup.pins.length;
		pup.pins = pup.pins.filter((p) => p.meshId !== cmd.meshId) as never;
		return { removedPins: before - pup.pins.length };
	},
	'puppet.addPin': (doc, cmd: CommandOf<'puppet.addPin'>, h) => {
		const l = clipEffect(doc, cmd.effectInstanceId, ['jasper.puppet'], h);
		const box = boxOf(doc, l);
		const at = finite2(cmd.position, h, 'position');
		l.fx.puppet ??= { meshes: [], pins: [] } as never;
		const pup = l.fx.puppet!;
		let meshId = meshAt(resolvePuppet(pup as Puppet, 0), at, box.width, box.height);
		let created: string | null = null;
		if (!meshId) {
			// Outside every mesh: a new mesh from the outline (default: the layer box) under the click.
			if (
				cmd.outline &&
				!inside(
					cmd.outline.map((p) => finite2(p, h, 'outline')),
					at,
				)
			)
				return h.fail('E_INVALID_PARAM', 'The pin is outside the given outline');
			meshId = created = newMesh(h, pup, {
				seed: at,
				...(cmd.outline ? { outline: cmd.outline.map((p) => finite2(p, h, 'outline')) } : {}),
			});
			if (!meshAt(resolvePuppet(pup as Puppet, 0), at, box.width, box.height)) {
				pup.meshes.pop();
				return h.fail('E_INVALID_PARAM', 'No mesh can be made there (empty outline)');
			}
		}
		const kind = cmd.kind ?? 'position';
		const n = pup.pins.filter((p) => PIN_LABELS[p.kind] === PIN_LABELS[kind]).length + 1;
		const id = h.ids.next('ppn');
		pup.pins.push({
			id,
			name: cmd.name ?? `${PIN_LABELS[kind]} ${n}`,
			kind,
			meshId,
			rest: at,
			position: anim(at),
			scale: anim(PIN_DEFAULTS.scale),
			rotation: anim(PIN_DEFAULTS.rotation),
			amount: anim(PIN_DEFAULTS.amount),
			extent: anim(PIN_DEFAULTS.extent),
			inFront: anim(PIN_DEFAULTS.inFront),
		} as never);
		h.defineRef(cmd.ref, id);
		return { pinId: id, meshId, ...(created ? { createdMesh: created } : {}) };
	},
	'puppet.removePins': (doc, cmd: CommandOf<'puppet.removePins'>, h) => {
		const ids = new Set(cmd.pinIds);
		for (const id of ids) mustPin(doc, id, h);
		for (const id of ids) {
			const l = locatePin(doc, id)!;
			l.fx.puppet!.pins.splice(l.index, 1);
		}
		return { removed: ids.size };
	},
	'puppet.renamePin': (doc, cmd: CommandOf<'puppet.renamePin'>, h) => {
		const l = mustPin(doc, cmd.pinId, h);
		l.pin.name = cmd.name;
		return { pinId: cmd.pinId };
	},
	'puppet.movePins': (doc, cmd: CommandOf<'puppet.movePins'>, h) => {
		const keys: string[] = [];
		for (const mv of cmd.moves) {
			mustPin(doc, mv.pinId, h);
			const r = paramHandlers['param.set']!(
				doc,
				{
					type: 'param.set',
					target: ['puppetPin', mv.pinId, 'position'],
					value: mv.position,
					...(cmd.at !== undefined ? { at: cmd.at } : {}),
				} as never,
				h,
			) as { keyframeId?: string };
			if (r.keyframeId) keys.push(r.keyframeId);
		}
		return { moved: cmd.moves.length, keyframeIds: keys };
	},
	'puppet.setPinKeys': (doc, cmd: CommandOf<'puppet.setPinKeys'>, h) => {
		const l = mustPin(doc, cmd.pinId, h);
		const prop = cmd.prop ?? 'position';
		const a = l.pin[prop] as Draft<Animatable<unknown>>;
		const range = PUPPET_PIN_RANGES[prop];
		const value = (v: unknown) => {
			if (prop === 'position') {
				if (!Array.isArray(v)) return h.fail('E_INVALID_PARAM', 'position keys are [x, y]');
				return finite2(v as number[], h, 'position');
			}
			if (typeof v !== 'number') return h.fail('E_INVALID_PARAM', `${prop} keys are numbers`);
			return Math.min(
				range.max ?? Number.POSITIVE_INFINITY,
				Math.max(range.min ?? Number.NEGATIVE_INFINITY, v),
			);
		};
		const keys = cmd.keys.map((k) => ({ time: h.clipContentTime(l.seq, l.clip, k.at), v: value(k.value) }));
		const lo = Math.min(...keys.map((k) => k.time));
		const hi = Math.max(...keys.map((k) => k.time));
		if (cmd.clearSpan) a.keyframes = a.keyframes.filter((k) => k.time < lo || k.time > hi) as never;
		for (const k of keys) {
			const hit = a.keyframes.find((q) => q.time === k.time);
			if (hit) hit.value = k.v as never;
			else
				a.keyframes.push(
					newKeyframe(h, k.time, k.v, false, prop === 'position' ? 'auto-bezier' : undefined) as never,
				);
		}
		a.keyframes.sort((x, y) => x.time - y.time);
		finish([a as never]);
		return { pinId: cmd.pinId, keys: keys.length };
	},
} satisfies HandlerMap;
