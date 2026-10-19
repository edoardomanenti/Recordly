export interface DetectedInterval {
	startMs: number;
	/** `Number.POSITIVE_INFINITY` for an interval that runs to the end of the media. */
	endMs: number;
}

/**
 * Parse ffmpeg `freezedetect` stderr into ordered frozen-picture intervals.
 * Lines look like:
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_start: 12.34
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_duration: 3.33
 *   [freezedetect @ 0x..] lavfi.freezedetect.freeze_end: 15.67
 */
export function parseFreezeIntervals(stderr: string): DetectedInterval[] {
	const intervals: DetectedInterval[] = [];
	let pendingStartMs: number | null = null;

	for (const line of stderr.split(/\r?\n/)) {
		const startMatch = line.match(/freeze_start:\s*(-?[\d.]+)/);
		if (startMatch) {
			pendingStartMs = Math.max(0, Math.round(Number.parseFloat(startMatch[1]) * 1000));
			continue;
		}

		const endMatch = line.match(/freeze_end:\s*(-?[\d.]+)/);
		if (endMatch && pendingStartMs !== null) {
			const endMs = Math.round(Number.parseFloat(endMatch[1]) * 1000);
			if (endMs > pendingStartMs) {
				intervals.push({ startMs: pendingStartMs, endMs });
			}
			pendingStartMs = null;
		}
	}

	// A trailing freeze_start with no matching end lasts until the end of the video.
	if (pendingStartMs !== null) {
		intervals.push({ startMs: pendingStartMs, endMs: Number.POSITIVE_INFINITY });
	}

	return intervals.sort((left, right) => left.startMs - right.startMs);
}
