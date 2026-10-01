// PreviewThumb (ARCHITECTURE §20.6): poster through <Thumbnail>, one shared hover <Player> after 200 ms,
// touch / reduced motion → poster only.
import { act, fireEvent, render } from '@testing-library/react';
import { useCurrentFrame } from 'remotion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	activePreviewId,
	HOVER_PREVIEW_DELAY_MS,
	PreviewThumb,
} from '../src/panels/motionTemplates/PreviewThumb.tsx';

function FrameProbe({ label }: { label: string }) {
	const frame = useCurrentFrame();
	return (
		<span data-probe={label} data-frame={frame}>
			{label}:{frame}
		</span>
	);
}

const thumb = (label: string, posterFrame = 12) => (
	<PreviewThumb
		component={FrameProbe}
		inputProps={{ label }}
		durationInFrames={30}
		fps={30}
		width={1920}
		height={1080}
		posterFrame={posterFrame}
		label={`${label} preview`}
	/>
);

const stateOf = (el: Element | null) => el?.getAttribute('data-preview-thumb');

function setReducedMotion(reduce: boolean) {
	vi.stubGlobal('matchMedia', (q: string) => ({
		matches: reduce && q.includes('prefers-reduced-motion'),
		media: q,
		addEventListener() {},
		removeEventListener() {},
	}));
}

describe('PreviewThumb', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setReducedMotion(false);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('shows the poster frame, then the shared hover Player after 200 ms', () => {
		const r = render(
			<div>
				{thumb('a')}
				{thumb('b', 3)}
			</div>,
		);
		const [a, b] = r.container.querySelectorAll('[data-preview-thumb]');
		expect(stateOf(a!)).toBe('poster');
		expect(a!.getAttribute('aria-label')).toBe('a preview');
		expect(a!.querySelector('[data-probe="a"]')?.getAttribute('data-frame')).toBe('12');
		expect(b!.querySelector('[data-probe="b"]')?.getAttribute('data-frame')).toBe('3');

		fireEvent.pointerEnter(a!, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS - 10);
		});
		expect(stateOf(a!)).toBe('poster');
		act(() => {
			vi.advanceTimersByTime(20);
		});
		expect(stateOf(a!)).toBe('playing');
		expect(a!.querySelector('[data-probe="a"]')).not.toBeNull();
		expect(activePreviewId()).not.toBeNull();

		// One Player for the whole app: hovering b moves it there.
		fireEvent.pointerEnter(b!, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
		});
		expect(stateOf(b!)).toBe('playing');
		expect(stateOf(a!)).toBe('poster');
		expect(r.container.querySelectorAll('[data-preview-thumb="playing"]')).toHaveLength(1);

		fireEvent.pointerLeave(b!, { pointerType: 'mouse' });
		expect(stateOf(b!)).toBe('poster');
		expect(activePreviewId()).toBeNull();
	});

	it('leaving before the delay never starts the Player', () => {
		const r = render(thumb('a'));
		const a = r.container.querySelector('[data-preview-thumb]')!;
		fireEvent.pointerEnter(a, { pointerType: 'mouse' });
		fireEvent.pointerLeave(a, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS * 2);
		});
		expect(stateOf(a)).toBe('poster');
	});

	it('touch and reduced motion keep the poster', () => {
		const r = render(thumb('a'));
		const a = r.container.querySelector('[data-preview-thumb]')!;
		fireEvent.pointerEnter(a, { pointerType: 'touch' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS * 2);
		});
		expect(stateOf(a)).toBe('poster');
		setReducedMotion(true);
		fireEvent.pointerEnter(a, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS * 2);
		});
		expect(stateOf(a)).toBe('poster');
	});

	it('unmounting the previewing thumb frees the shared Player', () => {
		const r = render(thumb('a'));
		fireEvent.pointerEnter(r.container.querySelector('[data-preview-thumb]')!, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(HOVER_PREVIEW_DELAY_MS);
		});
		expect(activePreviewId()).not.toBeNull();
		r.unmount();
		expect(activePreviewId()).toBeNull();
	});
});
