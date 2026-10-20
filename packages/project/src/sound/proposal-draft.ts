// Sound design proposals (spec 12 §2.5, P3-R3, P3-R5): the items of a proposal that places library sounds on cues.
// Shared by the engine's `sound-design` plan job and jasper-mcp `place_sound {mode: 'propose'}` so both write the same
// structure (wp-note "Phase 3 → WP3.2"):
//   - setup items (group `setup`, `meta.setup: true`): the "Sound Effects" bin when the project has none, one item per
//     library sound that is not in the project yet (`media.register` with its provenance; `media.setLibraryInfo` for a
//     project media of the same file that lacks it), one item per new cue (`soundCue.add`);
//   - one place item per placement (`soundDesign.place` on the cue, then any extra commands), requiring the setup items
//     of its cue and of every sound it or one of its alternatives uses, with the alternatives as command sets that put
//     another sound on layer 0 (the Review UI cycles them; `selectedAlternative` picks one).
// Accepting a place item brings its setup along (the closure of `requires`); accepting setup items alone adds media or
// cues without sounds, so reviewers accept place items (MCP accept_proposal "all" does). Pure; never throws for input
// it was given by the caller's own planner (ids are checked by the proposal validation that follows).
import type { ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { olderLibraryCopyOf } from './copy-upgrade.ts';
import { type LibraryProvenance, readLibraryProvenance } from './provenance.ts';

/** A library sound registered for the project (engine `POST /api/sounds/:id/register`). */
export type SoundProposalMedia = {
	soundId: string;
	title: string;
	fingerprint: string;
	/** Media kind of the registered file (`audio`). */
	kind: string;
	/** The engine's match in the saved project (`RegisterSoundResponse.existingMediaId`), checked against `doc`. */
	existingMediaId: string | null;
	library: LibraryProvenance;
	/** The `media.register` command of the registered file (`mediaRegisterCommand`); ref, item ref and bin are set here. */
	register: Record<string, unknown> & { asset: Record<string, unknown> };
};

/** One layer: a library sound (`soundId`) or a project media (`mediaId`), plus `soundDesign.place` layer fields. */
export type SoundProposalLayer = {
	soundId?: string;
	mediaId?: string;
} & Record<string, unknown>;

export type SoundProposalPlacement = {
	/** Item id (`PROPOSAL_ITEM_ID_RE`). */
	id: string;
	label: string;
	/** Review group (the role: `hero`, `support`…). */
	group: string;
	meta?: Record<string, unknown>;
	/** A stored cue, a new cue (`soundCue.add` input, stored by its own setup item), or a bare frame. */
	cue:
		| { cueId: string }
		| { add: Record<string, unknown>; label: string; meta?: Record<string, unknown> }
		| { frame: number };
	layers: SoundProposalLayer[];
	/** `sfx.alternatives` of the first layer (the variation ring, the placed sound first). */
	ring?: string[];
	/**
	 * Other sounds for layer 0, one alternative command set each. `layer` overrides layer 0's own fields for that sound
	 * (P6-E11: a sound tuned to the music's key gets the alternative's own tuning); a null value removes the field.
	 */
	alternatives?: {
		soundId: string;
		label: string;
		meta?: Record<string, unknown>;
		layer?: Record<string, unknown>;
	}[];
	clampStart?: boolean;
	/** Commands after the placement (e.g. a `soundCue.update` of the reason). */
	extraCommands?: Record<string, unknown>[];
	/** Further items the place item requires (Phase 4: the room glue, the delivery preset). */
	requires?: string[];
	/**
	 * Items acting on the placement's cue once it is filled (Phase 4: stop-before, build), each requiring the place item;
	 * `commands` gets the cue id (a stored id, or the `$ref` the cue's setup item binds). Not for bare-frame placements.
	 */
	after?: {
		id: string;
		label: string;
		group: string;
		meta?: Record<string, unknown>;
		commands: (cueId: string) => Record<string, unknown>[];
	}[];
};

export const SOUND_PROPOSAL_SETUP_GROUP = 'setup';
/** Item id of the bin setup item. */
export const SOUND_PROPOSAL_BIN_ITEM = 'bin';
/**
 * Item id of a sound's setup item: `sound:<sound id>`, a take's `~` written `.` (`sound:snd_<16 hex>.t3`): item ids allow
 * letters, digits, `_`, `.`, `:` and `-` only (a take id's `~` made every plan with takes fail validation).
 */
export const soundSetupItemId = (soundId: string) => `sound:${soundId.replace(/~/g, '.')}`;
export const cueSetupItemId = (placementId: string) => `cue:${placementId}`;

/** The project's root bin with this name, or null. */
function rootBin(doc: ProjectDocument, name: string): string | null {
	for (const id of doc.rootItems ?? []) {
		const it = doc.items?.[id];
		if (it?.kind === 'bin' && it.name === name) return it.id;
	}
	return null;
}

/** The project media that already is this file: the engine's match, else the same fingerprint and kind (not derived). */
export function existingSoundMedia(
	doc: ProjectDocument,
	m: Pick<SoundProposalMedia, 'existingMediaId' | 'fingerprint' | 'kind'>,
): string | null {
	const media = doc.media ?? {};
	const byEngine = m.existingMediaId;
	if (byEngine && Object.hasOwn(media, byEngine) && !media[byEngine]!.derivation) return byEngine;
	for (const a of Object.values(media))
		if (a.fingerprint === m.fingerprint && !a.derivation && a.kind === m.kind) return a.id;
	return null;
}

export type SoundProposalItems = {
	items: ProposalItemInput[];
	/** Per sound: the media id it is placed with (a project media id, or the `$ref` its setup item declares). */
	mediaOf: Map<string, string>;
	/** Sounds a placement named that are not in `media` (their placements were left out). */
	missing: string[];
};

/**
 * The proposal items of `placements` (in order) on the sequence `sequenceId` of `doc`. Placements naming a sound that is
 * not in `media` are left out (listed in `missing`). Setup items come first (bin, sounds in first-use order, cues),
 * then the place items, so every `requires` names an earlier item.
 */
export function soundProposalItems(
	doc: ProjectDocument,
	sequenceId: string,
	media: readonly SoundProposalMedia[],
	placements: readonly SoundProposalPlacement[],
	opts: {
		binName: string;
		/** Setup items of the whole proposal (room glue, delivery), placed after the sounds' setup items. */
		setup?: readonly ProposalItemInput[];
	},
): SoundProposalItems {
	const byId = new Map(media.map((m) => [m.soundId, m]));
	const missing = new Set<string>();
	const usable = placements.filter((p) => {
		const ids = [
			...p.layers.map((l) => l.soundId).filter((s): s is string => typeof s === 'string'),
			...(p.alternatives ?? []).map((a) => a.soundId),
		];
		const gone = ids.filter((s) => !byId.has(s));
		for (const s of gone) missing.add(s);
		return gone.length === 0;
	});
	const setup: ProposalItemInput[] = [];
	const mediaOf = new Map<string, string>();
	const setupOf = new Map<string, string>();
	const byFingerprint = new Map<string, { ref: string; item: string }>();
	let binRef: string | null = rootBin(doc, opts.binName);
	let binItem: string | null = null;
	let n = 0;
	const need = (soundId: string) => {
		if (mediaOf.has(soundId)) return;
		const m = byId.get(soundId)!;
		const existing = existingSoundMedia(doc, m);
		if (existing) {
			mediaOf.set(soundId, existing);
			const own = readLibraryProvenance((doc.media[existing] as { library?: unknown }).library);
			if (!own) {
				const id = soundSetupItemId(soundId);
				setup.push({
					id,
					label: `Sound provenance: ${m.title}`.slice(0, 200),
					group: SOUND_PROPOSAL_SETUP_GROUP,
					commands: [{ type: 'media.setLibraryInfo', mediaId: existing, library: m.library }],
					meta: { setup: true, soundId, title: m.title },
				});
				setupOf.set(soundId, id);
			}
			return;
		}
		// Two library ids of one file (a pack and a folder) become one media.
		const twin = byFingerprint.get(m.fingerprint);
		if (twin) {
			mediaOf.set(soundId, twin.ref);
			setupOf.set(soundId, twin.item);
			return;
		}
		if (!binRef) {
			binRef = '$sfxBin';
			binItem = SOUND_PROPOSAL_BIN_ITEM;
			setup.push({
				id: SOUND_PROPOSAL_BIN_ITEM,
				label: `Bin "${opts.binName}"`.slice(0, 200),
				group: SOUND_PROPOSAL_SETUP_GROUP,
				commands: [{ type: 'bin.create', name: opts.binName, ref: binRef }],
				meta: { setup: true },
			});
		}
		const ref = `$snd${n}`;
		const itemRef = `$sndItem${n}`;
		const older = olderLibraryCopyOf(doc, soundId, m.fingerprint);
		n++;
		const id = soundSetupItemId(soundId);
		setup.push({
			id,
			label: `Import ${m.title}`.slice(0, 200),
			group: SOUND_PROPOSAL_SETUP_GROUP,
			commands: [
				// an older copy of this sound in the project is replaced in place (one media per sound, WP6.5b)
				older
					? {
							type: 'media.upgradeLibraryCopy',
							mediaId: older,
							asset: { ...m.register.asset, library: m.library },
							ifPossible: true,
							...(typeof m.register.name === 'string' ? { name: m.register.name } : {}),
							...(m.register.label !== undefined ? { label: m.register.label } : {}),
							binId: binRef,
							ref,
							itemRef,
						}
					: {
							...m.register,
							asset: { ...m.register.asset, library: m.library },
							binId: binRef,
							ref,
							itemRef,
						},
			],
			...(binItem ? { requires: [binItem] } : {}),
			meta: { setup: true, soundId, title: m.title },
		});
		mediaOf.set(soundId, ref);
		setupOf.set(soundId, id);
		byFingerprint.set(m.fingerprint, { ref, item: id });
	};
	for (const p of usable) {
		for (const l of p.layers) if (l.soundId) need(l.soundId);
		for (const a of p.alternatives ?? []) need(a.soundId);
	}
	const cues: ProposalItemInput[] = [];
	const places: ProposalItemInput[] = [];
	const follow: ProposalItemInput[] = [];
	let cueN = 0;
	for (const p of usable) {
		const requires: string[] = [];
		let target: Record<string, unknown>;
		if ('cueId' in p.cue) target = { cueId: p.cue.cueId };
		else if ('frame' in p.cue) target = { frame: p.cue.frame };
		else {
			const ref = `$cue${cueN++}`;
			const id = cueSetupItemId(p.id);
			cues.push({
				id,
				label: p.cue.label.slice(0, 200),
				group: SOUND_PROPOSAL_SETUP_GROUP,
				commands: [{ type: 'soundCue.add', sequenceId, cues: [{ ...p.cue.add, ref }] }],
				meta: { setup: true, ...(p.cue.meta ?? {}) },
			});
			requires.push(id);
			target = { cueId: ref };
		}
		const layer = (l: SoundProposalLayer, soundId?: string, over?: Record<string, unknown>) => {
			const { soundId: own, mediaId, ...rest } = l;
			const sid = soundId ?? own;
			const merged: Record<string, unknown> = { ...rest, ...(over ?? {}) };
			for (const [k, v] of Object.entries(over ?? {})) if (v === null) delete merged[k];
			return { ...merged, mediaId: sid ? mediaOf.get(sid)! : mediaId! };
		};
		const placeCommands = (first?: string, over?: Record<string, unknown>) => [
			{
				type: 'soundDesign.place',
				sequenceId,
				...target,
				layers: p.layers.map((l, i) => layer(l, i === 0 ? first : undefined, i === 0 ? over : undefined)),
				...(p.ring?.length ? { alternatives: [...new Set(p.ring)] } : {}),
				...(p.clampStart ? { clampStart: true } : {}),
			},
			...(p.extraCommands ?? []),
		];
		for (const s of [...p.layers.map((l) => l.soundId), ...(p.alternatives ?? []).map((a) => a.soundId)]) {
			const req = s ? setupOf.get(s) : undefined;
			if (req && !requires.includes(req)) requires.push(req);
		}
		for (const r of p.requires ?? []) if (!requires.includes(r)) requires.push(r);
		const cueTarget = typeof target.cueId === 'string' ? target.cueId : null;
		if (cueTarget)
			for (const a of p.after ?? [])
				follow.push({
					id: a.id,
					label: a.label.slice(0, 200),
					group: a.group,
					commands: a.commands(cueTarget),
					requires: [p.id],
					...(a.meta ? { meta: a.meta } : {}),
				});
		places.push({
			id: p.id,
			label: p.label.slice(0, 200),
			group: p.group,
			commands: placeCommands(),
			...(requires.length ? { requires } : {}),
			...(p.meta ? { meta: p.meta } : {}),
			...(p.alternatives?.length
				? {
						alternatives: p.alternatives.map((a) => ({
							label: a.label.slice(0, 200),
							commands: placeCommands(a.soundId, a.layer),
							...(a.meta ? { meta: a.meta } : {}),
						})),
					}
				: {}),
		});
	}
	return {
		items: [...setup, ...(opts.setup ?? []), ...cues, ...places, ...follow],
		mediaOf,
		missing: [...missing],
	};
}
