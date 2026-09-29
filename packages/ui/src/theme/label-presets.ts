// Label color presets as data (S05:DT-020, R-PUI §3.4). Mirrors tokens.css for code that needs raw
// values (canvas drawing of waveforms/clips, color pickers). Lives under theme/ (token-lint exempt).
import type { LabelName } from '../labels.ts';

export type LabelPresetId = 'default' | 'classic' | 'vibrant';
export type LabelSwatch = { body: string; tint: string };

export const LABEL_PRESETS: Record<LabelPresetId, Record<LabelName, LabelSwatch>> = {
	default: {
		violet: { body: '#3e0aad', tint: '#b9a2ff' },
		iris: { body: '#004b68', tint: '#5fc2fe' },
		caribbean: { body: '#2a5506', tint: '#9fe07a' },
		lavender: { body: '#741186', tint: '#e9a6ff' },
		cerulean: { body: '#06555a', tint: '#6fe3e6' },
		forest: { body: '#3e4a00', tint: '#c9d86a' },
		rose: { body: '#8c0235', tint: '#ff9dbd' },
		mango: { body: '#893904', tint: '#ffb27a' },
		purple: { body: '#6200b7', tint: '#c89bff' },
		blue: { body: '#122c9a', tint: '#9cb0ff' },
		teal: { body: '#014e44', tint: '#6fe0cc' },
		magenta: { body: '#830d57', tint: '#ff9ad6' },
		tan: { body: '#6f5a45', tint: '#e2c9ad' },
		green: { body: '#0d5e26', tint: '#7fe39a' },
		brown: { body: '#5c3b06', tint: '#e0b877' },
		yellow: { body: '#6f6619', tint: '#f0e57a' },
	},
	classic: {
		violet: { body: '#a690e0', tint: '#b9a2ff' },
		iris: { body: '#729acc', tint: '#5fc2fe' },
		caribbean: { body: '#29d698', tint: '#9fe07a' },
		lavender: { body: '#e384e3', tint: '#e9a6ff' },
		cerulean: { body: '#2fbfde', tint: '#6fe3e6' },
		forest: { body: '#51b858', tint: '#c9d86a' },
		rose: { body: '#f76fa4', tint: '#ff9dbd' },
		mango: { body: '#eda63b', tint: '#ffb27a' },
		purple: { body: '#970097', tint: '#c89bff' },
		blue: { body: '#3c3cff', tint: '#9cb0ff' },
		teal: { body: '#008080', tint: '#6fe0cc' },
		magenta: { body: '#e732e7', tint: '#ff9ad6' },
		tan: { body: '#cec195', tint: '#e2c9ad' },
		green: { body: '#1d7021', tint: '#7fe39a' },
		brown: { body: '#8b4513', tint: '#e0b877' },
		yellow: { body: '#e2e264', tint: '#f0e57a' },
	},
	vibrant: {
		violet: { body: '#5a1fe0', tint: '#cbb8ff' },
		iris: { body: '#0077a8', tint: '#8ed4ff' },
		caribbean: { body: '#3f8a0a', tint: '#b8ef99' },
		lavender: { body: '#a41bbd', tint: '#f1c0ff' },
		cerulean: { body: '#0a8a91', tint: '#94f0f2' },
		forest: { body: '#627400', tint: '#dbe88f' },
		rose: { body: '#c4054c', tint: '#ffb9d0' },
		mango: { body: '#c25306', tint: '#ffc79f' },
		purple: { body: '#8a10ff', tint: '#dab9ff' },
		blue: { body: '#2046d6', tint: '#b9c8ff' },
		teal: { body: '#02806f', tint: '#96ecdc' },
		magenta: { body: '#b8127b', tint: '#ffb8e2' },
		tan: { body: '#9a7c5f', tint: '#ecd9c4' },
		green: { body: '#13883a', tint: '#a2edb6' },
		brown: { body: '#86570b', tint: '#ebcb98' },
		yellow: { body: '#9c8f22', tint: '#f5ed9f' },
	},
};
