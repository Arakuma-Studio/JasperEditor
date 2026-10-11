import { beforeAll, expect, it } from 'vitest';
import { loadOpenCv, type OpenCv } from '../src/tools/opencv.ts';

let cv: OpenCv;

beforeAll(async () => {
	cv = (await loadOpenCv()).cv;
}, 30_000);

it('finds extrema with the JavaScript minMaxLoc overloads', () => {
	const src = cv.matFromArray(2, 3, cv.CV_32FC1, [4, -2, 7, 3, 8, 1]);
	const mask = cv.matFromArray(2, 3, cv.CV_8UC1, [1, 0, 1, 0, 0, 0]);
	try {
		expect(cv.minMaxLoc(src)).toEqual({
			minVal: -2,
			maxVal: 8,
			minLoc: { x: 1, y: 0 },
			maxLoc: { x: 1, y: 1 },
		});
		expect(cv.minMaxLoc(src, mask)).toEqual({
			minVal: 4,
			maxVal: 7,
			minLoc: { x: 0, y: 0 },
			maxLoc: { x: 2, y: 0 },
		});
	} finally {
		mask.delete();
		src.delete();
	}
});
