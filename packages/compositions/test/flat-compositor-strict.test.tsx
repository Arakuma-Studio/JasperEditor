// Regression (spec 19 TL-116 follow-up): a Rec. 2020 Program with text went blank. Text in a wide working space takes the
// colour input transform, so the stack is drawn flat, and the flat compositor never drew: React's development Strict Mode
// runs effect cleanups without unmounting, the cleanup cancelled the pending draw request but kept its id, and the layout
// effect, seeing an id, never asked again.
import { Thumbnail } from '@remotion/player';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositeHub } from '../src/fx/composite.tsx';
import { FlatCompositor, FlatRegistry, type FlatStackValue } from '../src/fx/flat.tsx';

let pending: Map<number, FrameRequestCallback>;
let next = 1;
/** The canvases a 2D context drew an image on. */
let drawnOn: Set<HTMLCanvasElement>;

// Remotion counts NODE_ENV=test as a render (getRemotionEnvironment); the Program monitor is a Player.
beforeEach(() => {
	vi.stubEnv('NODE_ENV', 'development');
	pending = new Map();
	drawnOn = new Set();
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = next++;
		pending.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		pending.delete(id);
	});
	// happy-dom has no 2D context: a recording one, enough for a frame with nothing to composite.
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
		const canvas = this;
		return {
			canvas,
			save() {},
			restore() {},
			clearRect() {},
			fillRect() {},
			globalCompositeOperation: 'source-over',
			drawImage() {
				drawnOn.add(canvas);
			},
		} as unknown as RenderingContext;
	} as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const stack: FlatStackValue = { hub: new CompositeHub(), registry: new FlatRegistry(), opsAt: () => [] };

function Flat() {
	return <FlatCompositor stack={stack} comp={{ width: 8, height: 8 }} offset={0} isPreview linear={null} />;
}

describe('the flat compositor under Strict Mode', () => {
	it('draws its frame after React re-runs its effects', async () => {
		const view = render(
			<StrictMode>
				<Thumbnail
					component={Flat}
					compositionWidth={8}
					compositionHeight={8}
					durationInFrames={10}
					fps={25}
					frameToDisplay={0}
				/>
			</StrictMode>,
		);
		const out = view.container.querySelector<HTMLCanvasElement>('[data-flat-compositor]');
		expect(out).not.toBeNull();
		// The animation frames that were asked for and not cancelled.
		await act(async () => {
			for (let round = 0; round < 3; round++) {
				const due = [...pending.values()];
				pending.clear();
				for (const cb of due) cb(16 * round);
				await new Promise((r) => setTimeout(r, 0));
			}
		});
		// Before the fix nothing was ever drawn: the only request was cancelled by the simulated unmount.
		expect(drawnOn.has(out!)).toBe(true);
		view.unmount();
	});
});
