// Host request codes shared by the prelude (`__COMP = 0, …`) and the world (must match prelude.ts).
export const OP = {
	COMP: 0,
	COMPNAME: 1,
	LAYER: 2,
	LINFO: 3,
	CHILD: 4,
	PINFO: 5,
	VALUE: 6,
	XFORM: 7,
	RECT: 8,
	MARKERS: 9,
	TEXT: 10,
	SAMPLE: 11,
	PROJ: 12,
	PATH: 13,
	PATHAT: 14,
	SPACE: 15,
} as const;
