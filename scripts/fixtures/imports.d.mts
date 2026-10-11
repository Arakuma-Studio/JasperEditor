import type { writePsdBuffer } from 'ag-psd';
import type { Fixture, FixtureContext } from './types.ts';

export function makePsd(agPsd: { writePsdBuffer: typeof writePsdBuffer }): Buffer;
export function fixtures(ctx: FixtureContext): Promise<Fixture[]>;
