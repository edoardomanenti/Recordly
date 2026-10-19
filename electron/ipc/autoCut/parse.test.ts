import { describe, expect, it } from "vitest";
import { parseFreezeIntervals } from "./parse";

describe("parseFreezeIntervals", () => {
	it("pairs freeze_start / freeze_end lines into ms intervals", () => {
		const stderr = [
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 1.5",
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2.5",
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 4",
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 10.25",
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.25",
			"[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 11.5",
		].join("\n");
		expect(parseFreezeIntervals(stderr)).toEqual([
			{ startMs: 1_500, endMs: 4_000 },
			{ startMs: 10_250, endMs: 11_500 },
		]);
	});

	it("treats a trailing freeze_start with no end as running to the end of the video", () => {
		expect(parseFreezeIntervals("lavfi.freezedetect.freeze_start: 7.2")).toEqual([
			{ startMs: 7_200, endMs: Number.POSITIVE_INFINITY },
		]);
	});

	it("ignores unrelated output and unmatched ends", () => {
		const stderr = [
			"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'recording.mp4':",
			"lavfi.freezedetect.freeze_end: 3",
			"frame=  120 fps=0.0 q=-0.0 Lsize=N/A",
		].join("\n");
		expect(parseFreezeIntervals(stderr)).toEqual([]);
	});
});
