// The Log tab's spectrogram heat map (spec 12 §4 P6-E7): level 0…1 → colour, dark blue-black → violet → orange → pale
// yellow, the same ramp as the MCP sound sheet (apps/mcp/src/sound-sheet.ts) so the panel and the agents' PNG read
// alike. Data-visualisation colours: a tokens file (scripts/check-tokens.mjs exempts `*.tokens.ts`).
export const SPECTROGRAM_RAMP: readonly (readonly [number, readonly [number, number, number]])[] = [
	[0, [10, 10, 20]],
	[0.35, [70, 20, 110]],
	[0.6, [190, 55, 80]],
	[0.82, [250, 150, 40]],
	[1, [255, 250, 190]],
];

/** RGB of a level 0…1 on the ramp. */
export function spectrogramColour(v: number): readonly [number, number, number] {
	const x = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
	for (let i = 1; i < SPECTROGRAM_RAMP.length; i++) {
		const [p1, c1] = SPECTROGRAM_RAMP[i]!;
		const [p0, c0] = SPECTROGRAM_RAMP[i - 1]!;
		if (x <= p1) {
			const t = (x - p0) / (p1 - p0 || 1);
			return [
				Math.round(c0[0] + (c1[0] - c0[0]) * t),
				Math.round(c0[1] + (c1[1] - c0[1]) * t),
				Math.round(c0[2] + (c1[2] - c0[2]) * t),
			];
		}
	}
	return SPECTROGRAM_RAMP.at(-1)![1];
}
