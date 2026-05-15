import { spawn } from 'child_process';
import path from 'path';
import { getDb } from '../db/schema';
import { config } from '../config';
import { logger } from '../utils/logger';
import { broadcastWs } from '../ws';
import { sendAlert } from '../monitoring';

interface TranscodeJob {
  id: string;
  media_file_id: string;
  status: string;
  priority: number;
}

interface MediaFile {
  id: string;
  path: string;
  filename: string;
}

let isRunning = false;

export function startTranscodeWorker(): void {
  // Check for pending jobs every 30 seconds
  setInterval(() => {
    if (!isRunning) {
      void processNextJob();
    }
  }, 30000);

  logger.info('Transcode worker started');
}

export async function processNextJob(): Promise<void> {
  if (isRunning) return;

  const db = getDb();
  const job = db.prepare(`
    SELECT * FROM transcode_jobs WHERE status='pending' ORDER BY priority ASC, created_at ASC LIMIT 1
  `).get() as TranscodeJob | undefined;

  if (!job) return;

  isRunning = true;

  const media = db.prepare('SELECT * FROM media_files WHERE id=?').get(job.media_file_id) as MediaFile | undefined;
  if (!media) {
    db.prepare('UPDATE transcode_jobs SET status=?, error_msg=? WHERE id=?')
      .run('error', 'Media file not found', job.id);
    isRunning = false;
    return;
  }

  const outputDir  = path.dirname(media.path);
  const outputName = `${path.basename(media.filename, path.extname(media.filename))}_broadcast.mp4`;
  const outputPath = path.join(outputDir, outputName);

  const [w, h] = config.broadcast.resolution.split('x');

  const args = [
    '-y',
    '-i', media.path,
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${config.broadcast.fps}`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', config.broadcast.audioBitrate,
    '-ar', String(config.broadcast.audioRate),
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];

  db.prepare('UPDATE transcode_jobs SET status=?, started_at=datetime(\'now\'), ffmpeg_cmd=?, output_path=? WHERE id=?')
    .run('running', args.join(' '), outputPath, job.id);
  db.prepare('UPDATE media_files SET status=\'pending\' WHERE id=?').run(media.id);

  broadcastWs({ type: 'transcode_start', data: { jobId: job.id, file: media.filename } });
  logger.info(`Transcoding: ${media.filename} → ${outputName}`);

  const ffmpeg = spawn(config.ffmpeg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let progress = 0;
  let duration = 0;

  ffmpeg.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();

    // Parse duration
    const durMatch = /Duration:\s*(\d+):(\d+):(\d+)/.exec(text);
    if (durMatch && duration === 0) {
      duration = parseInt(durMatch[1]!) * 3600 + parseInt(durMatch[2]!) * 60 + parseInt(durMatch[3]!);
    }

    // Parse progress time
    const timeMatch = /time=(\d+):(\d+):(\d+)/.exec(text);
    if (timeMatch && duration > 0) {
      const elapsed = parseInt(timeMatch[1]!) * 3600 + parseInt(timeMatch[2]!) * 60 + parseInt(timeMatch[3]!);
      progress = Math.min(99, Math.round((elapsed / duration) * 100));
      db.prepare('UPDATE transcode_jobs SET progress=? WHERE id=?').run(progress, job.id);
      broadcastWs({ type: 'transcode_progress', data: { jobId: job.id, progress } });
    }
  });

  ffmpeg.on('close', async (code) => {
    isRunning = false;

    if (code === 0) {
      db.prepare('UPDATE transcode_jobs SET status=\'done\', progress=100, finished_at=datetime(\'now\') WHERE id=?').run(job.id);
      db.prepare('UPDATE media_files SET path=?, filename=?, status=\'ready\', scanned_at=datetime(\'now\') WHERE id=?')
        .run(outputPath, outputName, media.id);

      broadcastWs({ type: 'transcode_complete', data: { jobId: job.id, outputPath } });
      logger.info(`Transcode complete: ${outputName}`);
    } else {
      const errMsg = `FFmpeg exited with code ${code}`;
      db.prepare('UPDATE transcode_jobs SET status=\'error\', error_msg=?, finished_at=datetime(\'now\') WHERE id=?')
        .run(errMsg, job.id);
      db.prepare('UPDATE media_files SET status=\'needs_transcode\' WHERE id=?').run(media.id);

      broadcastWs({ type: 'transcode_error', data: { jobId: job.id, error: errMsg } });
      logger.error(`Transcode failed: ${media.filename} — ${errMsg}`);

      await sendAlert('Transcode Failed', `File: ${media.filename}\nError: ${errMsg}`, 'warning');
    }
  });

  ffmpeg.on('error', async (err) => {
    isRunning = false;
    db.prepare('UPDATE transcode_jobs SET status=\'error\', error_msg=? WHERE id=?').run(err.message, job.id);
    logger.error(`Transcode process error: ${err.message}`);
    await sendAlert('Transcode Process Error', err.message, 'error');
  });
}

export async function cancelTranscodeJob(jobId: string): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE transcode_jobs SET status=\'cancelled\' WHERE id=? AND status=\'pending\'').run(jobId);
  logger.info(`Transcode job cancelled: ${jobId}`);
}

export function getTranscodeQueue() {
  const db = getDb();
  return db.prepare(`
    SELECT tj.*, mf.filename, mf.path
    FROM transcode_jobs tj
    JOIN media_files mf ON tj.media_file_id = mf.id
    WHERE tj.status IN ('pending','running')
    ORDER BY tj.priority ASC, tj.created_at ASC
  `).all();
}
