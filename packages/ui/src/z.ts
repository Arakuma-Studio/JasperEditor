// One z-index scale for every overlay (S05:DT-030). Mirrored as --pr-z-* variables in tokens.css.
export const Z = {
	panel: 0,
	panelMax: 50,
	dockDrop: 90,
	floating: 100,
	floatingMax: 199,
	maximized: 200,
	forcedCursor: 300,
	popover: 1000,
	dialog: 1100,
	tooltip: 1200,
	dragGhost: 1300,
	snapIndicator: 1310,
	toast: 1400,
} as const;
