#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const confirmationText = 'RUN ISOLATED TEST PLAYOUT';
const publicHost = process.env.TEST_HLS_PUBLIC_HOST || '144.91.124.112';
const port = Number(process.env.TEST_HLS_PORT || 18080);
const qcReportPath = process.env.QC_REPORT_PATH ||
  path.join(projectRoot, 'reports', 'ffprobe-qc-source-bumpers-2026-05-21T07-09-32-651Z.json');
const runId = process.env.RUN_ID || `diverse-ffconcat-normalized-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const programClipSeconds = Number(process.env.PROGRAM_CLIP_SECONDS || 180);
const bumperClipSeconds = Number(process.env.BUMPER_CLIP_SECONDS || 30);
const runDir = path.join(projectRoot, 'generated', 'test-playout', runId);
const hlsDir = path.join(runDir, 'hls');
const logsDir = path.join(runDir, 'logs');
const ffconcatPath = path.join(runDir, 'playlist.ffconcat');
const targetProfile = {
  width: 1280,
  height: 720,
  fps: 25,
  pixelFormat: 'yuv420p',
  audioSampleRate: 48000,
  audioChannels: 2,
  audioLayout: 'stereo',
};

const qc = JSON.parse(fs.readFileSync(qcReportPath, 'utf8'));
const files = qc.files.filter(file =>
  file &&
  file.errors?.length === 0 &&
  file.durationSeconds > 0 &&
  typeof file.path === 'string' &&
  fs.existsSync(file.path) &&
  file.video &&
  file.audio
);

const programs = [
  pick('source', ['Fahad Alkandari'], 'program', 90),
  pick('source', ['Nahla Abdallah'], 'program', 90),
  pick('source', ['kids/kessas/'], 'program', 90),
  pick('source', ['على الثغور'], 'program', 90),
  pick('source', ['series/001.mp4'], 'program', 90),
];
const bumpers = [
  pick('bumpers', ['logo-sting/k (3).mp4'], 'main', 3),
  pick('bumpers', ['sting-hag/LOGO DA-25.mp4'], 'seasonal', 3),
  pick('bumpers', ['general/AADAB ISLAMIA/MONAGAT SAIM-1.mp4'], 'general', 3),
  pick('bumpers', ['logo-sting/LOGO DA-2.mp4'], 'main', 3),
  pick('bumpers', ['general/AHADITH DAAWAH/AHADITH-12.mp4'], 'general', 3),
  pick('bumpers', ['general/DOAA/DOOAA-1.mp4'], 'general', 3),
  pick('bumpers', ['logo-sting/sting 01.mp4'], 'main', 3),
  pick('bumpers', ['sting-hag/LOGO DA-3.mp4'], 'seasonal', 3),
  pick('bumpers', ['general/CLIP DAAWAH/CLIP D-1.mp4'], 'general', 3),
  pick('bumpers', ['logo-sting/sting 02.mp4'], 'main', 3),
  pick('bumpers', ['general/جرافيك/ZAD-INFO003_1.mp4'], 'general', 3),
  pick('bumpers', ['general/CLEP/CLEP-1.mp4'], 'general', 3),
];

const sequence = [
  programItem(programs[0], 1),
  bumperItem(bumpers[0], 1), bumperItem(bumpers[1], 2), bumperItem(bumpers[2], 3),
  programItem(programs[1], 2),
  bumperItem(bumpers[3], 4), bumperItem(bumpers[4], 5), bumperItem(bumpers[5], 6),
  programItem(programs[2], 3),
  bumperItem(bumpers[6], 7), bumperItem(bumpers[7], 8), bumperItem(bumpers[8], 9),
  programItem(programs[3], 4),
  bumperItem(bumpers[9], 10), bumperItem(bumpers[10], 11), bumperItem(bumpers[11], 12),
  programItem(programs[4], 5),
].map((item, index) => ({ ...item, index }));

let cursor = 0;
for (const item of sequence) {
  item.expectedStartSeconds = cursor;
  item.expectedEndSeconds = cursor + item.playDurationSeconds;
  cursor = item.expectedEndSeconds;
}

const videoFilter = [
  `scale=${targetProfile.width}:${targetProfile.height}:force_original_aspect_ratio=decrease`,
  `pad=${targetProfile.width}:${targetProfile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
  `fps=${targetProfile.fps}`,
  `format=${targetProfile.pixelFormat}`,
  'setsar=1',
].join(',');
const audioFilter = [
  `aresample=${targetProfile.audioSampleRate}:async=1:first_pts=0`,
  `aformat=sample_fmts=fltp:sample_rates=${targetProfile.audioSampleRate}:channel_layouts=${targetProfile.audioLayout}`,
].join(',');
const ffmpegArgs = [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'info',
  '-re',
  '-fflags',
  '+genpts',
  '-f',
  'concat',
  '-safe',
  '0',
  '-i',
  ffconcatPath,
  '-vf',
  videoFilter,
  '-af',
  audioFilter,
  '-max_muxing_queue_size',
  '4096',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-r',
  String(targetProfile.fps),
  '-g',
  String(targetProfile.fps * 6),
  '-keyint_min',
  String(targetProfile.fps * 6),
  '-sc_threshold',
  '0',
  '-pix_fmt',
  targetProfile.pixelFormat,
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-ar',
  String(targetProfile.audioSampleRate),
  '-ac',
  String(targetProfile.audioChannels),
  '-f',
  'hls',
  '-hls_time',
  '6',
  '-hls_list_size',
  '12',
  '-hls_segment_filename',
  path.join(hlsDir, 'seg%05d.ts'),
  path.join(hlsDir, 'index.m3u8'),
];
const publicTestUrl = `http://${publicHost}:${port}/__test__/hls/${runId}/index.m3u8`;

fs.mkdirSync(hlsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
writeArtifacts();
writeController();

const controller = spawn(process.execPath, [path.join(runDir, 'controller.mjs')], {
  cwd: projectRoot,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, TEST_PLAYOUT_CONFIRMATION: confirmationText },
});
controller.unref();
fs.writeFileSync(path.join(runDir, 'controller.pid'), `${controller.pid}\n`, 'utf8');

console.log(JSON.stringify({
  runId,
  publicTestUrl,
  controllerPid: controller.pid,
  outputPath: hlsDir,
  logsDir,
  playlistPath: path.join(runDir, 'playlist.json'),
  manifestPath: path.join(runDir, 'manifest.csv'),
  commandPreviewPath: path.join(runDir, 'command-preview.json'),
  targetProfile,
  totalDurationSeconds: cursor,
}, null, 2));

function pick(root, includes, role, minDurationSeconds) {
  const lowerIncludes = includes.map(value => value.toLowerCase());
  const found = files.find(file => {
    if (file.root !== root) return false;
    if (file.path === '/srv/daawah/media/bumpers/general/CLEP/CLEP-9.MP4') return false;
    const haystack = `${file.relativePath || ''}\n${file.path}`.toLowerCase();
    return file.durationSeconds >= minDurationSeconds && lowerIncludes.every(value => haystack.includes(value));
  });
  if (!found) throw new Error(`Could not find ${role} media matching: ${includes.join(' / ')}`);
  return found;
}

function programItem(file, number) {
  return baseItem(file, 'program', 'program', `program-${number}`, Math.min(file.durationSeconds, programClipSeconds));
}

function bumperItem(file, number) {
  return baseItem(file, 'bumper', sourceRoleFromPath(file.relativePath), `bumper-${number}`, Math.min(file.durationSeconds, bumperClipSeconds));
}

function baseItem(file, type, sourceRole, id, playDurationSeconds) {
  return {
    id,
    type,
    sourceRole,
    title: path.basename(file.path),
    absolutePath: file.path,
    relativePath: file.relativePath,
    mediaRoot: file.root,
    originalDurationSeconds: file.durationSeconds,
    playDurationSeconds,
    normalizedRuntimeOnly: true,
    sourceVideo: file.video,
    sourceAudio: file.audio,
  };
}

function sourceRoleFromPath(relativePath) {
  if (relativePath.startsWith('logo-sting/')) return 'main';
  if (relativePath.startsWith('sting-hag/')) return 'seasonal';
  return 'general';
}

function writeArtifacts() {
  const playlist = {
    runId,
    generatedAt: new Date().toISOString(),
    mode: 'diverse-ffconcat-normalized-hls-test',
    qcReportPath,
    publicTestUrl,
    totalDurationSeconds: cursor,
    programCount: programs.length,
    bumperCount: bumpers.length,
    normalization: {
      enabled: true,
      runtimeOnly: true,
      mediaFilesModified: false,
      implementation: 'ffconcat demuxer with outpoint/duration plus single FFmpeg video/audio normalization filter',
      targetProfile,
      videoFilter,
      audioFilter,
    },
    mediaRootsUsed: ['/srv/daawah/media/source', '/srv/daawah/media/bumpers'],
    excludedPaths: ['/srv/daawah/media/original-ar', '/srv/daawah/media/bumpers/general/CLEP/CLEP-9.MP4'],
    items: sequence,
  };
  fs.writeFileSync(path.join(runDir, 'playlist.json'), `${JSON.stringify(playlist, null, 2)}\n`, 'utf8');
  fs.writeFileSync(ffconcatPath, renderFfconcat(sequence), 'utf8');
  fs.writeFileSync(path.join(runDir, 'manifest.csv'), renderManifest(sequence), 'utf8');
  fs.writeFileSync(path.join(runDir, 'command-preview.json'), `${JSON.stringify({
    runId,
    createdAt: new Date().toISOString(),
    confirmationText,
    executable: 'ffmpeg',
    args: ffmpegArgs,
    command: ['ffmpeg', ...ffmpegArgs.map(quoteArg)].join(' '),
    outputMode: 'test_http_hls',
    outputPath: hlsDir,
    publicTestUrl,
    normalization: playlist.normalization,
    willExecute: true,
    safety: {
      obsUsage: false,
      rtmpPush: false,
      streamKeyUsage: false,
      dnsChanges: false,
      productionDeploy: false,
      mediaWrites: false,
      mediaFilesModified: false,
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'report.md'), renderReport(playlist), 'utf8');
}

function writeController() {
  fs.writeFileSync(path.join(runDir, 'run-config.json'), `${JSON.stringify({
    runId,
    projectRoot,
    runDir,
    hlsDir,
    logsDir,
    port,
    startedAt: new Date().toISOString(),
    publicTestUrl,
    totalDurationSeconds: cursor,
    playlistItemCount: sequence.length,
    ffmpegArgs,
    items: sequence,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'controller.mjs'), controllerSource(), 'utf8');
}

function controllerSource() {
  return String.raw`
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'run-config.json'), 'utf8'));
const requiredConfirmation = 'RUN ISOLATED TEST PLAYOUT';
const paths = {
  runLog: path.join(config.logsDir, 'run.log'),
  ffmpegLog: path.join(config.logsDir, 'ffmpeg.log'),
  health: path.join(config.logsDir, 'health.jsonl'),
  asrun: path.join(config.logsDir, 'asrun.jsonl'),
  status: path.join(config.runDir, 'status.json'),
  runPid: path.join(config.runDir, 'run.pid'),
};
let ffmpeg = null;
let server = null;
let status = 'starting';
let exitCode = null;
let signal = null;
let healthTimer = null;
let stopping = false;
let maxOutputDirSize = 0;
const startedAtMs = Date.parse(config.startedAt);

function log(message) { fs.appendFileSync(paths.runLog, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8'); }
function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
  } catch {}
  return total;
}
function diskFree(targetPath) {
  try {
    const rows = execFileSync('df', ['-Pk', targetPath], { encoding: 'utf8' }).trim().split(/\n/);
    const cols = rows[rows.length - 1].trim().split(/\s+/);
    return { filesystem: cols[0], availableBytes: Number(cols[3]) * 1024, usedPercent: cols[4], mountedOn: cols.slice(5).join(' ') };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}
function newestSegment() {
  let newest = null;
  try {
    for (const name of fs.readdirSync(config.hlsDir)) {
      if (!name.endsWith('.ts')) continue;
      const full = path.join(config.hlsDir, name);
      const stat = fs.statSync(full);
      if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
    }
  } catch {}
  return newest;
}
function segmentCount() {
  try { return fs.readdirSync(config.hlsDir).filter(name => name.endsWith('.ts')).length; } catch { return 0; }
}
function processStats(pid) {
  if (!pid) return {};
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', '%cpu=,%mem=,rss='], { encoding: 'utf8' }).trim();
    if (!out) return {};
    const [cpu, mem, rss] = out.split(/\s+/);
    return { cpu_percent: Number(cpu), memory_percent: Number(mem), rss_kb: Number(rss) };
  } catch {
    return {};
  }
}
function errorSummary() {
  try {
    const out = execFileSync('grep', ['-Ein', 'Non-monoton|timestamp discontinuity|DTS|PTS|error|failed|invalid|corrupt|No such file|Permission denied|Past duration', paths.ffmpegLog], { encoding: 'utf8' });
    const lines = out.trim().split(/\n/).filter(Boolean);
    return { count: lines.length, last: lines.at(-1) || null, first20: lines.slice(0, 20) };
  } catch {
    return { count: 0, last: null, first20: [] };
  }
}
function currentItem() {
  const elapsed = Math.max(0, (Date.now() - startedAtMs) / 1000);
  return config.items.find(item => item.expectedStartSeconds <= elapsed && item.expectedEndSeconds > elapsed) || null;
}
function writeHealth() {
  const idx = path.join(config.hlsDir, 'index.m3u8');
  const newest = newestSegment();
  const size = dirSize(config.hlsDir);
  maxOutputDirSize = Math.max(maxOutputDirSize, size);
  const errors = errorSummary();
  const health = {
    timestamp: new Date().toISOString(),
    ffmpeg_pid: ffmpeg?.pid ?? null,
    ffmpeg_alive: !!ffmpeg?.pid && status === 'running',
    current_item: currentItem(),
    hls_index_exists: fs.existsSync(idx),
    hls_index_mtime: fs.existsSync(idx) ? fs.statSync(idx).mtime.toISOString() : null,
    hls_segment_count: segmentCount(),
    newest_segment: newest?.name ?? null,
    newest_segment_mtime: newest?.mtime ?? null,
    output_dir_size: size,
    disk_free: diskFree(config.projectRoot),
    ...processStats(ffmpeg?.pid),
    error_count_so_far: errors.count,
    last_error_line: errors.last,
  };
  fs.appendFileSync(paths.health, JSON.stringify(health) + '\n', 'utf8');
  fs.writeFileSync(paths.status, JSON.stringify({
    runId: config.runId,
    publicTestUrl: config.publicTestUrl,
    currentStatus: status,
    startedAt: config.startedAt,
    totalDurationSeconds: config.totalDurationSeconds,
    playlistItemCount: config.playlistItemCount,
    hlsSegmentCount: health.hls_segment_count,
    ffmpegPid: ffmpeg?.pid ?? null,
    currentItem: health.current_item,
    lastHealthCheck: health.timestamp,
    ffmpegExitCode: exitCode,
    ffmpegSignal: signal,
    maxOutputDirSize,
    errors: errors.first20,
    warnings: [],
    logPaths: { runLog: paths.runLog, ffmpegLog: paths.ffmpegLog, health: paths.health, asrun: paths.asrun },
  }, null, 2) + '\n', 'utf8');
}
function contentType(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.ts')) return 'video/mp2t';
  return 'application/octet-stream';
}
function startServer() {
  const prefix = '/__test__/hls/' + config.runId + '/';
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('not found'); return; }
    const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.m3u8';
    const full = path.resolve(config.hlsDir, rel);
    const base = path.resolve(config.hlsDir);
    if (full !== base && !full.startsWith(base + path.sep)) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end('forbidden'); return; }
    if (!fs.existsSync(full)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : 'not found'); return; }
    res.writeHead(200, { 'content-type': contentType(full), 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  });
  server.listen(config.port, '0.0.0.0', () => log('test HLS server listening on ' + config.port + ' for ' + config.publicTestUrl));
}
async function finalize() {
  const errors = errorSummary();
  fs.writeFileSync(path.join(config.runDir, 'final-report.md'), [
    '# Diverse FFconcat Normalized HLS Test Final Report',
    '',
    '- runId: ' + config.runId,
    '- status: ' + status,
    '- public URL: ' + config.publicTestUrl,
    '- ffmpeg exit: ' + exitCode,
    '- signal: ' + (signal || 'none'),
    '- segments: ' + segmentCount(),
    '- max output bytes: ' + maxOutputDirSize,
    '- error count: ' + errors.count,
    '',
  ].join('\n'), 'utf8');
  if (server) await new Promise(resolve => server.close(resolve));
  process.exit(status === 'failed' ? 1 : 0);
}
function startFfmpeg() {
  const logStream = fs.createWriteStream(paths.ffmpegLog, { flags: 'a' });
  ffmpeg = spawn('ffmpeg', config.ffmpegArgs, { cwd: config.projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(paths.runPid, String(ffmpeg.pid) + '\n', 'utf8');
  status = 'running';
  log('ffmpeg started pid=' + ffmpeg.pid);
  for (const item of config.items) fs.appendFileSync(paths.asrun, JSON.stringify({ event: 'expected_item', ...item }) + '\n', 'utf8');
  ffmpeg.stdout.pipe(logStream);
  ffmpeg.stderr.pipe(logStream);
  writeHealth();
  healthTimer = setInterval(writeHealth, 10000);
  ffmpeg.on('close', async (code, closeSignal) => {
    exitCode = code;
    signal = closeSignal;
    status = code === 0 ? 'completed' : (stopping ? 'stopped' : 'failed');
    log('ffmpeg exited code=' + code + ' signal=' + (closeSignal || 'none'));
    if (healthTimer) clearInterval(healthTimer);
    writeHealth();
    await finalize();
  });
  ffmpeg.on('error', async error => {
    status = 'failed';
    log('ffmpeg spawn error: ' + (error?.stack || error));
    if (healthTimer) clearInterval(healthTimer);
    writeHealth();
    await finalize();
  });
}
function stop(signalName) {
  if (stopping) return;
  stopping = true;
  status = 'stopping';
  log('received ' + signalName + '; stopping ffmpeg cleanly');
  writeHealth();
  if (ffmpeg?.pid) ffmpeg.kill('SIGTERM');
  else finalize();
}

fs.mkdirSync(config.hlsDir, { recursive: true });
fs.mkdirSync(config.logsDir, { recursive: true });
log('controller starting pid=' + process.pid);
if (process.env.TEST_PLAYOUT_CONFIRMATION !== requiredConfirmation) {
  status = 'failed';
  log('required confirmation text missing');
  writeHealth();
  process.exit(3);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
startServer();
startFfmpeg();
`;
}

function renderFfconcat(items) {
  return `ffconcat version 1.0\n${items.map(item => `file '${item.absolutePath.replace(/'/g, `'\\''`)}'\noutpoint ${item.playDurationSeconds.toFixed(3)}\nduration ${item.playDurationSeconds.toFixed(3)}`).join('\n')}\n`;
}

function renderManifest(items) {
  const rows = ['index,type,sourceRole,expectedStartSeconds,expectedEndSeconds,playDurationSeconds,mediaRoot,relativePath,absolutePath,sourceVideo,sourceAudio'];
  for (const item of items) {
    rows.push([
      item.index,
      item.type,
      item.sourceRole,
      item.expectedStartSeconds.toFixed(3),
      item.expectedEndSeconds.toFixed(3),
      item.playDurationSeconds.toFixed(3),
      item.mediaRoot,
      csv(item.relativePath),
      csv(item.absolutePath),
      csv(`${item.sourceVideo.codec} ${item.sourceVideo.width}x${item.sourceVideo.height} ${item.sourceVideo.rFrameRate}`),
      csv(`${item.sourceAudio.codec} ${item.sourceAudio.sampleRate}Hz ${item.sourceAudio.channels}ch`),
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function renderReport(playlist) {
  return `# Diverse FFconcat Normalized HLS Test Start Report

- runId: ${runId}
- public test URL: ${publicTestUrl}
- total planned seconds: ${cursor.toFixed(3)}
- programs: ${programs.length}
- bumpers: ${bumpers.length}
- output path: ${hlsDir}
- logs path: ${logsDir}

## Runtime Normalization

- enabled: true
- media files modified: false
- target resolution: ${targetProfile.width}x${targetProfile.height}
- target fps: ${targetProfile.fps}
- target pixel format: ${targetProfile.pixelFormat}
- target audio: ${targetProfile.audioSampleRate} Hz stereo
- implementation: single FFmpeg ffconcat demuxer with video/audio normalization filters

## Sequence

${playlist.items.map(item => `- ${item.index}: ${item.type}/${item.sourceRole} ${item.playDurationSeconds.toFixed(3)}s ${item.absolutePath}`).join('\n')}
`;
}

function csv(value) {
  const raw = String(value ?? '');
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function quoteArg(value) {
  return /^[A-Za-z0-9_./:=+\-[\]]+$/.test(value) ? value : JSON.stringify(value);
}
