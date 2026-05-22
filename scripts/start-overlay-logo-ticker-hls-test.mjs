#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicHost = process.env.TEST_HLS_PUBLIC_HOST || '144.91.124.112';
const port = Number(process.env.TEST_HLS_PORT || 18081);
const runId = process.env.RUN_ID || `overlay-logo-ticker-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runDir = path.join(projectRoot, 'generated', 'test-playout', runId);
const hlsDir = path.join(runDir, 'hls');
const logsDir = path.join(runDir, 'logs');
const assetsDir = path.join(runDir, 'assets');
const sourceRunId = process.env.SOURCE_RUN_ID || findLatestSourceRun();
const sourcePlaylistPath = path.join(projectRoot, 'generated', 'test-playout', sourceRunId, 'playlist.json');
const sourcePlaylist = JSON.parse(fs.readFileSync(sourcePlaylistPath, 'utf8'));
const mediaPath = process.env.TEST_OVERLAY_MEDIA_PATH || sourcePlaylist.items[0].absolutePath;
const fontFile = process.env.TEST_OVERLAY_FONT_FILE || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const fontFamily = process.env.TEST_OVERLAY_FONT_FAMILY || 'DejaVu Sans';
const durationSeconds = Number(process.env.TEST_OVERLAY_SECONDS || 1800);
const logoPath = path.join(assetsDir, 'logo.png');
const tickerAssPath = path.join(assetsDir, 'ticker.ass');
const publicTestUrl = `http://${publicHost}:${port}/__test__/hls/${runId}/index.m3u8`;

fs.mkdirSync(hlsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

if (!fs.existsSync(mediaPath)) throw new Error(`Media not found: ${mediaPath}`);
if (!fs.existsSync(fontFile)) throw new Error(`Font not found: ${fontFile}`);
assertPortFree(port);
generateLogo();
fs.writeFileSync(tickerAssPath, renderTickerAss(), 'utf8');

const filterComplex = [
  `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p,setsar=1,subtitles=${tickerAssPath}:fontsdir=/usr/share/fonts/truetype/dejavu[vbase]`,
  '[1:v]format=rgba,colorchannelmixer=aa=0.88,scale=170:-1[vlogo]',
  '[vbase][vlogo]overlay=W-w-35:35[vout]',
  '[0:a]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]',
].join(';');

const ffmpegArgs = [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'info',
  '-stream_loop',
  '-1',
  '-re',
  '-i',
  mediaPath,
  '-loop',
  '1',
  '-i',
  logoPath,
  '-t',
  String(durationSeconds),
  '-filter_complex',
  filterComplex,
  '-map',
  '[vout]',
  '-map',
  '[aout]',
  '-max_muxing_queue_size',
  '4096',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '23',
  '-r',
  '25',
  '-g',
  '150',
  '-keyint_min',
  '150',
  '-sc_threshold',
  '0',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-ar',
  '48000',
  '-ac',
  '2',
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

writeArtifacts();
writeController();

const controller = spawn(process.execPath, [path.join(runDir, 'controller.mjs')], {
  cwd: projectRoot,
  detached: true,
  stdio: 'ignore',
});
controller.unref();
fs.writeFileSync(path.join(runDir, 'controller.pid'), `${controller.pid}\n`, 'utf8');

console.log(JSON.stringify({
  runId,
  publicTestUrl,
  controllerPid: controller.pid,
  outputPath: hlsDir,
  logsDir,
  logoPath,
  tickerAssPath,
  mediaPath,
  sourceRunId,
  port,
}, null, 2));

function findLatestSourceRun() {
  const base = path.join(projectRoot, 'generated', 'test-playout');
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('diverse-realtime-filter-normalized-'))
    .map(entry => ({
      name: entry.name,
      playlist: path.join(base, entry.name, 'playlist.json'),
      mtime: fs.statSync(path.join(base, entry.name)).mtimeMs,
    }))
    .filter(entry => fs.existsSync(entry.playlist))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates[0]) throw new Error('No diverse realtime source run with playlist.json was found.');
  return candidates[0].name;
}

function assertPortFree(value) {
  try {
    execFileSync('bash', ['-lc', `ss -ltnp | grep -q ':${value}'`], { stdio: 'ignore' });
    throw new Error(`Port ${value} is already in use.`);
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
}

function generateLogo() {
  const setupLog = path.join(logsDir, 'setup.log');
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-f',
    'lavfi',
    '-i',
    'color=c=black@0.0:s=320x110:d=1,format=rgba',
    '-vf',
    [
      'drawbox=x=0:y=0:w=320:h=110:color=black@0.42:t=fill',
      'drawbox=x=3:y=3:w=314:h=104:color=white@0.65:t=2',
      `drawtext=fontfile=${fontFile}:text=DAAWAH:fontcolor=white:fontsize=42:x=28:y=20`,
      `drawtext=fontfile=${fontFile}:text=TEST:fontcolor=0xF6D365:fontsize=24:x=202:y=62`,
    ].join(','),
    '-frames:v',
    '1',
    logoPath,
  ];
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', fs.openSync(setupLog, 'a'), fs.openSync(setupLog, 'a')] });
  } catch (error) {
    throw new Error(`Logo generation failed; see ${setupLog}: ${error.message}`);
  }
}

function renderTickerAss() {
  const tickerText = 'تشاهدون اليوم: 08:00 خطوات النبي • 09:30 أعمال الحج • 11:00 كليب أطفال • 12:30 السيرة النبوية • 14:00 تشريف الأمة';
  let events = '';
  for (let start = 0; start < durationSeconds; start += 50) {
    events += `Dialogue: 0,${assTime(start)},${assTime(start + 45)},Ticker,,0,0,0,,{\\an6\\move(1320,675,-2850,675,0,45000)}${tickerText}\n`;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Ticker,${fontFamily},34,&H00FFFFFF,&H000000FF,&HAA000000,&HAA000000,0,0,0,0,100,100,0,0,3,1,0,2,30,30,24,1
Style: Label,${fontFamily},34,&H00FFFFFF,&H000000FF,&H88008CD2,&H88008CD2,1,0,0,0,100,100,0,0,3,1,0,3,30,30,24,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 1,0:00:00.00,${assTime(durationSeconds)},Label,,0,0,0,,{\\an3\\pos(1240,675)}تشاهدون اليوم
${events}`;
}

function assTime(seconds) {
  const centiseconds = Math.floor((seconds % 1) * 100);
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function writeArtifacts() {
  fs.writeFileSync(path.join(runDir, 'command-preview.json'), `${JSON.stringify({
    runId,
    publicTestUrl,
    mediaPath,
    logoPath,
    tickerAssPath,
    sourceRunId,
    port,
    ffmpegArgs,
    safety: {
      production: false,
      obs: false,
      rtmp: false,
      streamKeys: false,
      mediaWrites: false,
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'overlay-manifest.json'), `${JSON.stringify({
    runId,
    publicTestUrl,
    logo: { enabled: true, path: logoPath, position: 'top-right', opacity: 0.88 },
    ticker: { enabled: true, path: tickerAssPath, type: 'ass', language: 'ar', position: 'bottom' },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify({
    runId,
    publicTestUrl,
    currentStatus: 'starting',
    startedAt: new Date().toISOString(),
    port,
    logPaths: logPaths(),
  }, null, 2)}\n`, 'utf8');
}

function writeController() {
  fs.writeFileSync(path.join(runDir, 'controller.mjs'), controllerSource(), 'utf8');
}

function controllerSource() {
  return String.raw`
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn, execFileSync } from 'child_process';

const config = ${JSON.stringify({ runId, runDir, hlsDir, logsDir, port, publicTestUrl, ffmpegArgs }, null, 2)};
const paths = {
  runLog: path.join(config.logsDir, 'run.log'),
  ffmpegLog: path.join(config.logsDir, 'ffmpeg.log'),
  health: path.join(config.logsDir, 'health.jsonl'),
  runPid: path.join(config.runDir, 'run.pid'),
  status: path.join(config.runDir, 'status.json'),
};
let ffmpeg = null;
let server = null;
let status = 'starting';
let stopping = false;

function log(message) {
  fs.appendFileSync(paths.runLog, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
}
function segmentCount() {
  try { return fs.readdirSync(config.hlsDir).filter(name => name.endsWith('.ts')).length; } catch { return 0; }
}
function newestSegment() {
  try {
    return fs.readdirSync(config.hlsDir)
      .filter(name => name.endsWith('.ts'))
      .map(name => ({ name, stat: fs.statSync(path.join(config.hlsDir, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0] || null;
  } catch {
    return null;
  }
}
function errorSummary() {
  try {
    const out = execFileSync('grep', ['-Ein', 'Non-monoton|timestamp discontinuity|DTS|PTS|sample rate|channel layout|invalid|dropping|Past duration|corrupt|error|failed', paths.ffmpegLog], { encoding: 'utf8' });
    const lines = out.trim().split(/\n/).filter(Boolean);
    return { count: lines.length, last: lines.at(-1) || null, first20: lines.slice(0, 20) };
  } catch {
    return { count: 0, last: null, first20: [] };
  }
}
function writeHealth() {
  const indexPath = path.join(config.hlsDir, 'index.m3u8');
  const newest = newestSegment();
  const errors = errorSummary();
  const health = {
    timestamp: new Date().toISOString(),
    ffmpeg_pid: ffmpeg?.pid || null,
    ffmpeg_alive: !!ffmpeg?.pid && status === 'running',
    hls_index_exists: fs.existsSync(indexPath),
    hls_index_mtime: fs.existsSync(indexPath) ? fs.statSync(indexPath).mtime.toISOString() : null,
    hls_segment_count: segmentCount(),
    newest_segment: newest?.name || null,
    newest_segment_mtime: newest?.stat?.mtime?.toISOString() || null,
    error_count_so_far: errors.count,
    last_error_line: errors.last,
  };
  fs.appendFileSync(paths.health, JSON.stringify(health) + '\n', 'utf8');
  fs.writeFileSync(paths.status, JSON.stringify({
    runId: config.runId,
    publicTestUrl: config.publicTestUrl,
    currentStatus: status,
    ffmpegPid: ffmpeg?.pid || null,
    lastHealthCheck: health.timestamp,
    hlsSegmentCount: health.hls_segment_count,
    errors: errors.first20,
    logPaths: paths,
  }, null, 2) + '\n', 'utf8');
}
function startServer() {
  const prefix = '/__test__/hls/' + config.runId + '/';
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('not found'); return; }
    const rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.m3u8';
    const full = path.resolve(config.hlsDir, rel);
    const base = path.resolve(config.hlsDir);
    if (full !== base && !full.startsWith(base + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(full)) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : 'not found'); return; }
    res.writeHead(200, { 'content-type': full.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : full.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  });
  server.listen(config.port, '0.0.0.0', () => log('overlay test server listening on ' + config.port));
}
function startFfmpeg() {
  const logStream = fs.createWriteStream(paths.ffmpegLog, { flags: 'a' });
  ffmpeg = spawn('ffmpeg', config.ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg.stdout.pipe(logStream);
  ffmpeg.stderr.pipe(logStream);
  fs.writeFileSync(paths.runPid, String(ffmpeg.pid) + '\n', 'utf8');
  status = 'running';
  log('ffmpeg started pid=' + ffmpeg.pid);
  writeHealth();
  setInterval(writeHealth, 10000);
  ffmpeg.on('close', code => {
    status = stopping ? 'stopped' : (code === 0 ? 'completed' : 'failed');
    log('ffmpeg exited code=' + code);
    writeHealth();
    server?.close(() => process.exit(code === 0 || stopping ? 0 : 1));
  });
}
function stop(signalName) {
  if (stopping) return;
  stopping = true;
  status = 'stopping';
  log('received ' + signalName);
  writeHealth();
  ffmpeg?.kill('SIGTERM');
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
startServer();
startFfmpeg();
`;
}

function logPaths() {
  return {
    runLog: path.join(logsDir, 'run.log'),
    ffmpegLog: path.join(logsDir, 'ffmpeg.log'),
    health: path.join(logsDir, 'health.jsonl'),
  };
}
