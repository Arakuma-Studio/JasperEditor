// The processor quality test covers stabilization; this checks the 16-bit warp's pixel contract.
import { afterAll, expect, it } from 'vitest';
import { WarpPool } from '../src/processing/proc/vidstab/pool.ts';
import { loadVidstabModule } from '../src/processing/proc/vidstab/wasm.ts';

const pools: WarpPool[] = [];
afterAll(async () => {
	await Promise.all(pools.map((pool) => pool.close()));
});

it('moves full-depth RGB pixels by an integer camera translation across worker bands', async () => {
	// A regression can flip either axis, swap channels, truncate to 8 bit, or corrupt rows at band edges.
	const width = 17;
	const height = 11;
	const pixel = (x: number, y: number, channel: number) => 1000 + y * 4000 + x * 101 + channel * 313;
	const input = new Uint16Array(width * height * 3);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			for (let channel = 0; channel < 3; channel++)
				input[(y * width + x) * 3 + channel] = pixel(x, y, channel);
	const output = input.slice();
	const pool = await WarpPool.create(await loadVidstabModule(), 3);
	pools.push(pool);
	await pool.warp(output, width, height, { x: 2, y: -1, alpha: 0, zoom: 0 }, 1);
	for (let y = 0; y < height - 1; y++)
		for (let x = 2; x < width; x++)
			for (let channel = 0; channel < 3; channel++)
				expect(output[(y * width + x) * 3 + channel]).toBe(pixel(x - 2, y + 1, channel));
});
