// Refresh proposal and Reroll for the editing-automation passes (spec 15 EA-003, EA-032): the engine's refresher for
// feature `edit-automation` calls this with the stored proposal (its report carries the pass and its parameters) and
// the items to re-plan. Each item is planned again on the current document by its pass's planner — kits find their cut
// again by its clips, punch-ins and Ken Burns moves their clip — with the item's own seed (Refresh) or the next one
// (Reroll), keeping its id, its temp refs, its sound and its setup items, so the replacement slots into the proposal
// where the old one was. Items that no longer apply are dropped with the reason. Pure; never throws for stored data
// (a malformed proposal gives an error result the engine reports).
import type { Proposal, ProposalItem, ProposalItemInput } from '../proposals/schema.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { AutomationInputError, automationSequence } from './common.ts';
import { replanKits } from './decorate-cuts.ts';
import { replanKenBurns } from './ken-burns.ts';
import { AUTOMATION_PASSES, type AutomationPass } from './params.ts';
import { kenBurnsItem, type ItemSound, kitItem, punchItem } from './proposal.ts';
import { type ClipSubject, replanPunchIns } from './punch-ins.ts';
import { nextSeed } from './rng.ts';
import { resolveSfx, sfxMediaInfo } from './sfx.ts';

export type AutomationRefresh =
	| { ok: true; items: ProposalItemInput[]; dropped: { itemId: string; reason: string }[] }
	| { ok: false; code: 'E_INVALID_PARAM' | 'E_NOT_FOUND'; message: string };

/** The pass and parameters stored in an automation proposal's report, or null. */
export function automationReportOf(
	p: Pick<Proposal, 'report'>,
): { pass: AutomationPass; params: Record<string, unknown> } | null {
	const r = p.report as { pass?: unknown; params?: unknown } | undefined;
	if (!r || typeof r !== 'object' || !AUTOMATION_PASSES.includes(r.pass as AutomationPass)) return null;
	const params = r.params && typeof r.params === 'object' ? (r.params as Record<string, unknown>) : {};
	return { pass: r.pass as AutomationPass, params };
}

type Meta = Record<string, unknown>;
const metaOf = (it: Pick<ProposalItem, 'meta'>): Meta =>
	it.meta && typeof it.meta === 'object' ? (it.meta as Meta) : {};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** The asset a `$ref` media of the proposal will be (the setup item's `media.register` / `upgradeLibraryCopy`). */
function assetOfRef(p: Proposal, ref: string): unknown {
	for (const it of p.items)
		for (const c of it.commands as Record<string, unknown>[])
			if ((c.type === 'media.register' || c.type === 'media.upgradeLibraryCopy') && c.ref === ref) return c.asset;
	return null;
}

/** The sound an item had (kept by a refresh): its media, timing info and gain offset; null for a silent item. */
function soundOf(doc: ProjectDocument, p: Proposal, it: ProposalItem, type: string, gainDb?: number): ItemSound | null {
	const s = metaOf(it).sound as { soundId?: unknown; title?: unknown; mediaId?: unknown } | undefined;
	const mediaId = str(s?.mediaId);
	const soundId = str(s?.soundId);
	if (!mediaId || !soundId) return null;
	const place = (it.commands as Record<string, unknown>[]).find((c) => c.type === 'soundDesign.place');
	const layer = (place?.layers as Record<string, unknown>[] | undefined)?.[0];
	const asset = mediaId.startsWith('$') ? assetOfRef(p, mediaId) : doc.media?.[mediaId];
	if (!asset) return null;
	return {
		mediaId,
		info: sfxMediaInfo(asset),
		soundId,
		title: typeof s?.title === 'string' ? s.title : null,
		type,
		...(gainDb !== undefined ? { gainDb } : {}),
		gainOffsetDb: num(layer?.gainOffsetDb) ?? 0,
	};
}

/** The track an item's adjustment clips go on (its first `clip.addAdjustmentBatch`). */
function trackRefOf(it: ProposalItem): string | null {
	const c = (it.commands as Record<string, unknown>[]).find((x) => x.type === 'clip.addAdjustmentBatch');
	return typeof c?.trackId === 'string' ? c.trackId : null;
}

/** The range and family an item covers with its selected alternative (kits never overlap any of them). */
function spanOf(it: ProposalItem): { start: number; end: number; family: string } | null {
	const k = it.selectedAlternative ?? 0;
	const m = k >= 1 ? ((it.alternatives?.[k - 1]?.meta as Meta | undefined) ?? metaOf(it)) : metaOf(it);
	const r = m.range as { start?: unknown; end?: unknown } | undefined;
	const start = num(r?.start);
	const end = num(r?.end);
	if (start === null || end === null) return null;
	return { start, end, family: String(m.family ?? metaOf(it).family ?? '') };
}

/**
 * Replacement items for `itemIds` of an automation proposal on `doc` (see the file comment). `reroll` = plan with the
 * next seed of each item. `subjects`: the engine's subject analysis for punch-ins that target the subject.
 */
export function refreshAutomationItems(
	doc: ProjectDocument,
	p: Proposal,
	itemIds: readonly string[],
	opts: { reroll?: boolean; subjects?: Readonly<Record<string, ClipSubject>> } = {},
): AutomationRefresh {
	const rep = automationReportOf(p);
	if (!rep) return { ok: false, code: 'E_INVALID_PARAM', message: 'The proposal is not an editing-automation pass' };
	let seq: ReturnType<typeof automationSequence>;
	try {
		seq = automationSequence(doc, p.sequenceId);
	} catch (e) {
		return { ok: false, code: 'E_NOT_FOUND', message: (e as Error).message };
	}
	const byId = new Map(p.items.map((it) => [it.id, it]));
	const wanted = [...new Set(itemIds)]
		.map((id) => byId.get(id))
		.filter((it): it is ProposalItem => !!it && metaOf(it).setup !== true && metaOf(it).pass === rep.pass);
	const seedOf = (it: ProposalItem) => {
		const s = num(metaOf(it).seed) ?? 0;
		return opts.reroll ? nextSeed(s) : s;
	};
	const sfxRaw = rep.params.sfx as Parameters<typeof resolveSfx>[0];
	const sfx = resolveSfx(sfxRaw, true);
	const items: ProposalItemInput[] = [];
	const dropped: { itemId: string; reason: string }[] = [];
	try {
		if (rep.pass === 'decorate-cuts') {
			const targetIds = new Set(wanted.map((w) => w.id));
			const neighbours = p.items
				.filter(
					(it) =>
						!targetIds.has(it.id) &&
						metaOf(it).kind === 'kit' &&
						it.state !== 'rejected' &&
						it.state !== 'invalid',
				)
				.map(spanOf)
				.filter((x): x is NonNullable<typeof x> => !!x);
			const targets = wanted.map((it) => {
				const m = metaOf(it);
				const cut = (m.cut ?? {}) as { outgoingClipId?: unknown; incomingClipId?: unknown };
				const out = str(cut.outgoingClipId);
				const inc = str(cut.incomingClipId);
				return {
					itemId: it.id,
					seed: seedOf(it),
					frame: num(m.frame) ?? -1,
					...(out ? { outgoingClipId: out } : {}),
					...(inc ? { incomingClipId: inc } : {}),
				};
			});
			for (const r of replanKits(doc, seq.id, rep.params, targets, neighbours)) {
				if (!r.ok) {
					dropped.push({ itemId: r.itemId, reason: r.reason });
					continue;
				}
				const old = byId.get(r.itemId)!;
				const trackRef = trackRefOf(old);
				if (!trackRef) {
					dropped.push({ itemId: r.itemId, reason: 'the item has no FX track' });
					continue;
				}
				items.push(
					kitItem(seq, r.kit, {
						trackRef,
						requires: old.requires ?? [],
						sound: soundOf(doc, p, old, sfx.type, sfx.gainDb),
					}),
				);
			}
		} else if (rep.pass === 'punch-ins') {
			const targets = wanted
				.map((it) => ({ itemId: it.id, clipId: str(metaOf(it).clipId) ?? '', seed: seedOf(it) }))
				.filter((t) => t.clipId);
			const method = rep.params.method === 'adjustment' ? 'adjustment' : 'motion';
			for (const r of replanPunchIns(doc, seq.id, rep.params, targets, {
				...(opts.subjects ? { subjects: opts.subjects } : {}),
			})) {
				if (!r.ok) {
					dropped.push({ itemId: r.itemId, reason: r.reason });
					continue;
				}
				const old = byId.get(r.itemId)!;
				items.push(
					punchItem(seq, r.punch, {
						method,
						trackRef: method === 'adjustment' ? trackRefOf(old) : null,
						requires: old.requires ?? [],
						sound: soundOf(doc, p, old, sfx.type, sfx.gainDb),
					}),
				);
			}
		} else {
			const targets = wanted
				.map((it) => ({ itemId: it.id, clipId: str(metaOf(it).clipId) ?? '', seed: seedOf(it) }))
				.filter((t) => t.clipId);
			for (const r of replanKenBurns(doc, seq.id, rep.params, targets)) {
				if (!r.ok) dropped.push({ itemId: r.itemId, reason: r.reason });
				else items.push(kenBurnsItem(seq, r.move));
			}
		}
	} catch (e) {
		if (e instanceof AutomationInputError)
			return { ok: false, code: e.code === 'E_NOT_FOUND' ? 'E_NOT_FOUND' : 'E_INVALID_PARAM', message: e.message };
		throw e;
	}
	return { ok: true, items, dropped };
}
