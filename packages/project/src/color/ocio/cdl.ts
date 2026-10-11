// ASC Color Decision List: ASC CDL v1.2 maths (slope, offset, power per channel, then
// saturation with Rec.709 luma weights) and the `.cc` / `.ccc` / `.cdl` XML containers. Ported from EffectCraft
// `crates/effects/src/ocio.rs` (MIT OR Apache-2.0).
import type { Rgb } from '../lut.ts';

export type Cdl = { slope: Rgb; offset: Rgb; power: Rgb; sat: number };
export const IDENTITY_CDL: Cdl = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 };

const LUMA = [0.2126, 0.7152, 0.0722] as const;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Forward CDL in place. `clamp` = the v1.2 ASC style (0…1 after SOP and after saturation); else negatives pass. */
export function applyCdl(cdl: Cdl, c: Rgb, clamp = true): void {
	for (let i = 0; i < 3; i++) {
		const v = c[i]! * cdl.slope[i]! + cdl.offset[i]!;
		c[i] = clamp ? clamp01(v) ** cdl.power[i]! : v >= 0 ? v ** cdl.power[i]! : v;
	}
	const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
	for (let i = 0; i < 3; i++) {
		const v = l + cdl.sat * (c[i]! - l);
		c[i] = clamp ? clamp01(v) : v;
	}
}

/** Inverse of `applyCdl` (exact inside the clamped range), in place. */
export function invertCdl(cdl: Cdl, c: Rgb, clamp = true): void {
	if (clamp) for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]!);
	const l = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
	const s = Math.abs(cdl.sat) < 1e-9 ? 1e-9 : cdl.sat;
	for (let i = 0; i < 3; i++) {
		let v = l + (c[i]! - l) / s;
		if (clamp) v = clamp01(v);
		const pw = Math.max(cdl.power[i]!, 1e-9);
		const u = v >= 0 ? v ** (1 / pw) : v;
		const sl = Math.abs(cdl.slope[i]!) < 1e-9 ? 1e-9 : cdl.slope[i]!;
		const r = (u - cdl.offset[i]!) / sl;
		c[i] = clamp ? clamp01(r) : r;
	}
}

function tag(xml: string, name: string): string | null {
	const open = xml.search(new RegExp(`<${name}[\\s>/]`));
	if (open < 0) return null;
	const gt = xml.indexOf('>', open);
	if (gt < 0) return null;
	if (xml[gt - 1] === '/') return '';
	const close = xml.indexOf(`</${name}>`, gt);
	return close < 0 ? null : xml.slice(gt + 1, close);
}

function nums3(s: string | null): Rgb | null {
	if (s === null) return null;
	const v = s.trim().split(/\s+/).map(Number);
	return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : null;
}

function parseCc(block: string): Cdl {
	const sat = Number(tag(block, 'Saturation')?.trim());
	return {
		slope: nums3(tag(block, 'Slope')) ?? [1, 1, 1],
		offset: nums3(tag(block, 'Offset')) ?? [0, 0, 0],
		power: nums3(tag(block, 'Power')) ?? [1, 1, 1],
		sat: Number.isFinite(sat) ? sat : 1,
	};
}

/** Every `<ColorCorrection>` of an ASC CDL XML document (`.cc`, `.ccc`, `.cdl`) with its `id`, in file order. */
export function parseCdlXml(xml: string): { id: string; cdl: Cdl }[] {
	const out: { id: string; cdl: Cdl }[] = [];
	let rest = xml;
	for (let guard = 0; guard < 100_000; guard++) {
		// `<ColorCorrection` followed by a space, `>` or `/` (not `<ColorCorrectionCollection`).
		const i = rest.search(/<ColorCorrection[\s>/]/);
		if (i < 0) break;
		const after = rest.slice(i);
		const headEnd = after.indexOf('>');
		const head = headEnd < 0 ? after : after.slice(0, headEnd);
		const id = /\bid\s*=\s*(["'])(.*?)\1/.exec(head)?.[2] ?? '';
		const endTag = after.indexOf('</ColorCorrection>');
		const end = endTag < 0 ? after.length : endTag + '</ColorCorrection>'.length;
		out.push({ id, cdl: parseCc(after.slice(0, end)) });
		rest = after.slice(Math.max(end, 1));
	}
	return out;
}
