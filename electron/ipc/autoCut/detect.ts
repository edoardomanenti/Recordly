import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { detectSilenceIntervals, extractCaptionAudioSource } from "../captions/generate";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { normalizeVideoSourcePath } from "../utils";
import { type DetectedInterval, parseFreezeIntervals } from "./parse";

const execFileAsync = promisify(execFile);

export type AutoCutDetectionMode = "speech" | "activity";

/** Picture differences below this (ffmpeg `freezedetect` noise) count as a still screen. */
const FREEZE_NOISE_DB = -50;
/** Shortest still stretch (seconds) ffmpeg should report. */
const FREEZE_MIN_S = 1;

export interface SerializedInterval {
	startMs: number;
	/** `null` when the interval runs to the end of the media. */
	endMs: number | null;
}

function serialize(intervals: DetectedInterval[]): SerializedInterval[] {
	return intervals.map(({ startMs, endMs }) => ({
		startMs,
		endMs: Number.isFinite(endMs) ? endMs : null,
	}));
}

/** Silent stretches of the voice track (microphone sidecar first, then the recording). */
async function detectSilences(videoPath: string): Promise<SerializedInterval[]> {
	const ffmpegPath = getFfmpegBinaryPath();
	const wavPath = path.join(
		app.getPath("temp"),
		`recordly-autocut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
	);
	try {
		await extractCaptionAudioSource({ videoPath, ffmpegPath, wavPath });
		return serialize(await detectSilenceIntervals({ ffmpegPath, wavPath }));
	} finally {
		await fs.rm(wavPath, { force: true });
	}
}

/** Stretches where the recorded picture does not change. */
async function detectStillScreen(videoPath: string): Promise<SerializedInterval[]> {
	const { stderr } = await execFileAsync(
		getFfmpegBinaryPath(),
		[
			"-hide_banner",
			"-nostats",
			"-i",
			videoPath,
			"-map",
			"0:v:0",
			"-an",
			// Downscaled, low-rate frames are plenty to tell a still screen from activity.
			"-vf",
			`fps=10,scale=480:-2,freezedetect=n=${FREEZE_NOISE_DB}dB:d=${FREEZE_MIN_S}`,
			"-f",
			"null",
			"-",
		],
		{ timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 },
	);
	return serialize(parseFreezeIntervals(stderr ?? ""));
}

export async function detectAutoCutIntervals(options: {
	videoPath: string;
	mode: AutoCutDetectionMode;
}): Promise<SerializedInterval[]> {
	const videoPath = normalizeVideoSourcePath(options.videoPath);
	if (!videoPath) {
		throw new Error("Missing source video path.");
	}
	return options.mode === "speech" ? detectSilences(videoPath) : detectStillScreen(videoPath);
}
