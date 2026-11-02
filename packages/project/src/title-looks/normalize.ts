// Spec 19 TL-011: per-transaction upkeep of `lookOverrides`, whatever command changed a linked clip (`param.set`,
// `keyframe.*`, `expression.*`, `appearance.*`, Paste Attributes…). Only clips the transaction changed are looked at
// (tx-delta.ts); a document without looks costs one check.
import type { Draft } from 'immer';
import { latest } from '../commands/draft-read.ts';
import { txDelta } from '../commands/tx-delta.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, EffectInstance } from '../schema/sequence.ts';
import { type Appearance, clipLook, isPlainObject, type TitleLook } from './model.ts';
import { diffAppearance } from './overrides.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function upkeep(fx: Draft<EffectInstance>, doc: Draft<ProjectDocument>): void {
	const a = latest(fx).appearance as Appearance | undefined;
	if (!a?.lookId) return;
	const looks = latest(doc).titleLooks as Record<string, TitleLook> | undefined;
	const look = looks && Object.hasOwn(looks, a.lookId) ? latest(looks[a.lookId]!) : undefined;
	if (!look) return; // soft: a look that is gone reads as "not linked"; repair and `look.delete` drop the link.
	const next = diffAppearance(latest(look.appearance) as Appearance, a);
	const empty = Object.keys(next).length === 0;
	if (empty ? a.lookOverrides === undefined : same(a.lookOverrides, next)) return;
	const draft = fx.appearance as Draft<Appearance>;
	if (empty) delete draft.lookOverrides;
	else draft.lookOverrides = next;
}

/** Refreshes the overrides of the linked clips this transaction changed. */
export function normalizeLookLinks(doc: Draft<ProjectDocument>): void {
	const hasLooks = isPlainObject(latest(doc).titleLooks);
	if (!hasLooks) return;
	const delta = txDelta(doc as ProjectDocument);
	const changed = delta
		? delta.clips.filter((c) => c.after).map((c) => ({ sid: c.sid, id: (c.after as Clip).id }))
		: Object.entries(latest(doc).sequences).flatMap(([sid, s]) =>
				Object.keys(latest(s.clips)).map((id) => ({ sid, id })),
			);
	for (const { sid, id } of changed) {
		const raw = latest(latest(doc.sequences)[sid]!.clips)[id] as Clip | undefined;
		const fx = clipLook((raw as { effects?: EffectInstance[] } | undefined)?.effects);
		if (!(fx as EffectInstance | null)?.appearance) continue;
		const clip = doc.sequences[sid]!.clips[id] as Draft<{ effects: EffectInstance[] }>;
		upkeep(clipLook(clip.effects) as Draft<EffectInstance>, doc);
	}
}
