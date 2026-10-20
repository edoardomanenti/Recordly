import { packClipSequence } from "./clipSequence";
import {
	type ClipRegion,
	type CursorTelemetryPoint,
	getClipSourceEndMs,
	getClipSourceStartMs,
	sortClipRegions,
} from "./types";

/**
 * Automatic cutting of a fresh recording.
 *
 * - "speech": the video is narrated, so pauses in the voice track are cut.
 * - "activity": the video is not narrated, so moments where nothing happens are cut:
 *   the picture is still (ffmpeg `freezedetect`) AND the cursor neither moves nor clicks.
 */
export type AutoCutMode = "off" | "speech" | "activity";

export const AUTO_CUT_MODES: AutoCutMode[] = ["off", "speech", "activity"];
export const DEFAULT_AUTO_CUT_MODE: AutoCutMode = "speech";

export interface TimeSpan {
	startMs: number;
	endMs: number;
}

interface CutTuning {
	/** A dead stretch must last at least this long (ms) to be cut. */
	minGapMs: number;
	/** Kept on each side of a cut so speech/actions don't feel clipped. */
	padMs: number;
}

const TUNING: Record<Exclude<AutoCutMode, "off">, CutTuning> = {
	speech: { minGapMs: 800, padMs: 200 },
	activity: { minGapMs: 1_500, padMs: 300 },
};

/** Cursor activity keeps this much time (ms) around itself. */
const CURSOR_ACTIVITY_PAD_MS = 500;
/** Normalized cursor travel between samples below this is jitter, not movement. */
const CURSOR_MOVE_EPSILON = 0.002;
/** Footage left between two cuts shorter than this (ms) is cut as well: a cough, a click. */
const MIN_KEPT_MS = 600;
/** Never cut a recording down to less than this (ms); detection likely failed. */
const MIN_RESULT_MS = 1_000;

export function isAutoCutMode(value: unknown): value is AutoCutMode {
	return typeof value === "string" && (AUTO_CUT_MODES as string[]).includes(value);
}

function mergeSpans(spans: TimeSpan[]): TimeSpan[] {
	const sorted = spans
		.filter((span) => span.endMs > span.startMs)
		.sort((left, right) => left.startMs - right.startMs);
	const merged: TimeSpan[] = [];
	for (const span of sorted) {
		const last = merged[merged.length - 1];
		if (last && span.startMs <= last.endMs) {
			last.endMs = Math.max(last.endMs, span.endMs);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

function subtractSpans(from: TimeSpan[], remove: TimeSpan[]): TimeSpan[] {
	const removal = mergeSpans(remove);
	return from.flatMap((span) => {
		const pieces: TimeSpan[] = [];
		let cursor = span.startMs;
		for (const cut of removal) {
			if (cut.endMs <= cursor || cut.startMs >= span.endMs) continue;
			if (cut.startMs > cursor) pieces.push({ startMs: cursor, endMs: cut.startMs });
			cursor = Math.max(cursor, cut.endMs);
		}
		if (cursor < span.endMs) pieces.push({ startMs: cursor, endMs: span.endMs });
		return pieces;
	});
}

/** Time ranges where the cursor moves or clicks, padded and merged. */
export function findCursorActivitySpans(points: CursorTelemetryPoint[]): TimeSpan[] {
	const sorted = [...points].sort((left, right) => left.timeMs - right.timeMs);
	const spans: TimeSpan[] = [];
	sorted.forEach((point, index) => {
		const previous = sorted[index - 1];
		const clicked = point.interactionType !== undefined && point.interactionType !== "move";
		const moved =
			previous !== undefined &&
			Math.hypot(point.cx - previous.cx, point.cy - previous.cy) > CURSOR_MOVE_EPSILON;
		if (!clicked && !moved) return;
		spans.push({
			startMs: (moved ? previous.timeMs : point.timeMs) - CURSOR_ACTIVITY_PAD_MS,
			endMs: point.timeMs + CURSOR_ACTIVITY_PAD_MS,
		});
	});
	return mergeSpans(spans);
}

/**
 * Turn detected dead stretches into the source ranges to remove.
 * `endMs: null` means the stretch runs to the end of the recording.
 */
export function computeAutoCutRemovals(options: {
	mode: AutoCutMode;
	totalMs: number;
	intervals: Array<{ startMs: number; endMs: number | null }>;
	cursorTelemetry?: CursorTelemetryPoint[];
}): TimeSpan[] {
	const { mode, totalMs } = options;
	if (mode === "off" || totalMs <= 0) return [];
	const tuning = TUNING[mode];

	let candidates = mergeSpans(
		options.intervals.map(({ startMs, endMs }) => ({
			startMs: Math.max(0, startMs),
			endMs: Math.min(totalMs, endMs ?? totalMs),
		})),
	);
	if (mode === "activity" && options.cursorTelemetry?.length) {
		candidates = subtractSpans(candidates, findCursorActivitySpans(options.cursorTelemetry));
	}

	const removals = candidates
		.filter((span) => span.endMs - span.startMs >= tuning.minGapMs)
		.map((span) => ({
			// Recording edges are cut fully; interior cuts keep padding on both sides.
			startMs: span.startMs <= 0 ? 0 : span.startMs + tuning.padMs,
			endMs: span.endMs >= totalMs ? totalMs : span.endMs - tuning.padMs,
		}))
		.filter((span) => span.endMs > span.startMs);

	// Fold slivers of footage left between two cuts into the cuts.
	const kept = subtractSpans([{ startMs: 0, endMs: totalMs }], removals);
	const slivers = kept.filter((span) => span.endMs - span.startMs < MIN_KEPT_MS);
	const finalRemovals = mergeSpans([...removals, ...slivers]);

	const keptMs = subtractSpans([{ startMs: 0, endMs: totalMs }], finalRemovals).reduce(
		(sum, span) => sum + span.endMs - span.startMs,
		0,
	);
	return keptMs < Math.min(MIN_RESULT_MS, totalMs) ? [] : finalRemovals;
}

/**
 * Cut `removals` (source time) out of the existing clips, keeping their order,
 * speed and audio settings. `split` holds the surviving pieces still at their
 * original timeline positions and `packed` the same pieces (same ids) with the
 * gaps closed, so effects can ripple from one to the other.
 */
export function applyAutoCutToClips(
	clips: ClipRegion[],
	removals: TimeSpan[],
	nextClipId: () => string,
): { split: ClipRegion[]; packed: ClipRegion[]; changed: boolean } {
	let changed = false;
	const split = sortClipRegions(clips).flatMap((clip) => {
		const speed = Number.isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
		const sourceStartMs = getClipSourceStartMs(clip);
		const sourceEndMs = getClipSourceEndMs(clip);
		const pieces = subtractSpans([{ startMs: sourceStartMs, endMs: sourceEndMs }], removals);
		if (
			pieces.length === 1 &&
			pieces[0].startMs === sourceStartMs &&
			pieces[0].endMs === sourceEndMs
		) {
			return [clip];
		}
		changed = true;
		return pieces.map((piece, index) => {
			const startMs = clip.startMs + Math.round((piece.startMs - sourceStartMs) / speed);
			return {
				...clip,
				// The first piece keeps the clip's identity so selection and effects follow it.
				id: index === 0 ? clip.id : nextClipId(),
				startMs,
				endMs: startMs + Math.round((piece.endMs - piece.startMs) / speed),
				sourceStartMs: piece.startMs,
			};
		});
	});
	return { split, packed: changed ? packClipSequence(split) : clips, changed };
}
