import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
	type AutoCutMode,
	buildAutoCutClips,
	computeAutoCutRemovals,
	isUneditedFullTrack,
} from "../autoCut";
import { rippleRegionAnchors, rippleRegions } from "../clipSequence";
import type { useTimelineState } from "../state/useTimelineState";

type Translate = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;

type Input = {
	t: Translate;
	mode: AutoCutMode;
	videoSourcePath: string | null;
	loading: boolean;
	isPreviewReady: boolean;
	duration: number;
	timeline: ReturnType<typeof useTimelineState>;
	clipInitializedRef: MutableRefObject<boolean>;
	nextClipIdRef: MutableRefObject<number>;
	autoFullTrackClipIdRef: MutableRefObject<string | null>;
	autoFullTrackClipEndMsRef: MutableRefObject<number | null>;
	pendingFreshRecordingAutoCutPathRef: MutableRefObject<string | null>;
};

/** Cuts dead moments out of a just-finished recording, and on demand from settings. */
export function useFreshRecordingAutoCut(input: Input) {
	const { t, mode, videoSourcePath, loading, isPreviewReady, duration, timeline } = input;
	const [isAutoCutting, setIsAutoCutting] = useState(false);
	const busyRef = useRef(false);
	// Detection is async; read the newest timeline/source when it finishes.
	const latest = useRef(input);
	latest.current = input;

	const runAutoCut = useCallback(
		async (cutMode: AutoCutMode, options: { fromUser: boolean }) => {
			const sourcePath = latest.current.videoSourcePath;
			const totalMs = Math.round(latest.current.duration * 1000);
			if (cutMode === "off" || !sourcePath || totalMs <= 0 || busyRef.current) return;
			const isUnedited = () =>
				latest.current.clipInitializedRef.current &&
				isUneditedFullTrack(latest.current.timeline.clipRegions, totalMs);
			if (!isUnedited()) {
				if (options.fromUser) {
					toast.info(
						t(
							"settings.autoCut.timelineEdited",
							"Auto-cut only works on an unedited timeline. Undo your edits and try again.",
						),
					);
				}
				return;
			}

			busyRef.current = true;
			setIsAutoCutting(true);
			try {
				const [detection, telemetry] = await Promise.all([
					window.electronAPI.detectAutoCutIntervals({
						videoPath: sourcePath,
						mode: cutMode,
					}),
					cutMode === "activity"
						? window.electronAPI.getCursorTelemetry(sourcePath)
						: Promise.resolve(null),
				]);
				if (!detection.success) throw new Error(detection.error || "Detection failed");
				// The user may have switched recordings or started editing meanwhile.
				if (latest.current.videoSourcePath !== sourcePath || !isUnedited()) return;

				const removals = computeAutoCutRemovals({
					mode: cutMode,
					totalMs,
					intervals: detection.intervals ?? [],
					cursorTelemetry: telemetry?.success ? telemetry.samples : [],
				});
				if (removals.length === 0) {
					if (options.fromUser) {
						toast.info(
							t("settings.autoCut.nothingToCut", "Auto-cut found nothing to remove."),
						);
					}
					return;
				}

				const current = latest.current;
				const { split, packed } = buildAutoCutClips(
					removals,
					totalMs,
					() => `clip-${current.nextClipIdRef.current++}`,
				);
				// The full track is gone, so it must no longer stretch with the duration.
				current.autoFullTrackClipIdRef.current = null;
				current.autoFullTrackClipEndMsRef.current = null;
				current.timeline.setSelectedClipId(null);
				current.timeline.setClipRegions(packed);
				current.timeline.setZoomRegions((regions) => rippleRegions(regions, split, packed));
				current.timeline.setAnnotationRegions((regions) =>
					rippleRegions(regions, split, packed),
				);
				current.timeline.setAudioRegions((regions) =>
					rippleRegionAnchors(regions, split, packed),
				);

				const removedSeconds = Math.round(
					removals.reduce((sum, span) => sum + span.endMs - span.startMs, 0) / 1000,
				);
				toast.success(
					t(
						"settings.autoCut.applied",
						"Auto-cut removed {{count}} dead moments ({{seconds}}s). Press Undo to restore them.",
						{ count: removals.length, seconds: removedSeconds },
					),
				);
			} catch (error) {
				console.error("Auto-cut failed:", error);
				toast.error(
					t("settings.autoCut.failed", "Auto-cut failed: {{error}}", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			} finally {
				busyRef.current = false;
				setIsAutoCutting(false);
			}
		},
		[t],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: clipRegions re-runs the check once the timeline has initialized its clips.
	useEffect(() => {
		const pendingPath = input.pendingFreshRecordingAutoCutPathRef.current;
		if (!pendingPath || loading || !isPreviewReady || duration <= 0) return;
		if (pendingPath !== videoSourcePath || !input.clipInitializedRef.current) return;
		input.pendingFreshRecordingAutoCutPathRef.current = null;
		void runAutoCut(mode, { fromUser: false });
	}, [
		loading,
		isPreviewReady,
		duration,
		videoSourcePath,
		mode,
		timeline.clipRegions,
		runAutoCut,
		input.pendingFreshRecordingAutoCutPathRef,
		input.clipInitializedRef,
	]);

	const applyAutoCut = useCallback(() => {
		void runAutoCut(latest.current.mode, { fromUser: true });
	}, [runAutoCut]);

	return { applyAutoCut, isAutoCutting };
}
