// The accept journal (spec 12 §2.5 "Accept", AGENTS.md §0.4). Accepting items is two writes: the transaction (into the
// open editor's session, or the saved project headless) and the proposal's states. An engine that stops between them
// (a crash, a kill, a lost relay answer) would leave the items pending although they are in the document, and
// accepting them again would apply them twice. So the accept writes an INTENT first (atomic, fsync): the items, the
// revision it validated at, and the id bodies the transaction will create its entities with (random, chosen now and
// passed to the transaction, `createPresetIdSource`). It removes the intent after the states are written. An intent
// found later is reconciled with the live document (`reconcileEvidence`): any of its ids in the document → the accept
// applied (the items are recorded accepted with what is there); none → it did not (the intent is rolled back). A
// transaction that creates nothing is told by the entities it changes (their fingerprints before and after).
import { createHash } from 'node:crypto';
import {
	anchorFingerprint,
	createPresetIdSource,
	createRandomIdSource,
	applyTransaction as dryApply,
	ID_BODY_RE,
	type IdSource,
	MAX_PRESET_IDS,
	PROPOSAL_LIMITS,
	type ProjectDocument,
	type Registries,
	randomIdBodies,
	type TransactionResult,
} from '@jasper/project';
import { z } from 'zod';

const ITEM_ID = z.string().min(1).max(64);
const ENTITY_ID = z.string().regex(/^[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{16}$/);
const HASH = z.string().regex(/^[0-9a-f]{64}$/);

export const ACCEPT_INTENT_VERSION = 1;

export const AcceptIntentSchema = z.strictObject({
	version: z.literal(ACCEPT_INTENT_VERSION),
	/** One accept attempt (several attempts of the same proposal never share an intent). */
	acceptId: z.string().regex(/^acc_[0-9A-HJKMNP-TV-Z]{16}$/),
	projectId: z.string().min(1).max(64),
	proposalId: z.string().min(1).max(64),
	/** The items the transaction applies (the closure, proposal order). */
	itemIds: z.array(ITEM_ID).min(1).max(PROPOSAL_LIMITS.maxItems),
	/** The live revision the accept validated at; `via` where the transaction was sent. */
	baseRevision: z.number().int().min(0),
	via: z.enum(['session', 'headless']),
	at: z.string().max(40),
	/** The id bodies the transaction creates its entities with, in order. */
	ids: z.array(z.string().regex(ID_BODY_RE)).max(MAX_PRESET_IDS),
	/** Whether the dry run on the validated document applied (else nothing below is known). */
	dryRun: z.enum(['ok', 'failed']),
	/** What the transaction was expected to define and create (a dry run on the validated document, same ids). */
	refs: z.record(z.string().max(200), ENTITY_ID),
	created: z.array(ENTITY_ID).max(PROPOSAL_LIMITS.maxCreated),
	/** A transaction that creates nothing: the entities it changes or deletes, fingerprinted before and after. */
	changes: z
		.array(z.strictObject({ id: z.string().max(64), before: HASH.nullable(), after: HASH.nullable() }))
		.max(PROPOSAL_LIMITS.maxCreated),
});
export type AcceptIntent = z.infer<typeof AcceptIntentSchema>;

/** Slack over the dry run's count: the live document may make the transaction create a few more entities. */
const ID_SLACK = (n: number) => Math.min(MAX_PRESET_IDS, Math.ceil(n * 1.25) + 16);

/** A counting id source (how many ids a transaction takes). */
function counting(inner: IdSource): IdSource & { count: number } {
	const src = {
		count: 0,
		next(prefix: Parameters<IdSource['next']>[0]) {
			src.count++;
			return inner.next(prefix);
		},
	};
	return src;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted (the same value always gives the same text). Depth-bounded. */
function stableJson(v: unknown, depth = 0): string {
	if (depth > 64) return '"…"';
	if (Array.isArray(v)) return `[${v.map((x) => stableJson(x, depth + 1)).join(',')}]`;
	if (v && typeof v === 'object') {
		const keys = Object.keys(v).sort();
		return `{${keys
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k], depth + 1)}`)
			.join(',')}}`;
	}
	return JSON.stringify(v) ?? 'null';
}

/** Where an entity id lives in a document, as one value (or null when absent). Bounded: top-level records only. */
function entityValue(doc: ProjectDocument, id: string): unknown {
	if (id === doc.projectId)
		return { name: doc.name, settings: doc.settings, rootItems: doc.rootItems, extensions: doc.extensions };
	for (const rec of [doc.items, doc.media, doc.synthetics, doc.transcripts, doc.fonts] as Record<
		string,
		unknown
	>[])
		if (rec && Object.hasOwn(rec, id)) return rec[id];
	for (const [sid, seq] of Object.entries(doc.sequences ?? {})) {
		if (sid === id) {
			const { clips: _c, transitions: _t, links: _l, groups: _g, markers: _m, ...own } = seq;
			const sd = (own as { soundDesign?: { cues?: unknown } }).soundDesign;
			return { ...own, ...(sd ? { soundDesign: { ...sd, cues: undefined } } : {}) };
		}
		for (const rec of [seq.clips, seq.transitions, seq.links, seq.groups] as Record<string, unknown>[])
			if (rec && Object.hasOwn(rec, id)) return rec[id];
		const marker = seq.markers?.find((m) => m.id === id);
		if (marker) return marker;
		const track = [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].find((t) => t.id === id);
		if (track) return track;
		const cues = (seq as { soundDesign?: { cues?: Record<string, unknown> } }).soundDesign?.cues;
		if (cues && Object.hasOwn(cues, id)) return cues[id];
	}
	return null;
}

/** A fingerprint of an entity's value (sha-256 of its canonical JSON), or null when the document has no such entity. */
export function entityHash(doc: ProjectDocument, id: string): string | null {
	const v = entityValue(doc, id);
	if (v === null || v === undefined) return null;
	try {
		return sha(stableJson(v));
	} catch {
		return sha(String(v));
	}
}

/**
 * The intent of an accept about to run `tx` on `doc` (the document it validated against, at `revision`): a dry run
 * counts the ids the transaction takes, fresh random bodies are chosen for them, and a second dry run with those
 * bodies gives the refs and created ids to expect. Never throws (a dry run that fails leaves the expectations empty;
 * the ids are still journalled).
 */
export function prepareIntent(
	doc: ProjectDocument,
	tx: Record<string, unknown>,
	meta: {
		acceptId: string;
		projectId: string;
		proposalId: string;
		itemIds: readonly string[];
		revision: number;
		via: 'session' | 'headless';
		at: string;
		registries: Registries;
	},
): AcceptIntent {
	const ctx = (ids: IdSource) => ({
		ids,
		now: () => meta.at,
		revision: meta.revision,
		registries: meta.registries,
		checkInvariants: false,
	});
	const live = { ...tx, dryRun: undefined };
	let count = 0;
	try {
		const c = counting(createRandomIdSource());
		dryApply(doc, live, ctx(c));
		count = c.count;
	} catch {
		count = 0;
	}
	const ids = randomIdBodies(ID_SLACK(count));
	let refs: Record<string, string> = {};
	let created: string[] = [];
	let dryRun: AcceptIntent['dryRun'] = 'failed';
	const changes: AcceptIntent['changes'] = [];
	try {
		const r = dryApply(doc, live, ctx(createPresetIdSource(ids, createRandomIdSource())));
		if (r.result.ok) {
			dryRun = 'ok';
			refs = Object.fromEntries(
				Object.entries(r.result.refs).filter(([, v]) => ENTITY_ID.safeParse(v).success),
			);
			created = r.result.created
				.filter((id) => ENTITY_ID.safeParse(id).success)
				.slice(0, PROPOSAL_LIMITS.maxCreated);
			if (created.length === 0)
				for (const id of [...r.result.changed, ...r.result.deleted].slice(0, PROPOSAL_LIMITS.maxCreated))
					changes.push({ id, before: entityHash(doc, id), after: entityHash(r.document, id) });
		}
	} catch {
		// the expectations stay empty: the ids alone tell
	}
	return {
		version: ACCEPT_INTENT_VERSION,
		acceptId: meta.acceptId,
		projectId: meta.projectId,
		proposalId: meta.proposalId,
		itemIds: [...meta.itemIds],
		baseRevision: meta.revision,
		via: meta.via,
		at: meta.at,
		ids,
		dryRun,
		refs,
		created,
		changes,
	};
}

/** Entity ids in `doc` whose body is one of `bodies` (a scan of the document's JSON). */
export function idsWithBodies(doc: ProjectDocument, bodies: readonly string[]): string[] {
	if (bodies.length === 0) return [];
	const want = new Set(bodies);
	let text: string;
	try {
		text = JSON.stringify(doc);
	} catch {
		return [];
	}
	const out = new Set<string>();
	const re = /"([a-z]{2,3})_([0-9A-HJKMNP-TV-Z]{16})"/g;
	for (let m = re.exec(text); m; m = re.exec(text)) if (want.has(m[2]!)) out.add(`${m[1]}_${m[2]}`);
	return [...out];
}

export type IntentEvidence =
	| { applied: true; created: string[]; refs: Record<string, string> }
	| { applied: false; reason: string };

/**
 * Did the accept the intent describes reach `doc`? Its journalled ids in the document say yes (exactly: they are
 * random and were never used before); none of them, when the transaction was to create something, says no. Without
 * created entities the fingerprints of what it changes decide: all as the accept leaves them → yes; otherwise no
 * (accepting again re-applies changes, never duplicates entities). A no-op accept counts as applied.
 */
export function reconcileEvidence(doc: ProjectDocument, intent: AcceptIntent): IntentEvidence {
	const present = idsWithBodies(doc, intent.ids);
	if (present.length) {
		const top = new Set(present.filter((id) => anchorFingerprint(doc, id) !== null));
		const refs = Object.fromEntries(Object.entries(intent.refs).filter(([, id]) => present.includes(id)));
		const created = [
			...intent.created.filter((id) => top.has(id)),
			...[...top].filter((id) => !intent.created.includes(id)),
		];
		return { applied: true, created: created.slice(0, PROPOSAL_LIMITS.maxCreated), refs };
	}
	if (intent.dryRun === 'failed')
		return { applied: false, reason: 'it did not apply to the document it was validated on' };
	if (intent.created.length)
		return { applied: false, reason: 'none of the entities it creates is in the document' };
	if (intent.changes.length === 0) return { applied: true, created: [], refs: {} };
	const now = intent.changes.map((c) => entityHash(doc, c.id));
	if (intent.changes.every((c, i) => now[i] === c.after && c.after !== c.before))
		return { applied: true, created: [], refs: {} };
	return { applied: false, reason: 'what it changes is not as the accept leaves it' };
}

/** The accept's transaction result is ambiguous: it may have applied (a relay that lost the session's answer). */
export function ambiguousResult(result: TransactionResult): boolean {
	if (result.ok) return false;
	const e = result.errors[0];
	return (
		(e?.code === 'E_NO_SESSION' && (e as { retryable?: boolean }).retryable === true) ||
		(e?.code === 'E_INTERNAL' && /invalid result/.test(e.message ?? ''))
	);
}
