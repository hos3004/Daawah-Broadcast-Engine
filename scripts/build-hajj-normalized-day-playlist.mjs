import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';

const projectRoot = process.env.PLAYLIST_PROJECT_ROOT || process.cwd();
const playlistRoot = path.join(projectRoot, 'generated', 'playlists');
const normalizedRoot = process.env.NORMALIZED_ROOT || '/srv/daawah/media/normalized-ar';
const bumpersRoot = process.env.BUMPERS_ROOT || '/srv/daawah/media/bumpers';
const daySeconds = 24 * 60 * 60;
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.m4v']);
const runId = process.env.RUN_ID || `hajj-normalized-day-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const runDir = path.join(playlistRoot, runId);
const date = process.env.PLAYLIST_DATE || new Date().toISOString().slice(0, 10);

const durationCache = new Map();
const skipped = [];

function main() {
  const programFiles = listVideoFiles(normalizedRoot)
    .filter(filePath => !isInsideAny(filePath, [
      path.join(normalizedRoot, 'logs'),
      path.join(normalizedRoot, 'logs_continue'),
      path.join(normalizedRoot, 'logs_fix'),
      path.join(normalizedRoot, 'logs_promote_ready'),
      path.join(normalizedRoot, 'reports'),
    ]))
    .sort((a, b) => sortByFolderThenName(a, b));
  const bumperFiles = listVideoFiles(bumpersRoot).sort((a, b) => sortByBumperRole(a, b));

  if (programFiles.length === 0) throw new Error(`No normalized program files found in ${normalizedRoot}`);
  if (bumperFiles.length === 0) throw new Error(`No bumper files found in ${bumpersRoot}`);

  const items = [];
  const manifestRows = [];
  let cursor = 0;
  let programIndex = 0;
  let bumperIndex = 0;

  while (cursor < daySeconds - 0.001 && items.length < 20_000) {
    const program = nextUsableFile(programFiles, programIndex, normalizedRoot);
    programIndex = program.nextIndex;
    if (!program.filePath) break;
    cursor = addItem({
      items,
      manifestRows,
      type: 'program',
      sourceRole: 'program',
      root: normalizedRoot,
      filePath: program.filePath,
      actualDuration: program.duration,
      startSeconds: cursor,
    });
    if (cursor >= daySeconds - 0.001) break;

    const bumper = nextUsableFile(bumperFiles, bumperIndex, bumpersRoot);
    bumperIndex = bumper.nextIndex;
    if (!bumper.filePath) break;
    cursor = addItem({
      items,
      manifestRows,
      type: 'gap_filler',
      sourceRole: bumperRole(bumper.filePath),
      root: bumpersRoot,
      filePath: bumper.filePath,
      actualDuration: bumper.duration,
      startSeconds: cursor,
    });
  }

  if (cursor < daySeconds - 1) {
    throw new Error(`Playlist underfilled: ${cursor.toFixed(3)}s of ${daySeconds}s`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  const playlistPath = path.join(runDir, 'playlist.json');
  const ffconcatPath = path.join(runDir, 'playlist.ffconcat');
  const manifestPath = path.join(runDir, 'manifest.csv');
  const reportPath = path.join(runDir, 'report.md');

  const playlist = {
    runId,
    generatedAt: new Date().toISOString(),
    mode: 'hajj-normalized-ar-plus-bumpers-one-day',
    date,
    mediaExpansionAvailable: true,
    ffconcatPath,
    durationSeconds: round(sum(items.map(item => item.durationSeconds))),
    safety: {
      programRoots: [normalizedRoot],
      bumperRoots: [bumpersRoot],
      usesOriginalAr: false,
      usesSourcePrograms: false,
      rtmp: false,
      productionHls: false,
    },
    summary: {
      itemCount: items.length,
      programItemCount: items.filter(item => item.type === 'program').length,
      bumperItemCount: items.filter(item => item.type === 'gap_filler').length,
      normalizedProgramCandidates: programFiles.length,
      bumperCandidates: bumperFiles.length,
      trimmedItemCount: items.filter(item => item.isTrimmed).length,
      skippedProbeErrors: skipped.length,
    },
    items,
  };

  fs.writeFileSync(playlistPath, `${JSON.stringify(playlist, null, 2)}\n`, 'utf8');
  fs.writeFileSync(ffconcatPath, renderFfconcat(items), 'utf8');
  fs.writeFileSync(manifestPath, renderManifest(manifestRows), 'utf8');
  fs.writeFileSync(reportPath, renderReport(playlist, playlistPath, ffconcatPath, manifestPath), 'utf8');
  if (skipped.length > 0) {
    fs.writeFileSync(path.join(runDir, 'skipped-errors.json'), `${JSON.stringify(skipped, null, 2)}\n`, 'utf8');
  }

  process.stdout.write(`${JSON.stringify({
    runId,
    runDir,
    playlistPath,
    ffconcatPath,
    manifestPath,
    reportPath,
    durationSeconds: playlist.durationSeconds,
    itemCount: playlist.summary.itemCount,
    programItemCount: playlist.summary.programItemCount,
    bumperItemCount: playlist.summary.bumperItemCount,
    normalizedProgramCandidates: playlist.summary.normalizedProgramCandidates,
    bumperCandidates: playlist.summary.bumperCandidates,
    trimmedItemCount: playlist.summary.trimmedItemCount,
    skippedProbeErrors: playlist.summary.skippedProbeErrors,
  }, null, 2)}\n`);
}

function listVideoFiles(root) {
  const files = [];
  walk(root, filePath => {
    if (videoExtensions.has(path.extname(filePath).toLowerCase())) files.push(filePath);
  });
  return files;
}

function walk(dirPath, onFile) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walk(fullPath, onFile);
    else if (entry.isFile()) onFile(fullPath);
  }
}

function isInsideAny(filePath, dirs) {
  return dirs.some(dir => isInside(filePath, dir));
}

function isInside(filePath, dirPath) {
  const relative = path.relative(path.resolve(dirPath), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sortByFolderThenName(a, b) {
  const folderCompare = path.dirname(a).localeCompare(path.dirname(b), 'ar');
  if (folderCompare !== 0) return folderCompare;
  return path.basename(a).localeCompare(path.basename(b), 'ar', { numeric: true });
}

function sortByBumperRole(a, b) {
  const roleCompare = bumperRoleRank(a) - bumperRoleRank(b);
  if (roleCompare !== 0) return roleCompare;
  return a.localeCompare(b, 'ar', { numeric: true });
}

function bumperRole(filePath) {
  const rank = bumperRoleRank(filePath);
  if (rank === 0) return 'main_sting';
  if (rank === 1) return 'seasonal_sting';
  return 'filler';
}

function bumperRoleRank(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/logo-sting/')) return 0;
  if (normalized.includes('/sting-hag/') || normalized.includes('hag')) return 1;
  return 2;
}

function nextUsableFile(files, startIndex, root) {
  for (let attempts = 0; attempts < files.length; attempts += 1) {
    const index = (startIndex + attempts) % files.length;
    const filePath = files[index];
    const nextIndex = index + 1;
    if (!filePath || !isInside(filePath, root) || !fs.existsSync(filePath)) continue;
    const duration = durationFor(filePath);
    if (duration && duration > 0) return { filePath, duration, nextIndex };
  }
  return { filePath: null, duration: 0, nextIndex: startIndex };
}

function durationFor(filePath) {
  if (durationCache.has(filePath)) return durationCache.get(filePath);
  try {
    const output = childProcess.execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { encoding: 'utf8', timeout: 20_000 }).trim();
    const duration = Number.parseFloat(output);
    const value = Number.isFinite(duration) && duration > 0 ? duration : null;
    durationCache.set(filePath, value);
    return value;
  } catch (err) {
    skipped.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    durationCache.set(filePath, null);
    return null;
  }
}

function addItem(args) {
  const remaining = daySeconds - args.startSeconds;
  const playDuration = Math.min(args.actualDuration, remaining);
  if (playDuration <= 0) return args.startSeconds;
  const endSeconds = args.startSeconds + playDuration;
  const index = args.items.length + 1;
  const trimmed = playDuration < args.actualDuration - 0.25;
  const title = args.type === 'program'
    ? `${path.basename(path.dirname(args.filePath))} - ${path.basename(args.filePath, path.extname(args.filePath))}`
    : `Bumper - ${path.basename(args.filePath, path.extname(args.filePath))}`;
  const item = {
    id: `item-${String(index).padStart(5, '0')}`,
    date,
    type: args.type,
    source: runId,
    sourceRole: args.sourceRole,
    programKey: args.type === 'program' ? path.basename(path.dirname(args.filePath)) : null,
    title,
    startTime: formatClock(args.startSeconds),
    endTime: formatClock(endSeconds),
    timelineStartSeconds: round(args.startSeconds),
    timelineEndSeconds: round(endSeconds),
    durationMinutes: round(playDuration / 60, 6),
    durationSeconds: round(playDuration),
    mediaFileId: null,
    absolutePath: args.filePath,
    relativePath: path.relative(args.root, args.filePath),
    trimStartSeconds: 0,
    trimEndSeconds: round(playDuration),
    isTrimmed: trimmed,
    validationStatus: 'ready',
  };
  args.items.push(item);
  args.manifestRows.push([
    index,
    item.type,
    item.sourceRole,
    item.startTime,
    item.endTime,
    item.durationSeconds.toFixed(3),
    item.isTrimmed ? 'yes' : 'no',
    item.absolutePath,
  ]);
  return endSeconds;
}

function formatClock(seconds) {
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderFfconcat(items) {
  const lines = ['ffconcat version 1.0'];
  for (const item of items) {
    lines.push(formatConcatFileLine(item.absolutePath));
    if (item.isTrimmed) {
      const seconds = item.durationSeconds.toFixed(3);
      lines.push(`outpoint ${seconds}`);
      lines.push(`duration ${seconds}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatConcatFileLine(filePath) {
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function renderManifest(rows) {
  const header = ['index', 'type', 'sourceRole', 'startTime', 'endTime', 'durationSeconds', 'trimmed', 'absolutePath'];
  return `${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function renderReport(playlist, playlistPath, ffconcatPath, manifestPath) {
  return `# Hajj Normalized Day Playlist

- Run: \`${playlist.runId}\`
- Date: \`${playlist.date}\`
- Duration: \`${playlist.durationSeconds}\` seconds
- Items: \`${playlist.summary.itemCount}\`
- Programs: \`${playlist.summary.programItemCount}\` from \`${normalizedRoot}\`
- Bumpers: \`${playlist.summary.bumperItemCount}\` from \`${bumpersRoot}\`
- Original/source programs used: \`0\`
- Skipped probe errors: \`${playlist.summary.skippedProbeErrors}\`

Artifacts:

- \`${playlistPath}\`
- \`${ffconcatPath}\`
- \`${manifestPath}\`
`;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

main();
