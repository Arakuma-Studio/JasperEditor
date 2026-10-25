// Pictures inside anime templates (avatars, docs/wp-notes/social-comments.md "Template media params"). A template
// media param resolves to `AnimeTemplateProps.mediaUrls[mediaId]` (the render snapshot's media handle: an engine URL,
// signed in renders); `TemplateImage` draws it and holds the Remotion render until the picture is decoded, like
// Remotion's `<Img>` and the fx images of @jasper/compositions (`fx/images.ts`). A failed load is never silent
// (AGENTS §4): a render (export, bake, still) fails with a `TemplateImageError` naming the picture; the Player draws a
// visible placeholder (or the template's own `fallback`) and reports the medium to the editor's template-asset warning.
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import { useReportMissing } from './assets.tsx';

export type TemplateImageProps = {
	/** The picture's URL (`mediaUrls[mediaId]`); empty / absent = no picture (the fallback is drawn). */
	src: string | null | undefined;
	alt?: string;
	/** Inline style of the picture, also given to the default placeholder (size, radius, object-fit…). */
	style?: CSSProperties;
	/** Drawn when there is no picture or it failed to load (default: a visible neutral placeholder). */
	fallback?: ReactNode;
	'data-testid'?: string;
};

type Status = 'loading' | 'ready' | 'error';

/** What a render fails with when a template picture cannot be loaded (renders never draw the placeholder). */
export class TemplateImageError extends Error {
	override name = 'TemplateImageError';
	constructor(
		readonly url: string,
		readonly mediaId: string | null,
	) {
		// signed URLs: the query (the signature) stays out of the message
		super(
			`Template picture ${mediaId ?? ''}${mediaId ? ' ' : ''}could not be loaded from ${url.split('?')[0]}`,
		);
	}
}

/**
 * URL → media id of the pictures a template clip shows (`mediaUrls` inverted; provided by the motion-graphic layer):
 * a failed picture is reported and named by its medium.
 */
export const TemplateMediaIdsContext = createContext<Readonly<Record<string, string>> | null>(null);

/** The visible stand-in of a missing / unreadable picture (a neutral dashed box, never transparent). */
export function TemplateImagePlaceholder({ style }: { style?: CSSProperties }) {
	return (
		<div
			data-template-image="placeholder"
			aria-hidden="true"
			style={{
				boxSizing: 'border-box',
				background: 'rgba(128, 128, 128, 0.45)',
				border: '2px dashed rgba(255, 255, 255, 0.7)',
				...style,
			}}
		/>
	);
}

/**
 * An `<img>` that holds the render (delayRender) from its first frame until the picture is loaded and decoded.
 * On a load error a render fails (`cancelRender` with a `TemplateImageError`); the Player releases its hold, draws
 * the placeholder (or `fallback`) and reports the medium (`{kind: 'media'}`) to the clip's asset scope.
 */
export function TemplateImage(props: TemplateImageProps) {
	const url = typeof props.src === 'string' && props.src !== '' ? props.src : null;
	const [state, setState] = useState<{ url: string | null; status: Status }>(() => ({
		url,
		status: url ? 'loading' : 'error',
	}));
	// A new URL starts loading again (the element is keyed by it).
	const status: Status = state.url === url ? state.status : url ? 'loading' : 'error';
	const mediaIds = useContext(TemplateMediaIdsContext);
	const mediaId = (url && mediaIds?.[url]) || null;
	const failed = !!url && status === 'error';
	useReportMissing(failed && mediaId ? { kind: 'media', mediaId } : null);
	useLayoutEffect(() => {
		if (failed && url && getRemotionEnvironment().isRendering)
			cancelRender(new TemplateImageError(url, mediaId));
	}, [failed, url, mediaId]);
	// Hold the render while the picture loads: the handle is taken at the first render of this URL (like
	// `useFxImages`) and released once the result is on screen (the effect's cleanup runs after that commit).
	const [initial] = useState(() =>
		url ? { url, handle: delayRender(`Loading template image ${url}`) } : null,
	);
	useLayoutEffect(() => {
		if (status !== 'loading' || !url) {
			if (initial && initial.url === url) continueRenderOnce(initial.handle);
			return;
		}
		const handle =
			initial && initial.url === url && !released.has(initial.handle)
				? initial.handle
				: delayRender(`Loading template image ${url}`);
		return () => continueRenderOnce(handle);
	}, [status, url, initial]);
	if (!url || status === 'error')
		return <>{props.fallback ?? <TemplateImagePlaceholder style={props.style} />}</>;
	const done = (s: Status) =>
		setState((cur) => (cur.url === url && cur.status === s ? cur : { url, status: s }));
	return (
		<img
			key={url}
			src={url}
			alt={props.alt ?? ''}
			crossOrigin="anonymous"
			draggable={false}
			data-template-image={status}
			data-testid={props['data-testid']}
			style={{ display: 'block', ...props.style }}
			onLoad={(e) => {
				const img = e.currentTarget;
				void (typeof img.decode === 'function' ? img.decode() : Promise.resolve())
					.catch(() => undefined)
					.then(() => done('ready'));
			}}
			onError={() => done('error')}
		/>
	);
}

/** Handles released already (a handle is continued once, whichever path releases it first). */
const released = new Set<number>();
function continueRenderOnce(handle: number): void {
	if (released.has(handle)) return;
	released.add(handle);
	if (released.size > 4096) released.delete(released.values().next().value!);
	continueRender(handle);
}
