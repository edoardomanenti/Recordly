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

test("auto-cut can be applied to an existing, already edited video", async ({ page }) => {
	test.setTimeout(45_000);
	await installDesktopBridge(page, "filmstrip.mp4");
	await installDesktopBridgeOverrides(page, () => {
		window.electronAPI.detectAutoCutIntervals = async () => ({
			success: true,
			intervals: [{ startMs: 1_000, endMs: 3_000 }],
		});
	});
	await page.goto("/?windowType=editor");

	const clips = page.locator('[data-variant="clip"]');
	await expect(clips).toHaveCount(1, { timeout: 20_000 });
	// Opening an existing video never cuts on its own.
	await page.waitForTimeout(1_000);
	await expect(clips).toHaveCount(1);

	// Edit the timeline first: split near the end.
	const clip = await clips.first().boundingBox();
	const timeline = page
		.locator(".select-none.bg-editor-bg.relative.cursor-pointer.group.flex.flex-col")
		.last();
	const canvas = await timeline.boundingBox();
	if (!clip || !canvas) throw new Error("Timeline is not visible");
	await page.mouse.click(clip.x + clip.width * 0.8, canvas.y + 6);
	await page.getByRole("button", { name: /Split Clip/ }).click();
	await expect(clips).toHaveCount(2);

	await page.getByRole("radio", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Apply now" }).click();
	await expect(clips).toHaveCount(3);
	await expect(clips.first()).toHaveAttribute("data-end-ms", "1200");
	await expect(clips.nth(1)).toHaveAttribute("data-start-ms", "1200");
});
