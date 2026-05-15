import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { ensureDir, walkDir, isImageFile } from '../utils/fileUtils';

const execFileAsync = promisify(execFile);

export interface LogoConversionResult {
  outputPath: string;
  frameCount: number;
  fps: number;
  durationSec: number;
}

export async function convertLogoSequenceToWebm(
  sourcePath: string,
  fps = 25,
  outputPath?: string
): Promise<LogoConversionResult> {
  const pngFiles = walkDir(sourcePath, isImageFile)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort();

  if (pngFiles.length === 0) {
    throw new Error(`No PNG files found in ${sourcePath}`);
  }

  const outPath = outputPath ?? path.join(config.paths.assets, 'overlays', 'logo', 'logo-loop.webm');
  ensureDir(path.dirname(outPath));

  const firstFile = pngFiles[0]!;
  const dir = path.dirname(firstFile);
  const ext = path.extname(firstFile);
  const basename = path.basename(firstFile, ext);

  // Detect zero-padding length
  const digitMatch = basename.match(/(\d+)$/);
  const padLen = digitMatch ? digitMatch[1]!.length : 1;
  const prefix = digitMatch ? basename.slice(0, basename.length - digitMatch[1]!.length) : basename;

  const inputPattern = path.join(dir, `${prefix}%0${padLen}d${ext}`);

  logger.info(`Converting ${pngFiles.length} PNG frames @ ${fps}fps → ${outPath}`);

  const args = [
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '10',
    '-auto-alt-ref', '0',
    '-pix_fmt', 'yuva420p',
    '-loop', '0',
    '-an',
    outPath,
  ];

  try {
    await execFileAsync(config.ffmpeg.ffmpegPath, args, { timeout: 600000 });
  } catch (err) {
    throw new Error(`Logo WebM conversion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stat = fs.statSync(outPath);
  const durationSec = pngFiles.length / fps;
  logger.info(`Logo WebM created: ${outPath} (${stat.size} bytes, ${durationSec.toFixed(2)}s)`);

  return {
    outputPath: outPath,
    frameCount: pngFiles.length,
    fps,
    durationSec,
  };
}

export async function convertSingleLogoToWebm(
  pngPath: string,
  durationSec = 5,
  outputPath?: string
): Promise<LogoConversionResult> {
  if (!fs.existsSync(pngPath)) throw new Error(`PNG not found: ${pngPath}`);

  const outPath = outputPath ?? path.join(config.paths.assets, 'overlays', 'logo', 'logo-loop.webm');
  ensureDir(path.dirname(outPath));

  const args = [
    '-y',
    '-loop', '1',
    '-t', String(durationSec),
    '-i', pngPath,
    '-c:v', 'libvpx-vp9',
    '-b:v', '0',
    '-crf', '10',
    '-auto-alt-ref', '0',
    '-pix_fmt', 'yuva420p',
    '-loop', '0',
    '-an',
    outPath,
  ];

  await execFileAsync(config.ffmpeg.ffmpegPath, args, { timeout: 120000 });
  logger.info(`Single logo PNG → WebM: ${outPath}`);

  return { outputPath: outPath, frameCount: 1, fps: 1, durationSec };
}
