/**
 * FFmpeg filter helpers for normalising media before playout.
 *
 * Resolution  → scale + pad to target, preserving aspect ratio
 * FPS         → fps filter + setpts/settb to enforce CFR timestamps
 * Audio       → aresample + asetpts, aformat to packed stereo (fltp)
 *
 * Audio mapping uses -map 0:a? at call-site so missing-audio clips
 * are handled gracefully (silence gap filled by downstream mux).
 */

export interface VideoNormOpts {
  width: number;
  height: number;
  fps: number;
}

export interface AudioNormOpts {
  audioRate: number;
}

export interface OverlaySpec {
  logoPath?: string | null;
  logoPosition?: string;
  tickerPath?: string | null;
  tickerY?: number;
}

export interface FilterComplexResult {
  extraInputArgs: string[];
  filterComplex: string;
  videoLabel: string;
}

/**
 * Returns a -vf string that normalises a single video stream:
 *   scale → pad → setsar → fps → setpts → settb
 */
export function buildVideoNormVf(video: VideoNormOpts): string {
  const { width: w, height: h, fps } = video;
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${fps}`,
    `setpts=N/(${fps}*TB)`,
    `settb=1/${fps}`,
  ].join(',');
}

/**
 * Returns an -af string: resample to target rate, reset audio timestamps, packed stereo.
 * Safe to apply even when source already matches target.
 */
export function buildAudioNormAf(audio: AudioNormOpts): string {
  return `aresample=${audio.audioRate}:first_pts=0,asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo`;
}

/**
 * Builds a filter_complex string that:
 *   1. Normalises video (scale/pad/fps/setpts/settb)
 *   2. Optionally overlays a logo WebM (with stream_loop -1)
 *   3. Optionally overlays a ticker WebM at tickerY
 *
 * Audio is NOT included — keep it on a separate -af chain or
 * handle via -map 0:a? so clips without audio skip cleanly.
 *
 * @param concatInputIdx  index of the concat/main video input (usually 0)
 * @param video           target resolution and fps
 * @param overlays        optional logo and ticker WebM paths
 */
export function buildOverlayFilterComplex(
  concatInputIdx: number,
  video: VideoNormOpts,
  overlays: OverlaySpec = {}
): FilterComplexResult {
  const { width: w, height: h } = video;
  const normVf = buildVideoNormVf(video);
  const parts: string[] = [];
  const extraInputArgs: string[] = [];
  let nextIdx = concatInputIdx + 1;

  parts.push(`[${concatInputIdx}:v]${normVf}[base_v]`);
  let vLabel = '[base_v]';

  if (overlays.logoPath) {
    const pos = overlays.logoPosition ?? '10:10';
    extraInputArgs.push('-stream_loop', '-1', '-i', overlays.logoPath);
    parts.push(`${vLabel}[${nextIdx}:v]overlay=${pos}:shortest=0[logo_v]`);
    vLabel = '[logo_v]';
    nextIdx++;
  }

  if (overlays.tickerPath) {
    const ty = overlays.tickerY ?? (h - 70);
    extraInputArgs.push('-stream_loop', '-1', '-i', overlays.tickerPath);
    parts.push(`${vLabel}[${nextIdx}:v]overlay=0:${ty}:shortest=0[ticker_v]`);
    vLabel = '[ticker_v]';
  }

  return { extraInputArgs, filterComplex: parts.join(';'), videoLabel: vLabel };
}
