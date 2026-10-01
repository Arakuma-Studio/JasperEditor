// Gallery thumbnail with an animated hover preview (ARCHITECTURE §20.6, S11:TXA-020, ATP-007): a static poster
// rendered with Remotion's <Thumbnail> at `posterFrame`, and — 200 ms after the pointer rests on it — a looping
// <Player>. One Player is shared by the whole app: hovering another card moves it there. Touch input and
// `prefers-reduced-motion: reduce` keep the poster only.
import { Player, Thumbnail } from '@remotion/player';
import { type ComponentType, useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react';

export type PreviewThumbProps<P extends Record<string, unknown>> = {
	component: ComponentType<P>;
	inputProps: P;
	durationInFrames: number;
	fps: number;
	/** Composition size; the thumb fills its container's width at this aspect ratio. */
	width: number;
	height: number;
	posterFrame: number;
	/** Accessible name of the preview. */
	label?: string;
	className?: string;
};

/** Delay before the hover preview starts. */
export const HOVER_PREVIEW_DELAY_MS = 200;

// ---------------------------------------------------------------- the shared hover Player

let activeId: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
function setActive(id: string | null): void {
	if (activeId === id) return;
	activeId = id;
	for (const l of listeners) l();
}
/** Id of the thumb showing the hover Player (tests, diagnostics). */
export function activePreviewId(): string | null {
	return activeId;
}

function reducedMotion(): boolean {
	try {
		return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	} catch {
		return false;
	}
}

export function PreviewThumb<P extends Record<string, unknown>>(props: PreviewThumbProps<P>) {
	const id = useId();
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const active = useSyncExternalStore(
		subscribe,
		() => activeId === id,
		() => false,
	);
	const cancel = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	// Unmounting the previewing thumb frees the shared Player.
	useEffect(
		() => () => {
			cancel();
			if (activeId === id) setActive(null);
		},
		[cancel, id],
	);
	const component = props.component as unknown as ComponentType<Record<string, unknown>>;
	const common = {
		component,
		inputProps: props.inputProps as Record<string, unknown>,
		durationInFrames: Math.max(1, Math.round(props.durationInFrames)),
		fps: props.fps,
		compositionWidth: props.width,
		compositionHeight: props.height,
		style: { width: '100%', height: '100%' },
	};
	return (
		<div
			className={props.className}
			role="img"
			aria-label={props.label}
			data-preview-thumb={active ? 'playing' : 'poster'}
			style={{ position: 'relative', width: '100%', aspectRatio: `${props.width} / ${props.height}` }}
			onPointerEnter={(e) => {
				if (e.pointerType === 'touch' || reducedMotion()) return;
				cancel();
				timer.current = setTimeout(() => {
					timer.current = null;
					setActive(id);
				}, HOVER_PREVIEW_DELAY_MS);
			}}
			onPointerLeave={() => {
				cancel();
				if (activeId === id) setActive(null);
			}}
		>
			{active ? (
				<Player
					{...common}
					autoPlay
					loop
					controls={false}
					clickToPlay={false}
					doubleClickToFullscreen={false}
					spaceKeyToPlayOrPause={false}
					acknowledgeRemotionLicense
				/>
			) : (
				<Thumbnail
					{...common}
					frameToDisplay={Math.min(Math.max(0, props.posterFrame), common.durationInFrames - 1)}
				/>
			)}
		</div>
	);
}
