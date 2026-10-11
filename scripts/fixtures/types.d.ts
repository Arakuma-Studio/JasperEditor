export type FixtureContext = {
	ffmpeg: string;
	base: string[];
	h264: string[];
	aac: string[];
};

export type Fixture = { name: string } & (
	| { steps(out: string): string[][] }
	| { recipe: string; make(out: string): void | Promise<void> }
);
