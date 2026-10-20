import { expect, test } from "@playwright/test";
import { installDesktopBridge, installDesktopBridgeOverrides } from "./bridge";

test("a fresh recording is cut automatically where it is silent", async ({ page }) => {
	test.setTimeout(45_000);
	await installDesktopBridge(page, "filmstrip.mp4");
	await installDesktopBridgeOverrides(page, () => {
		const calls: unknown[] = [];
		Object.assign(window, { autoCutCalls: calls });
		window.electronAPI.getCurrentRecordingSession = async () => ({
			success: true,
			session: {
				videoPath: `${location.origin}/tests/ui/fixtures/filmstrip.mp4`,
				webcamPath: null,
				timeOffsetMs: 0,
			},
		});
		window.electronAPI.detectAutoCutIntervals = async (options) => {
			calls.push(options);
			return { success: true, intervals: [{ startMs: 1_000, endMs: 3_000 }] };
		};
	});
	await page.goto("/?windowType=editor");

	const clips = page.locator('[data-variant="clip"]');
	await expect(clips).toHaveCount(2, { timeout: 20_000 });
	expect(
		await page.evaluate(() => (window as unknown as { autoCutCalls: unknown[] }).autoCutCalls),
	).toEqual([{ videoPath: expect.stringContaining("filmstrip.mp4"), mode: "speech" }]);
	// The pause is cut with 200ms of padding kept on both sides.
	await expect(clips.first()).toHaveAttribute("data-end-ms", "1200");
	await expect(clips.last()).toHaveAttribute("data-start-ms", "1200");
});
