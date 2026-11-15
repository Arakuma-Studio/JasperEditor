// Regression: a long Remotion export of a flat stack (two adjustment tracks) failed after ≈ 30 minutes. Every page's
// compositor hub kept one canvas for every clip it had ever drawn, until the system killed the render browser's GPU
// process (≈ 59 GB of shared memory) and the lost GPU context surfaced as CANVAS_NESTED.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompositeHub } from '../src/fx/composite.tsx';

beforeEach(() => {
	// happy-dom has no 2D context: enough of one to copy a picture.
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
		() => ({ globalCompositeOperation: 'source-over', drawImage() {} }) as never,
	);
});
afterEach(() => {
	vi.restoreAllMocks();
});

const META = { compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 };

it('keeps the pictures of the layers drawn lately, not of every clip it ever drew', () => {
	const hub = new CompositeHub();
	const picture = document.createElement('canvas');
	// A background under 2000 one-frame clips; each drawn layer delivers its picture of every frame it is drawn on.
	for (let f = 0; f < 2000; f++) {
		hub.tap('background', f).deliver(picture, 64, 36, META);
		hub.tap(`clip-${f}`, f).deliver(picture, 64, 36, META);
	}
	expect(hub.pictures.size).toBeLessThan(20);
	expect(hub.pictures.get('background')?.frame).toBe(1999);
	expect(hub.pictures.get('clip-1999')?.frame).toBe(1999);
});
