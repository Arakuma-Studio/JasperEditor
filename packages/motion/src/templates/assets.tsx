// Template assets in the drawing (social-comment design §7.8): emoji drawn as images of a pack (`EmojiImage`, which
// holds the render until the image is decoded), a visible marker where a font or emoji is not available
// (`MissingAssetMarker`), and how a missing asset is reported to the editor (a panel warning) and retried.
//
// Failure is never silent (AGENTS §4): in the Player a missing asset shows the marker and is reported; in a render
// (export, bake, still) it fails the render — the export planner blocks such exports before they start, so this only
// fires when a file disappears or breaks between planning and rendering.
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { getRemotionEnvironment, useDelayRender } from 'remotion';

/** An asset a template could not draw. */
export type MissingTemplateAsset =
	| { kind: 'font'; family: string; weight: number; style: 'normal' | 'italic' }
	| { kind: 'emoji'; pack: string; grapheme: string };

/** Human label of a missing asset (`Font "Chirp" 700`, `Emoji 😀 (apple)`). */
export function missingAssetLabel(a: MissingTemplateAsset): string {
	return a.kind === 'font'
		? `Font "${a.family}" ${a.weight}${a.style === 'italic' ? ' italic' : ''}`
		: `Emoji ${a.grapheme} (${a.pack})`;
}

/**
 * Receives the missing assets of a template clip (`[]` = none any more). Provided by the editor's Program monitor
 * around the Player; absent elsewhere (renders, gallery posters).
 */
export type MissingAssetReporter = (clipId: string, assets: readonly MissingTemplateAsset[]) => void;
export const MissingAssetReporterContext = createContext<MissingAssetReporter | null>(null);

/** Collects the missing assets reported inside one template clip (set up by the motion-graphic layer). */
type ClipAssetScope = { report(id: string, asset: MissingTemplateAsset | null): void };
export const TemplateAssetScopeContext = createContext<ClipAssetScope | null>(null);

// ── retry ────────────────────────────────────────────────────────────────────────────────────────────────────────

let epoch = 0;
const listeners = new Set<() => void>();
const retryHooks = new Set<() => void>();

/** Bumped by `retryTemplateAssets`: failed fonts and emoji are loaded again. */
export function useTemplateAssetEpoch(): number {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => epoch,
		() => epoch,
	);
}

/** Registers what to forget on a retry (the font loader's failed faces); returns the unregister function. */
export function onTemplateAssetRetry(hook: () => void): () => void {
	retryHooks.add(hook);
	return () => retryHooks.delete(hook);
}

/** Loads every failed template font and emoji image again (after the engine downloaded them). */
export function retryTemplateAssets(): void {
	for (const h of retryHooks) h();
	epoch++;
	for (const l of listeners) l();
}

// ── marker ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STRIPES = 'repeating-linear-gradient(135deg, #ffd400 0 6px, #1a1a1a 6px 12px)';

/**
 * A visible "not available" mark. `emoji`: a dashed square of the emoji's size with a "?" (inline, keeps the text
 * layout); `font`: a striped banner naming the font, placed by its parent (the layer draws it over the card).
 */
export function MissingAssetMarker(p: {
	kind: 'font' | 'emoji';
	label: string;
	/** Emoji: the square's side in pixels; font: the banner's text size. */
	size?: number;
	style?: CSSProperties;
}): ReactNode {
	if (p.kind === 'emoji') {
		const s = Math.max(1, p.size ?? 16);
		return (
			<span
				data-missing-asset="emoji"
				title={`${p.label} is not available`}
				role="img"
				aria-label={`${p.label} is not available`}
				style={{
					display: 'inline-flex',
					alignItems: 'center',
					justifyContent: 'center',
					width: s,
					height: s,
					boxSizing: 'border-box',
					verticalAlign: 'middle',
					border: `${Math.max(1, Math.round(s / 12))}px dashed #ff3b30`,
					borderRadius: Math.round(s / 6),
					background: 'rgba(255, 59, 48, 0.12)',
					color: '#ff3b30',
					fontFamily: 'sans-serif',
					fontWeight: 700,
					fontSize: Math.round(s * 0.6),
					lineHeight: 1,
					...p.style,
				}}
			>
				?
			</span>
		);
	}
	const fs = Math.max(10, p.size ?? 16);
	return (
		<div
			data-missing-asset="font"
			role="alert"
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: fs / 2,
				padding: `${fs / 3}px ${fs / 1.5}px`,
				borderRadius: fs / 3,
				background: '#1a1a1a',
				border: `${Math.max(2, fs / 6)}px solid transparent`,
				borderImage: `${STRIPES} 1`,
				color: '#ffd400',
				fontFamily: 'sans-serif',
				fontWeight: 700,
				fontSize: fs,
				lineHeight: 1.2,
				whiteSpace: 'nowrap',
				pointerEvents: 'none',
				...p.style,
			}}
		>
			{p.label}
		</div>
	);
}

// ── emoji image ──────────────────────────────────────────────────────────────────────────────────────────────────

let reportIds = 0;

/** Reports `asset` to the clip's scope while it is non-null. */
function useReportMissing(asset: MissingTemplateAsset | null): void {
	const scope = useContext(TemplateAssetScopeContext);
	const [id] = useState(() => `a${++reportIds}`);
	const key = asset ? JSON.stringify(asset) : '';
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `asset`
	useEffect(() => {
		if (!scope) return;
		scope.report(id, asset);
		return () => scope.report(id, null);
	}, [scope, id, key]);
}

/**
 * An emoji grapheme drawn as an image of its pack. The render waits until the image is decoded (one `delayRender`
 * handle per image, created in a layout effect). `url` absent or failing: the Player shows `MissingAssetMarker`
 * (reported to the editor); a render fails with the reason.
 */
export function EmojiImage(p: {
	url: string | null | undefined;
	size: number;
	/** The grapheme (alt text and marker label). */
	alt: string;
	/** Pack id, for the report. */
	pack?: string;
	style?: CSSProperties;
}): ReactNode {
	const retry = useTemplateAssetEpoch();
	const { delayRender, continueRender, cancelRender } = useDelayRender();
	const ref = useRef<HTMLImageElement>(null);
	const id = `${p.url ?? ''}#${retry}`;
	const [failed, setFailed] = useState<string | null>(null);
	const missing = !p.url || failed === id;
	useReportMissing(missing ? { kind: 'emoji', pack: p.pack ?? '', grapheme: p.alt } : null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `id` stands for the url and the retry epoch
	useLayoutEffect(() => {
		if (!p.url) {
			if (getRemotionEnvironment().isRendering)
				cancelRender(new Error(`Emoji ${p.alt} (${p.pack ?? 'emoji'} pack) is not available`));
			return;
		}
		const img = ref.current;
		if (!img) return;
		const handle = delayRender(`Loading emoji ${p.alt}`);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			continueRender(handle);
		};
		const ok = () => {
			img.decode().then(finish, finish);
		};
		const fail = () => {
			if (getRemotionEnvironment().isRendering) {
				cancelRender(new Error(`Emoji ${p.alt} could not be loaded from ${p.url}`));
				return;
			}
			setFailed(id);
			finish();
		};
		img.addEventListener('load', ok);
		img.addEventListener('error', fail);
		if (img.complete) {
			if (img.naturalWidth > 0) ok();
			else fail();
		}
		return () => {
			img.removeEventListener('load', ok);
			img.removeEventListener('error', fail);
			finish();
		};
	}, [id]);
	if (missing) return <MissingAssetMarker kind="emoji" label={p.alt} size={p.size} style={p.style} />;
	return (
		<img
			ref={ref}
			// remount on retry: a fresh request after the engine downloaded the file
			key={id}
			src={p.url ?? undefined}
			alt={p.alt}
			width={p.size}
			height={p.size}
			draggable={false}
			data-emoji={p.alt}
			style={{
				display: 'inline-block',
				width: p.size,
				height: p.size,
				objectFit: 'contain',
				verticalAlign: 'middle',
				...p.style,
			}}
		/>
	);
}
