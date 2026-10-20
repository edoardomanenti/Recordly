import { describe, expect, it } from "vitest";
import { applyAutoCutToClips, computeAutoCutRemovals, findCursorActivitySpans } from "./autoCut";
import { rippleRegions } from "./clipSequence";
import type { CursorTelemetryPoint } from "./types";

const point = (
	timeMs: number,
	cx: number,
	cy = 0.5,
	interactionType?: CursorTelemetryPoint["interactionType"],
): CursorTelemetryPoint => ({ timeMs, cx, cy, interactionType });

describe("computeAutoCutRemovals (speech)", () => {
	it("cuts long pauses fully at the edges and with padding inside", () => {
		const removals = computeAutoCutRemovals({
			mode: "speech",
			totalMs: 20_000,
			intervals: [
				{ startMs: 0, endMs: 2_000 },
				{ startMs: 8_000, endMs: 11_000 },
				{ startMs: 17_000, endMs: null },
			],
		});
		expect(removals).toEqual([
			{ startMs: 0, endMs: 1_800 },
			{ startMs: 8_200, endMs: 10_800 },
			{ startMs: 17_200, endMs: 20_000 },
		]);
	});

	it("keeps short pauses between words", () => {
		expect(
			computeAutoCutRemovals({
				mode: "speech",
				totalMs: 10_000,
				intervals: [{ startMs: 4_000, endMs: 4_600 }],
			}),
		).toEqual([]);
	});

	it("folds a sliver of footage left between two cuts into the cuts", () => {
		const removals = computeAutoCutRemovals({
			mode: "speech",
			totalMs: 20_000,
			intervals: [
				{ startMs: 5_000, endMs: 8_000 },
				{ startMs: 8_150, endMs: 12_000 },
			],
		});
		// A 150ms noise burst leaves 7_800..8_350 after padding: too short to keep.
		expect(removals).toEqual([{ startMs: 5_200, endMs: 11_800 }]);
	});

	it("refuses to cut a recording that is silent from start to end", () => {
		expect(
			computeAutoCutRemovals({
				mode: "speech",
				totalMs: 30_000,
				intervals: [{ startMs: 0, endMs: null }],
			}),
		).toEqual([]);
	});

	it("does nothing when off", () => {
		expect(
			computeAutoCutRemovals({
				mode: "off",
				totalMs: 10_000,
				intervals: [{ startMs: 2_000, endMs: 6_000 }],
			}),
		).toEqual([]);
	});
});

describe("computeAutoCutRemovals (activity)", () => {
	it("cuts a still screen only where the cursor is idle too", () => {
		const removals = computeAutoCutRemovals({
			mode: "activity",
			totalMs: 30_000,
			intervals: [{ startMs: 5_000, endMs: 20_000 }],
			// The cursor moves around 12s, splitting the still stretch in two.
			cursorTelemetry: [point(11_900, 0.2), point(12_000, 0.4), point(12_100, 0.6)],
		});
		expect(removals).toEqual([
			{ startMs: 5_300, endMs: 11_100 },
			{ startMs: 12_900, endMs: 19_700 },
		]);
	});

	it("keeps a click on a still screen", () => {
		const removals = computeAutoCutRemovals({
			mode: "activity",
			totalMs: 30_000,
			intervals: [{ startMs: 10_000, endMs: 13_000 }],
			cursorTelemetry: [point(11_500, 0.5, 0.5, "click")],
		});
		// Only 10_000..11_000 is idle, too short for the activity threshold.
		expect(removals).toEqual([]);
	});

	it("uses the still-screen detection alone without cursor telemetry", () => {
		expect(
			computeAutoCutRemovals({
				mode: "activity",
				totalMs: 30_000,
				intervals: [{ startMs: 10_000, endMs: 14_000 }],
			}),
		).toEqual([{ startMs: 10_300, endMs: 13_700 }]);
	});
});

describe("findCursorActivitySpans", () => {
	it("ignores jitter and merges nearby movement", () => {
		expect(
			findCursorActivitySpans([
				point(1_000, 0.5),
				point(1_100, 0.5005),
				point(2_000, 0.6),
				point(2_400, 0.7),
			]),
		).toEqual([{ startMs: 600, endMs: 2_900 }]);
	});
});

describe("applyAutoCutToClips", () => {
	const ids = () => {
		let id = 10;
		return () => `clip-${id++}`;
	};

	it("cuts a full track and lets effects ripple from the split clips", () => {
		const { split, packed, changed } = applyAutoCutToClips(
			[{ id: "clip-1", startMs: 0, endMs: 10_000, speed: 1 }],
			[
				{ startMs: 0, endMs: 2_000 },
				{ startMs: 5_000, endMs: 7_000 },
			],
			ids(),
		);
		expect(changed).toBe(true);
		expect(packed).toEqual([
			{ id: "clip-1", startMs: 0, endMs: 3_000, sourceStartMs: 2_000, speed: 1 },
			{ id: "clip-10", startMs: 3_000, endMs: 6_000, sourceStartMs: 7_000, speed: 1 },
		]);
		// A zoom over 7.5s..8.5s of the original recording follows its footage.
		expect(
			rippleRegions([{ id: "zoom-1", startMs: 7_500, endMs: 8_500 }], split, packed),
		).toEqual([{ id: "zoom-1", startMs: 3_500, endMs: 4_500 }]);
	});

	it("cuts inside an already edited timeline, keeping order, speed and audio settings", () => {
		const { packed } = applyAutoCutToClips(
			[
				// Moved to the front: plays source 6s..10s at 2x.
				{
					id: "clip-2",
					startMs: 0,
					endMs: 2_000,
					sourceStartMs: 6_000,
					speed: 2,
					muted: true,
				},
				{ id: "clip-1", startMs: 2_000, endMs: 5_000, sourceStartMs: 0, speed: 1 },
			],
			[{ startMs: 7_000, endMs: 8_000 }],
			ids(),
		);
		expect(packed).toEqual([
			{ id: "clip-2", startMs: 0, endMs: 500, sourceStartMs: 6_000, speed: 2, muted: true },
			{
				id: "clip-10",
				startMs: 500,
				endMs: 1_500,
				sourceStartMs: 8_000,
				speed: 2,
				muted: true,
			},
			{ id: "clip-1", startMs: 1_500, endMs: 4_500, sourceStartMs: 0, speed: 1 },
		]);
	});

	it("leaves clips untouched when nothing dead falls inside them", () => {
		const clips = [{ id: "clip-1", startMs: 0, endMs: 3_000, sourceStartMs: 2_000, speed: 1 }];
		const result = applyAutoCutToClips(clips, [{ startMs: 0, endMs: 1_800 }], ids());
		expect(result.changed).toBe(false);
		expect(result.packed).toBe(clips);
	});
});
