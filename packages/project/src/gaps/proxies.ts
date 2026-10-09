// Proxies (workstream gaps, docs/wp-notes/gaps.md §PRJ-8): Premiere's Clip ▸ Proxy ▸ Create Proxies / Attach Proxies /
// Reconnect Full Resolution Media, Toggle Proxies and ingest-time proxies. The proxy is a smaller, browser-decodable
// file attached to a video asset (`MediaAsset.proxy`); monitors play it while Toggle Proxies is on, exports use the
// original unless `draftUseProxies` asks for the proxies. A proxy must have the original's duration (± 1 frame) and
// frame rate (FilmCraft's rule and Premiere's documented requirement); its frame size may differ.
import { AttachedProxySchema, type MediaAsset, type MediaProbe } from '../schema/media.ts';
import type { Rational } from '../time.ts';
import { registerGapsCheck } from './settings.ts';

export type ProxyPreset = {
	id: string;
	label: string;
	/** Largest frame size of the proxy (the source is scaled down to fit, aspect kept; never up). */
	maxWidth: number;
	maxHeight: number;
	/** `proxy`: Create Proxies / ingest proxies; `transcode`: ingest Transcode (full size, mastering codec). */
	kind: 'proxy' | 'transcode';
	/** Codec family (`auto` = the engine's browser-playable proxy encoder: H.264, else VP9 / AV1). */
	codec: 'auto' | 'prores-422' | 'prores-422-hq';
};

/**
 * Create Proxies presets. Premiere's ingest presets are named by size (1024×540, 1280×720, 2048×1080); ours keep the
 * source aspect within those boxes and use the engine's browser-decodable encoder so the Program monitor plays them
 * directly (a ProRes proxy would need yet another proxy to play in a browser).
 */
export const PROXY_PRESETS: readonly ProxyPreset[] = [
	{
		id: 'proxy-540',
		label: 'Low Resolution Proxy (≤ 960×540)',
		maxWidth: 960,
		maxHeight: 540,
		kind: 'proxy',
		codec: 'auto',
	},
	{
		id: 'proxy-720',
		label: 'Proxy (≤ 1280×720)',
		maxWidth: 1280,
		maxHeight: 720,
		kind: 'proxy',
		codec: 'auto',
	},
	{
		id: 'proxy-1080',
		label: 'High Resolution Proxy (≤ 1920×1080)',
		maxWidth: 1920,
		maxHeight: 1080,
		kind: 'proxy',
		codec: 'auto',
	},
	{
		id: 'transcode-prores-422',
		label: 'Transcode: ProRes 422 HQ (full size)',
		maxWidth: 16384,
		maxHeight: 16384,
		kind: 'transcode',
		codec: 'prores-422-hq',
	},
	{
		id: 'transcode-full',
		label: 'Transcode: browser-playable (full size)',
		maxWidth: 16384,
		maxHeight: 16384,
		kind: 'transcode',
		codec: 'auto',
	},
];
export const DEFAULT_PROXY_PRESET = 'proxy-720';
export const DEFAULT_TRANSCODE_PRESET = 'transcode-prores-422';

export function proxyPreset(id: string | null | undefined): ProxyPreset | undefined {
	return PROXY_PRESETS.find((p) => p.id === id);
}

/** Frame size of a proxy of a `w`×`h` source with `preset` (even numbers, aspect kept, never larger). */
export function proxySize(
	w: number,
	h: number,
	preset: Pick<ProxyPreset, 'maxWidth' | 'maxHeight'>,
): { width: number; height: number } {
	if (!(w > 0 && h > 0)) return { width: 2, height: 2 };
	const k = Math.min(1, preset.maxWidth / w, preset.maxHeight / h);
	const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
	return { width: even(w * k), height: even(h * k) };
}

const videoOf = (p: MediaProbe) => p.streams.find((s) => s.type === 'video');
const rateOf = (r: Rational) => (r.den > 0 ? r.num / r.den : Number.NaN);

/**
 * Why `probe` cannot be the proxy of `original` (null = it can): no video, another frame rate, another rotation, or a
 * duration more than one frame away.
 */
export function proxyMismatch(
	original: Pick<MediaAsset, 'kind' | 'probe' | 'originalName'>,
	probe: MediaProbe,
): string | null {
	if (original.kind !== 'video')
		return `${original.originalName} is not a video: only video media takes proxies`;
	const ov = videoOf(original.probe);
	const pv = videoOf(probe);
	if (ov?.type !== 'video') return `${original.originalName} has no video stream`;
	if (pv?.type !== 'video') return 'The proxy has no video';
	const ofps = rateOf(ov.frameRate);
	const pfps = rateOf(pv.frameRate);
	if (!(Math.abs(ofps - pfps) < 0.01))
		return `The proxy runs at ${pfps.toFixed(3)} fps but ${original.originalName} at ${ofps.toFixed(3)} fps`;
	const od = original.probe.durationFlicks;
	const pd = probe.durationFlicks;
	if (od !== null && pd !== null && ofps > 0) {
		const frame = 705_600_000 / ofps;
		if (Math.abs(od - pd) > frame + 1)
			return `The proxy is ${(pd / 705_600_000).toFixed(3)} s long but ${original.originalName} is ${(od / 705_600_000).toFixed(3)} s`;
	}
	const sideways = (deg: number) => deg === 90 || deg === 270;
	const ow = sideways(original.probe.rotationDegrees) ? ov.height : ov.width;
	const oh = sideways(original.probe.rotationDegrees) ? ov.width : ov.height;
	const pw = sideways(probe.rotationDegrees) ? pv.height : pv.width;
	const ph = sideways(probe.rotationDegrees) ? pv.width : pv.height;
	// Displayed orientation must agree (a portrait proxy of a landscape clip is a different picture).
	if (ow > oh !== pw > ph && Math.abs(ow / oh - pw / ph) > 0.05)
		return 'The proxy is turned differently from the original (portrait / landscape)';
	return null;
}

/** The media key of the attached proxy (its engine-store locator), or null. */
export function proxyKeyOf(asset: Pick<MediaAsset, 'proxy'> | null | undefined): string | null {
	const l = asset?.proxy?.locators.find((x) => x.type === 'engine-store');
	return l && l.type === 'engine-store' ? l.key : null;
}

registerGapsCheck({
	issues(doc) {
		const out: { invariant: string; message: string; path: string[] }[] = [];
		for (const a of Object.values(doc.media)) {
			const p = (a as { proxy?: unknown }).proxy;
			if (p === undefined) continue;
			if (!AttachedProxySchema.safeParse(p).success)
				out.push({
					invariant: 'INV-PROXY',
					message: `media ${a.id}: unreadable proxy`,
					path: ['media', a.id, 'proxy'],
				});
			else if (a.kind !== 'video')
				out.push({
					invariant: 'INV-PROXY',
					message: `media ${a.id}: only video media takes proxies`,
					path: ['media', a.id, 'proxy'],
				});
		}
		return out;
	},
	repair(doc, note) {
		for (const a of Object.values(doc.media)) {
			const r = a as { proxy?: unknown };
			if (r.proxy === undefined) continue;
			if (!AttachedProxySchema.safeParse(r.proxy).success || a.kind !== 'video') {
				delete r.proxy;
				note('detach-proxy', a.id, 'unreadable proxy detached (the original media is kept)');
			}
		}
	},
});

/** What the engine registered for an output file (structural subset of the API's RegisteredMedia). */
export type RegisteredFile = {
	fingerprint: string;
	originalName: string;
	sizeBytes: number;
	container: string;
	probe: MediaProbe;
	locators: MediaAsset['locators'];
};

/** The `MediaAsset.proxy` record of a registered file. */
export function attachedProxyFrom(
	reg: RegisteredFile,
	origin: 'created' | 'attached' | 'ingest',
	preset?: string | null,
) {
	return {
		fingerprint: reg.fingerprint,
		originalName: reg.originalName,
		sizeBytes: reg.sizeBytes,
		container: reg.container,
		probe: reg.probe,
		locators: reg.locators,
		origin,
		...(preset ? { preset } : {}),
	};
}

/**
 * The commands that apply a finished `proxy-create` job (Create Proxies / ingest) to a document: `media.attachProxy`
 * per proxy, `media.relink` to an ingested copy (same bytes, the copy's path), or a Replace-Footage `media.relink` to
 * a transcode. Media no longer in the project and proxies that do not fit are reported in `skipped`.
 */
export function mediaJobCommands(
	doc: { media: Record<string, MediaAsset> },
	result: {
		op: 'proxy' | 'transcode' | 'copy';
		preset: string | null;
		outputs: { mediaId: string; path: string; registered: unknown }[];
	},
	origin: 'created' | 'ingest',
): { commands: unknown[]; skipped: string[] } {
	const commands: unknown[] = [];
	const skipped: string[] = [];
	for (const o of result.outputs) {
		const asset = doc.media[o.mediaId];
		const reg = o.registered as RegisteredFile;
		if (!asset) {
			skipped.push(`${reg?.originalName ?? o.path}: the media is no longer in the project`);
			continue;
		}
		if (result.op === 'proxy') {
			const why = proxyMismatch(asset, reg.probe);
			if (why) {
				skipped.push(`${asset.originalName}: ${why}`);
				continue;
			}
			commands.push({
				type: 'media.attachProxy',
				mediaId: asset.id,
				proxy: attachedProxyFrom(reg, origin, result.preset),
			});
		} else if (result.op === 'copy') {
			commands.push({
				type: 'media.relink',
				mediaId: asset.id,
				locator: { type: 'path', path: o.path, relativeToProject: null },
			});
		} else {
			commands.push({
				type: 'media.relink',
				mediaId: asset.id,
				replace: true,
				locator: reg.locators[0],
				locators: reg.locators,
				fingerprint: reg.fingerprint,
				probe: reg.probe,
				sizeBytes: reg.sizeBytes,
				originalName: reg.originalName,
				container: reg.container,
			});
		}
	}
	return { commands, skipped };
}
