// social-comment §7.8: the Program monitor's warning about template fonts and emoji that are not available. Sources:
// - the engine: the sequence's declared assets are prefetched (downloaded when Settings ▸ Privacy & Network allows it)
//   as soon as the document needs them, so every clip is covered, not only the ones under the playhead;
// - the snapshot: faces / emoji that resolve nowhere (not bundled, not in the manifest);
// - the Player: template layers report what failed to load (MissingAssetReporterContext).
// "Retry download" asks the engine again and reloads failed fonts and images; the chip never blocks editing.
import type { RemoteAssetMissing, RemoteAssetPrefetchResponse } from '@jasper/api';
import {
	type MissingAssetReporter,
	type MissingTemplateAsset,
	missingAssetLabel,
	type RenderDoc,
	retryTemplateAssets,
} from '@jasper/compositions';
import type { EngineClient } from '@jasper/engine-client';
import type { RenderTemplateAssets } from '@jasper/project';
import { Button, Icon, openDialog, toast } from '@jasper/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PREFERENCES_DIALOG } from '../shell/preferences/index.ts';
import { PRIVACY_NETWORK_PAGE } from './ids.ts';

const ASSET_REASONS = {
	unresolved: 'Not bundled and not in the remote-asset manifest',
};
const MAX_DEPTH = 8;
const PREFETCH_DEBOUNCE_MS = 400;

/** Every template asset a document's clips declare (nested sequences included), with the clips that draw it. */
export function declaredAssets(doc: RenderDoc | null): {
	fonts: RenderTemplateAssets['fonts'];
	emoji: { pack: string; graphemes: string[] }[];
	clips: Map<string, Set<string>>;
	names: Map<string, string>;
} {
	const fonts = new Map<string, RenderTemplateAssets['fonts'][number]>();
	const emoji = new Map<string, Set<string>>();
	const clips = new Map<string, Set<string>>();
	const names = new Map<string, string>();
	const use = (key: string, clipId: string) => {
		const set = clips.get(key) ?? new Set<string>();
		set.add(clipId);
		clips.set(key, set);
	};
	const walk = (d: RenderDoc, depth: number) => {
		if (depth > MAX_DEPTH) return;
		for (const t of d.videoTracks)
			for (const c of t.clips) {
				names.set(c.clipId, c.name);
				if ('nest' in c.source) walk(c.source.nest.snapshot, depth + 1);
				const assets = 'mg' in c.source ? c.source.mg.assets : undefined;
				if (!assets) continue;
				for (const f of assets.fonts) {
					const k = assetKey({ kind: 'font', ...f });
					fonts.set(k, f);
					use(k, c.clipId);
				}
				for (const { pack, graphemes } of assets.emoji) {
					const set = emoji.get(pack) ?? new Set<string>();
					for (const g of graphemes) {
						set.add(g);
						use(assetKey({ kind: 'emoji', pack, grapheme: g }), c.clipId);
					}
					emoji.set(pack, set);
				}
			}
	};
	if (doc) walk(doc, 0);
	return {
		fonts: [...fonts.values()],
		emoji: [...emoji].map(([pack, set]) => ({ pack, graphemes: [...set] })),
		clips,
		names,
	};
}

/** Identity of an asset (JSON of its normalised fields; `parseKey` reads it back). */
export function assetKey(a: MissingTemplateAsset): string {
	return a.kind === 'font'
		? JSON.stringify(['font', a.family, a.weight, a.style])
		: JSON.stringify(['emoji', a.pack, a.grapheme]);
}

function fromMissing(m: RemoteAssetMissing): MissingTemplateAsset {
	return m.kind === 'font'
		? { kind: 'font', family: m.family, weight: m.weight, style: m.style }
		: { kind: 'emoji', pack: m.pack, grapheme: m.grapheme };
}

/** What template layers in the Player could not draw, by clip (the reporter is stable). */
export function useLayerAssetReports(): {
	reporter: MissingAssetReporter;
	reported: ReadonlyMap<string, readonly MissingTemplateAsset[]>;
} {
	const [reported, setReported] = useState<ReadonlyMap<string, readonly MissingTemplateAsset[]>>(new Map());
	const reporter = useCallback<MissingAssetReporter>((clipId, assets) => {
		setReported((prev) => {
			const had = prev.get(clipId);
			if ((!had || had.length === 0) && assets.length === 0) return prev;
			const next = new Map(prev);
			if (assets.length) next.set(clipId, assets);
			else next.delete(clipId);
			return next;
		});
	}, []);
	return { reporter, reported };
}

type EngineIssue = { asset: MissingTemplateAsset; reason: string; code: string };

/**
 * Prefetches the document's declared assets (debounced; again when `epoch` changes) and returns what the engine
 * could not make available, with why.
 */
export function useTemplateAssetPrefetch(
	client: EngineClient | null,
	doc: RenderDoc | null,
	epoch: number,
): { issues: readonly EngineIssue[]; retry(): Promise<RemoteAssetPrefetchResponse | null> } {
	const declared = useMemo(() => declaredAssets(doc), [doc]);
	const request = useMemo(
		() => ({
			fonts: declared.fonts.slice(0, 64),
			emoji: declared.emoji.slice(0, 8).map((e) => ({ ...e, graphemes: e.graphemes.slice(0, 512) })),
		}),
		[declared],
	);
	const key = JSON.stringify(request);
	const [issues, setIssues] = useState<readonly EngineIssue[]>([]);
	const latest = useRef(0);
	const run = useCallback(async (): Promise<RemoteAssetPrefetchResponse | null> => {
		const req = JSON.parse(key) as typeof request;
		if (!client || (req.fonts.length === 0 && req.emoji.length === 0)) {
			setIssues([]);
			return null;
		}
		const n = ++latest.current;
		try {
			const r = await client.call('remoteAssetsPrefetch', { body: req });
			if (n !== latest.current) return r;
			setIssues(
				r.missing.map((m) => ({ asset: fromMissing(m), reason: m.error.message, code: m.error.code })),
			);
			return r;
		} catch {
			// engine unreachable: the Player's own reports still show what is missing
			if (n === latest.current) setIssues([]);
			return null;
		}
	}, [client, key]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `epoch` re-runs the prefetch (settings / manifest changed)
	useEffect(() => {
		const t = setTimeout(() => void run(), PREFETCH_DEBOUNCE_MS);
		return () => clearTimeout(t);
	}, [run, epoch]);
	return { issues, retry: run };
}

type Row = { key: string; asset: MissingTemplateAsset; reason: string | null; clipIds: string[] };

/** The chip and its list (bottom-left of the Program viewport); nothing when every asset is available. */
export function TemplateAssetWarning(props: {
	doc: RenderDoc | null;
	reported: ReadonlyMap<string, readonly MissingTemplateAsset[]>;
	engine: { issues: readonly EngineIssue[]; retry(): Promise<RemoteAssetPrefetchResponse | null> };
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const declared = useMemo(() => declaredAssets(props.doc), [props.doc]);
	const rows = useMemo(() => {
		const out = new Map<string, Row>();
		const add = (asset: MissingTemplateAsset, reason: string | null, clipIds: Iterable<string>) => {
			const key = assetKey(asset);
			const row = out.get(key) ?? { key, asset, reason: null, clipIds: [] };
			if (reason && !row.reason) row.reason = reason;
			for (const id of clipIds) if (!row.clipIds.includes(id)) row.clipIds.push(id);
			out.set(key, row);
		};
		for (const i of props.engine.issues) add(i.asset, i.reason, declared.clips.get(assetKey(i.asset)) ?? []);
		for (const [clipId, assets] of props.reported) for (const a of assets) add(a, null, [clipId]);
		for (const w of props.doc?.warnings ?? [])
			if (w.code === 'TEMPLATE_FONT_UNAVAILABLE' || w.code === 'TEMPLATE_EMOJI_UNAVAILABLE')
				for (const [key, ids] of declared.clips)
					if (ids.has(w.clipId) && !out.has(key) && unresolved(props.doc, key))
						add(parseKey(key), ASSET_REASONS.unresolved, [w.clipId]);
		return [...out.values()];
	}, [props.engine.issues, props.reported, props.doc, declared]);
	if (rows.length === 0) return null;
	const retry = async () => {
		setBusy(true);
		try {
			const r = await props.engine.retry();
			retryTemplateAssets();
			if (r && r.missing.length > 0)
				toast({
					kind: 'warning',
					title: 'Some template fonts or emoji are still not available',
					detail: r.missing
						.slice(0, 6)
						.map((m) => `${missingAssetLabel(fromMissing(m))}: ${m.error.message}`)
						.join('\n'),
					dedupeKey: 'template-assets-retry',
				});
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="absolute bottom-2 left-2 z-10 flex max-w-[60%] flex-col items-start gap-1"
			data-testid="program-template-assets"
		>
			{open ? (
				<div
					className="max-h-64 w-full min-w-[280px] overflow-auto rounded-pr-control border border-pr-border-strong bg-pr-raised p-2 text-pr-small text-pr-text shadow-pr-overlay"
					role="dialog"
					aria-label="Template fonts and emoji not available"
				>
					<p className="mb-1 text-pr-muted">
						The marked cards are drawn without these. Exports are blocked until they are available.
					</p>
					<ul className="flex flex-col gap-1" data-testid="program-template-assets-list">
						{rows.map((r) => (
							<li key={r.key} className="flex flex-col">
								<span className="font-semibold text-pr-strong">{missingAssetLabel(r.asset)}</span>
								<span className="text-pr-muted">
									{r.clipIds.map((id) => declared.names.get(id) ?? id).join(', ')}
									{r.reason ? ` — ${r.reason}` : ''}
								</span>
							</li>
						))}
					</ul>
					<div className="mt-2 flex gap-2">
						<Button
							variant="primary"
							busy={busy}
							onClick={() => void retry()}
							data-testid="program-template-assets-retry"
						>
							Retry download
						</Button>
						<Button
							variant="secondary"
							onClick={() => void openDialog(PREFERENCES_DIALOG, { page: PRIVACY_NETWORK_PAGE })}
						>
							Privacy & Network…
						</Button>
					</div>
				</div>
			) : null}
			<button
				type="button"
				className="flex items-center gap-1 rounded-pr-control bg-pr-raised px-1.5 py-0.5 text-pr-small text-pr-warning"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="Template fonts or emoji are not available"
				data-testid="program-template-assets-chip"
			>
				<Icon id="status.warning" size={12} />
				{rows.length === 1
					? '1 template asset not available'
					: `${rows.length} template assets not available`}
			</button>
		</div>
	);
}

/** A declared asset the snapshot could not resolve (not in the document's fonts / emoji table). */
function unresolved(doc: RenderDoc | null, key: string): boolean {
	const a = parseKey(key);
	if (a.kind === 'emoji') return !doc?.emoji?.[`${a.pack}:${a.grapheme}`];
	return !doc?.fonts.some(
		(f) => f.fontId === `template:${a.family}` && f.weight === a.weight && f.style === a.style,
	);
}

function parseKey(key: string): MissingTemplateAsset {
	const [kind, a, b, c] = JSON.parse(key) as [string, string, string | number, string?];
	return kind === 'font'
		? { kind: 'font', family: a, weight: Number(b), style: c === 'italic' ? 'italic' : 'normal' }
		: { kind: 'emoji', pack: a, grapheme: String(b) };
}
