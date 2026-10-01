// PreviewThumb (ARCHITECTURE §20.6): poster through <Thumbnail>, one shared hover <Player> after 200 ms,
// touch / reduced motion → poster only.
import { act, fireEvent, render, within } from '@testing-library/react';
import { useCurrentFrame } from 'remotion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewThumb } from '../src/panels/motionTemplates/PreviewThumb.tsx';

function FrameProbe({ label }: { label: string }) {
	const frame = useCurrentFrame();
	return (
		<span>
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

const frameOf = (el: Element) => el.textContent;

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
		const a = within(r.container).getByRole('img', { name: 'a preview' });
		const b = within(r.container).getByRole('img', { name: 'b preview' });
		expect(frameOf(a)).toBe('a:12');
		expect(frameOf(b)).toBe('b:3');

		fireEvent.pointerEnter(a, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(190);
		});
		expect(frameOf(a)).toBe('a:12');
		act(() => {
			vi.advanceTimersByTime(20);
		});
		expect(frameOf(a)).toBe('a:0');

		// One Player for the whole app: hovering b moves it there.
		fireEvent.pointerEnter(b, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(frameOf(b)).toBe('b:0');
		expect(frameOf(a)).toBe('a:12');

		fireEvent.pointerLeave(b, { pointerType: 'mouse' });
		expect(frameOf(b)).toBe('b:3');
	});

	it('leaving before the delay never starts the Player', () => {
		const r = render(thumb('a'));
		const a = within(r.container).getByRole('img', { name: 'a preview' });
		fireEvent.pointerEnter(a, { pointerType: 'mouse' });
		fireEvent.pointerLeave(a, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(frameOf(a)).toBe('a:12');
	});

	it('touch and reduced motion keep the poster', () => {
		const r = render(thumb('a'));
		const a = within(r.container).getByRole('img', { name: 'a preview' });
		fireEvent.pointerEnter(a, { pointerType: 'touch' });
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(frameOf(a)).toBe('a:12');
		setReducedMotion(true);
		fireEvent.pointerEnter(a, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(frameOf(a)).toBe('a:12');
	});
});
