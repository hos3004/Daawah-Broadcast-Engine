import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  duration_sec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  pixel_format: string | null;
  bitrate: number | null;
  audio_rate: number | null;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  bit_rate?: string;
  sample_rate?: string;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

export async function probeFile(filePath: string): Promise<ProbeResult> {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ];

  let stdout: string;
  try {
    const result = await execFileAsync(config.ffmpeg.ffprobePath, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffprobe failed for "${filePath}": ${msg}`);
  }

  let data: FfprobeOutput;
  try {
    data = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new Error(`ffprobe returned invalid JSON for "${filePath}"`);
  }

  const videoStream = data.streams.find(s => s.codec_type === 'video');
  const audioStream = data.streams.find(s => s.codec_type === 'audio');

  const durationStr = data.format.duration;
  const duration_sec = durationStr ? parseFloat(durationStr) : 0;

  const fps = videoStream?.r_frame_rate ? parseFps(videoStream.r_frame_rate)
    : videoStream?.avg_frame_rate ? parseFps(videoStream.avg_frame_rate) : null;

  const bitrate = data.format.bit_rate ? parseInt(data.format.bit_rate, 10) : null;
  const audio_rate = audioStream?.sample_rate ? parseInt(audioStream.sample_rate, 10) : null;

  return {
    duration_sec,
    width:        videoStream?.width ?? null,
    height:       videoStream?.height ?? null,
    fps,
    video_codec:  videoStream?.codec_name ?? null,
    audio_codec:  audioStream?.codec_name ?? null,
    pixel_format: videoStream?.pix_fmt ?? null,
    bitrate,
    audio_rate,
  };
}

function parseFps(fpsStr: string): number | null {
  if (!fpsStr || fpsStr === '0/0') return null;
  if (fpsStr.includes('/')) {
    const [num, den] = fpsStr.split('/').map(Number);
    if (!den || den === 0) return null;
    return Math.round((num! / den) * 100) / 100;
  }
  const n = parseFloat(fpsStr);
  return isNaN(n) ? null : n;
}

export async function checkFfprobe(): Promise<boolean> {
  try {
    await execFileAsync(config.ffmpeg.ffprobePath, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function checkFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync(config.ffmpeg.ffmpegPath, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
