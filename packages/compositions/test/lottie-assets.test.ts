import fc from 'fast-check';
import type { AnimationConfigWithData } from 'lottie-web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lottieDocument } from '../src/layers/lottie.ts';
import { lottieThumbnail } from '../src/layers/thumbnails.ts';

const player = vi.hoisted(() => ({
	loaded: true,
	svg: true,
	listeners: new Map<string, () => void>(),
	destroy: vi.fn(),
	seek: vi.fn(),
}));

vi.mock('lottie-web/build/player/lottie_svg', () => ({
	default: {
		loadAnimation: (options: AnimationConfigWithData<'svg'>) => {
			if (player.svg)
				options.container.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
			return {
				isLoaded: player.loaded,
				goToAndStop: player.seek,
				destroy: player.destroy,
				addEventListener: (name: string, listener: () => void) => player.listeners.set(name, listener),
				removeEventListener: (name: string) => player.listeners.delete(name),
			};
		},
	},
}));

const animation = { fr: 25, ip: 5, op: 55, w: 100, h: 100, layers: [] };
const fetchMock = vi.fn<typeof fetch>();
let nextUrl = 0;
const url = () => `/lottie/${nextUrl++}`;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async () => new Response(JSON.stringify(animation)));
	player.loaded = true;
	player.svg = true;
	player.listeners.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('Lottie source loading', () => {
	it('shares one validated document between simultaneous consumers', async () => {
		const source = url();
		const first = lottieDocument(source);
		expect(lottieDocument(source)).toBe(first);
		await expect(first).resolves.toEqual(animation);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('evicts failed reads so a repaired document can load', async () => {
		const source = url();
		fetchMock.mockResolvedValueOnce(new Response('{"assets":42}'));
		await expect(lottieDocument(source)).rejects.toMatchObject({ code: 'INVALID_LOTTIE' });
		await expect(lottieDocument(source)).resolves.toEqual(animation);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('rejects non-object JSON instead of passing it to the player', async () => {
		await fc.assert(
			fc.asyncProperty(fc.oneof(fc.constant(null), fc.boolean(), fc.array(fc.jsonValue())), async (value) => {
				fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value)));
				await expect(lottieDocument(url())).rejects.toMatchObject({ code: 'INVALID_LOTTIE' });
			}),
			{ numRuns: 30 },
		);
	});
});

describe('Lottie thumbnails', () => {
	it('seeks the validated frame range and releases the player and host', async () => {
		const children = document.body.childElementCount;
		await expect(lottieThumbnail(url())).resolves.toMatch(/^data:image\/svg\+xml/);
		expect(player.seek).toHaveBeenCalledWith(25, true);
		expect(player.destroy).toHaveBeenCalledOnce();
		expect(document.body.childElementCount).toBe(children);
	});

	it('rejects a missing picture instead of returning an empty SVG', async () => {
		player.svg = false;
		const children = document.body.childElementCount;
		await expect(lottieThumbnail(url())).rejects.toThrow('LOTTIE_RENDER_FAILED');
		expect(player.destroy).toHaveBeenCalledOnce();
		expect(document.body.childElementCount).toBe(children);
	});

	it('rejects a stalled renderer and releases its listeners and player', async () => {
		vi.useFakeTimers();
		player.loaded = false;
		const result = expect(lottieThumbnail(url())).rejects.toThrow('LOTTIE_RENDER_FAILED');
		await vi.advanceTimersByTimeAsync(3000);
		await result;
		expect(player.listeners.size).toBe(0);
		expect(player.destroy).toHaveBeenCalledOnce();
	});
});
