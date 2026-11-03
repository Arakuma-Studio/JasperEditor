// Spec 19 TL-096: the shared numeric control: click slop, modifiers, tracks for wide ranges, double-click to reset.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fromTrack,
	ScrubbyNumber,
	scrubDelta,
	toTrack,
	trackMappingOf,
	useScrubLabel,
} from '../src/panels/properties/controls/ScrubbyNumber.tsx';

afterEach(() => cleanup());

const move = (x: number, init: Record<string, unknown> = {}) =>
	act(() => {
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, ...init }));
	});
const up = () =>
	act(() => {
		window.dispatchEvent(new MouseEvent('pointerup'));
	});

function scrubby(extra: Partial<Parameters<typeof ScrubbyNumber>[0]> = {}) {
	const h = {
		onScrubStart: vi.fn(),
		onScrub: vi.fn(),
		onScrubEnd: vi.fn(),
		onCommit: vi.fn(),
		onReset: vi.fn(),
	};
	render(<ScrubbyNumber value={10} label="Width" data-testid="n" {...h} {...extra} />);
	return h;
}

describe('scrub (TL-096)', () => {
	it('a press within 3 px is a click: no scrub, and the value opens for typing', () => {
		const h = scrubby();
		fireEvent.pointerDown(screen.getByTestId('n'), { clientX: 100, button: 0 });
		move(102);
		up();
		expect(h.onScrubStart).not.toHaveBeenCalled();
		expect(screen.getByTestId('n-input')).toBeTruthy();
	});

	it('3 px or more scrubs from the press, one gesture', () => {
		const h = scrubby();
		fireEvent.pointerDown(screen.getByTestId('n'), { clientX: 100, button: 0 });
		move(103);
		move(110);
		up();
		expect(h.onScrubStart).toHaveBeenCalledTimes(1);
		expect(h.onScrub).toHaveBeenLastCalledWith(10);
		expect(h.onScrubEnd).toHaveBeenCalledWith(false);
	});

	it('Shift ×10, Ctrl ×0.1, quantized', () => {
		expect(scrubDelta(5, 1, { shift: true, ctrl: false })).toBe(50);
		expect(scrubDelta(5, 1, { shift: false, ctrl: true })).toBe(0.5);
		expect(scrubDelta(3, 0.1, { shift: false, ctrl: false })).toBeCloseTo(0.3, 6);
		expect(scrubDelta(-7, 0.5, { shift: false, ctrl: false })).toBe(-3.5);
	});

	it('Esc cancels a scrub', () => {
		const h = scrubby();
		fireEvent.pointerDown(screen.getByTestId('n'), { clientX: 100, button: 0 });
		move(120);
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		});
		expect(h.onScrubEnd).toHaveBeenCalledWith(true);
	});
});

describe('label scrub (TL-096)', () => {
	function Label(props: { onScrub(d: number): void; onEnd(c: boolean): void; onStart(): void }) {
		const down = useScrubLabel({
			step: 2,
			onStart: props.onStart,
			onScrub: props.onScrub,
			onEnd: props.onEnd,
		});
		return (
			<span data-testid="l" onPointerDown={down}>
				Width
			</span>
		);
	}

	it('scrubs like the value, and a click on the label does nothing', () => {
		const onScrub = vi.fn();
		const onEnd = vi.fn();
		const onStart = vi.fn();
		render(<Label onScrub={onScrub} onEnd={onEnd} onStart={onStart} />);
		fireEvent.pointerDown(screen.getByTestId('l'), { clientX: 0, button: 0 });
		up();
		expect(onStart).not.toHaveBeenCalled();
		fireEvent.pointerDown(screen.getByTestId('l'), { clientX: 0, button: 0 });
		move(5);
		up();
		expect(onScrub).toHaveBeenLastCalledWith(10);
		expect(onEnd).toHaveBeenCalledWith(false);
	});
});

describe('double-click (TL-096)', () => {
	it('resets when the second click lands on the field the first one opened', () => {
		const h = scrubby();
		fireEvent.pointerDown(screen.getByTestId('n'), { clientX: 10, button: 0 });
		up();
		fireEvent.doubleClick(screen.getByTestId('n-input'));
		expect(h.onReset).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('n-input')).toBeNull();
	});

	it('a late double-click in the field selects text as usual', () => {
		vi.useFakeTimers({ toFake: ['performance'] });
		try {
			const h = scrubby();
			fireEvent.pointerDown(screen.getByTestId('n'), { clientX: 10, button: 0 });
			up();
			vi.advanceTimersByTime(1000);
			fireEvent.doubleClick(screen.getByTestId('n-input'));
			expect(h.onReset).not.toHaveBeenCalled();
			expect(screen.getByTestId('n-input')).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('tracks (TL-096)', () => {
	it('chooses a log track for positive ranges spanning 50×, quadratic for many steps from low values', () => {
		expect(trackMappingOf(8, 800, 1)).toBe('log');
		expect(trackMappingOf(0, 40, 0.1)).toBe('pow');
		expect(trackMappingOf(0, 100, 1)).toBe('linear');
		expect(trackMappingOf(5, 5, 1)).toBe('linear');
		expect(trackMappingOf(-10, 500, 0.1)).toBe('linear');
	});

	it('maps there and back, finer at the low end', () => {
		for (const mapping of ['linear', 'log', 'pow'] as const) {
			const t = { min: mapping === 'log' ? 1 : 0, max: 1000, mapping };
			for (const v of [t.min, 10, 250, 1000])
				expect(fromTrack(toTrack(v, t), t)).toBeCloseTo(Math.max(v, t.min), 6);
		}
		expect(toTrack(10, { min: 0, max: 1000, mapping: 'pow' })).toBeCloseTo(0.1, 6);
		expect(toTrack(10, { min: 1, max: 1000, mapping: 'log' })).toBeCloseTo(1 / 3, 6);
		expect(toTrack(10, { min: 0, max: 1000 })).toBeCloseTo(0.01, 6);
	});

	it('keeps positions in range for values past the track', () => {
		const t = { min: 0, max: 40, mapping: 'pow' as const };
		expect(toTrack(900, t)).toBe(1);
		expect(fromTrack(2, t)).toBe(40);
		expect(fromTrack(-1, t)).toBe(0);
		expect(Number.isFinite(toTrack(1, { min: 3, max: 3 }))).toBe(true);
	});

	it('a press on the track sets the value there, as one gesture', () => {
		const h = scrubby({ value: 0, step: 1, track: { min: 0, max: 100 } });
		const track = screen.getByTestId('n-track');
		track.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 12 }) as DOMRect;
		fireEvent.pointerDown(track, { clientX: 25, button: 0 });
		expect(h.onScrubStart).toHaveBeenCalledTimes(1);
		expect(h.onScrub).toHaveBeenLastCalledWith(25);
		move(50);
		expect(h.onScrub).toHaveBeenLastCalledWith(50);
		up();
		expect(h.onScrubEnd).toHaveBeenCalledWith(false);
	});

	it('a mixed value drags by offset from where the press landed', () => {
		const h = scrubby({ value: null, step: 1, track: { min: 0, max: 100 } });
		const track = screen.getByTestId('n-track');
		track.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 12 }) as DOMRect;
		fireEvent.pointerDown(track, { clientX: 40, button: 0 });
		expect(h.onScrub).toHaveBeenLastCalledWith(0);
		move(45);
		expect(h.onScrub).toHaveBeenLastCalledWith(5);
		up();
	});
});

describe('mixed text', () => {
	it('defaults to the inspector dash and can be set', () => {
		render(<ScrubbyNumber value={null} label="A" data-testid="a" />);
		render(<ScrubbyNumber value={null} label="B" mixedText="—" data-testid="b" />);
		expect(screen.getByTestId('a').textContent).toBe('–');
		expect(screen.getByTestId('b').textContent).toBe('—');
	});
});
