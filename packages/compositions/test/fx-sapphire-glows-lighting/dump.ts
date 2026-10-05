// Visual review tool of the Sapphire Glows + Lighting family (not a test): renders shots in headless Chrome and
// writes PNGs. Usage (repo root):
//   pnpm tsx packages/compositions/test/fx-sapphire-glows-lighting/dump.ts <outDir> '<json shots>'
//   shots = [{"id": "jasper.s.glow", "params": {...}, "opts": {"scene": "night"}, "name": "glow-default"}, ...]
//   a shot {"sheet": [...shots], "cols": 4, "tw": 320, "th": 180, "name": "sheet"} writes a contact sheet.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSglPage, sgl } from './browser.ts';

type Shot = {
	timing?: boolean;
	id?: string;
	name?: string;
	scene?: string;
	sheet?: unknown[];
	cols?: number;
	tw?: number;
	th?: number;
};

const [outDir = '/tmp/sgl', json = '[]'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const shots = JSON.parse(json.startsWith('@') ? readFileSync(json.slice(1), 'utf8') : json) as Shot[];
const { browser, page } = await openSglPage();
try {
	for (const [i, s] of shots.entries()) {
		const name = s.name ?? `${i}-${s.id ?? s.scene ?? 'sheet'}`;
		let url: string;
		const t0 = Date.now();
		if (s.timing) {
			console.info(s.id, JSON.stringify(await sgl(page, 'timing', s.id)));
			continue;
		}
		if (s.sheet) url = await sgl<string>(page, 'sheet', s.sheet, s.cols ?? 4, s.tw ?? 320, s.th ?? 180);
		else if (s.scene && !s.id) url = await sgl<string>(page, 'scenePng', s.scene);
		else url = await sgl<string>(page, 'png', s);
		writeFileSync(join(outDir, `${name}.png`), Buffer.from(url.split(',')[1]!, 'base64'));
		console.info(`${name}.png (${Date.now() - t0} ms)`);
	}
} finally {
	await browser.close();
}
