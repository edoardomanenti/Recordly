import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { type AutoCutMode, applyAutoCutToClips, computeAutoCutRemovals } from "../autoCut";
import { rippleRegionAnchors, rippleRegions } from "../clipSequence";
import type { useTimelineState } from "../state/useTimelineState";
import { getClipSourceEndMs, getClipSourceStartMs } from "../types";

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
		async (cutMode: AutoCutMode) => {
			const sourcePath = latest.current.videoSourcePath;
			const totalMs = Math.round(latest.current.duration * 1000);
			if (cutMode === "off" || !sourcePath || totalMs <= 0 || busyRef.current) return;
			const hasClips = () =>
				latest.current.clipInitializedRef.current &&
				latest.current.timeline.clipRegions.length > 0;
			if (!hasClips()) return;

			busyRef.current = true;
			setIsAutoCutting(true);
			toast.info(t("settings.autoCut.applying", "Cutting…"));
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
				// The user may have switched recordings meanwhile.
				if (latest.current.videoSourcePath !== sourcePath || !hasClips()) return;

				const removals = computeAutoCutRemovals({
					mode: cutMode,
					totalMs,
					intervals: detection.intervals ?? [],
					cursorTelemetry: telemetry?.success ? telemetry.samples : [],
				});
				console.info(
					`[auto-cut] ${cutMode}: ${detection.intervals?.length ?? 0} detected stretches, ${removals.length} cuts`,
				);
				// Cut inside the clips already on the timeline, keeping the user's edits.
				const current = latest.current;
				const before = current.timeline.clipRegions;
				const { split, packed, changed } = applyAutoCutToClips(
					before,
					removals,
					() => `clip-${current.nextClipIdRef.current++}`,
				);
				if (!changed) {
					toast.info(
						t("settings.autoCut.nothingToCut", "Auto-cut found nothing to remove."),
					);
					return;
				}
				// A cut full track must no longer stretch with the duration.
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

				const timelineMs = (clips: typeof before) =>
					clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0);
				const removedSeconds = Math.round((timelineMs(before) - timelineMs(packed)) / 1000);
				toast.success(
					t(
						"settings.autoCut.applied",
						"Auto-cut removed {{count}} dead moments ({{seconds}}s). Press Undo to restore them.",
						{
							count: removals.filter((cut) =>
								before.some(
									(clip) =>
										cut.startMs < getClipSourceEndMs(clip) &&
										cut.endMs > getClipSourceStartMs(clip),
								),
							).length,
							seconds: removedSeconds,
						},
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
		void runAutoCut(mode);
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
		void runAutoCut(latest.current.mode);
	}, [runAutoCut]);

	return { applyAutoCut, isAutoCutting };
}
