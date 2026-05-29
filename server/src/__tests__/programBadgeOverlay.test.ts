import type { PlaylistItem } from '../playlist/builder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildOverlayEnableExpression,
  collectProgramBadgeGroups,
  prepareProgramBadgeOverlayAssets,
  truncateProgramBadgeTitle,
} from '../overlay/programBadgeOverlay';

function item(overrides: Partial<PlaylistItem>): PlaylistItem {
  return {
    id: 'item-1',
    position: 0,
    start_time_ms: 0,
    end_time_ms: 10_000,
    type: 'program',
    program_id: null,
    media_file_id: 'media-1',
    media_path: '/tmp/media.mp4',
    title: 'Alpha Beta Gamma Delta',
    title_ar: null,
    duration_ms: 10_000,
    show_lower_third: true,
    lower_third_path: null,
    is_emergency: false,
    source_role: 'program',
    is_trimmed: false,
    trim_out_ms: null,
    forced_duration_ms: null,
    ...overrides,
  };
}

describe('program badge image overlay', () => {
  it('truncates program titles to the first three words', () => {
    expect(truncateProgramBadgeTitle('  Alpha   Beta Gamma Delta  ')).toBe('Alpha Beta Gamma');
    expect(truncateProgramBadgeTitle('Alpha Beta')).toBe('Alpha Beta');
    expect(truncateProgramBadgeTitle('\u202BAlpha\u202C Beta \u200FGamma Delta')).toBe('Alpha Beta Gamma');
  });

  it('groups only program items and merges adjacent ranges', () => {
    const groups = collectProgramBadgeGroups([
      item({
        start_time_ms: 5_000,
        end_time_ms: 15_000,
        title: 'Alpha Beta Gamma Delta',
      }),
      item({
        id: 'program-2',
        start_time_ms: 15_000,
        end_time_ms: 20_000,
        title: 'Alpha Beta Gamma Delta',
      }),
      item({
        id: 'filler-1',
        type: 'filler',
        source_role: 'general_bumper',
        show_lower_third: false,
        title: 'Ignored Filler Title',
      }),
    ], 1_000);

    expect(groups).toEqual([
      {
        title: 'Alpha Beta Gamma',
        ranges: [{ startSeconds: 4, endSeconds: 19 }],
      },
    ]);
  });

  it('formats ffmpeg enable expressions for badge ranges', () => {
    expect(buildOverlayEnableExpression([
      { startSeconds: 0, endSeconds: 1.25 },
      { startSeconds: 10, endSeconds: 12 },
    ])).toBe('between(t,0,1.25)+between(t,10,12)');
  });

  it('renders one transparent PNG layer per program title via canvas', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-badge-'));
    const templatePath = path.join(tempDir, 'now.png');
    fs.writeFileSync(templatePath, 'png');

    const assets = prepareProgramBadgeOverlayAssets([item({ title: 'Alpha Beta Gamma Delta' })], 0, {
      date: '2026-05-29',
      width: 1280,
      height: 720,
      tickerHeight: 60,
      templatePath,
      outputDir: tempDir,
    });

    expect(assets).not.toBeNull();
    expect(assets!.templatePath).toBe(templatePath);
    expect(assets!.textLayers).toHaveLength(1);

    const layer = assets!.textLayers[0]!;
    expect(layer.ranges).toEqual([{ startSeconds: 0, endSeconds: 10 }]);
    expect(fs.existsSync(layer.pngPath)).toBe(true);

    // A real PNG (8-byte signature) is written, not an ASS file.
    const png = fs.readFileSync(layer.pngPath);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(assets!.backgroundRanges).toEqual([{ startSeconds: 0, endSeconds: 10 }]);
  });

  it('produces a separate PNG layer for each distinct title', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-badge-'));
    const templatePath = path.join(tempDir, 'now.png');
    fs.writeFileSync(templatePath, 'png');

    const assets = prepareProgramBadgeOverlayAssets([
      item({ start_time_ms: 0, end_time_ms: 10_000, title: 'First Show Here' }),
      item({ id: 'p2', start_time_ms: 10_000, end_time_ms: 20_000, title: 'Second Show Here' }),
    ], 0, {
      date: '2026-05-30',
      width: 1280,
      height: 720,
      tickerHeight: 60,
      templatePath,
      outputDir: tempDir,
    });

    expect(assets).not.toBeNull();
    expect(assets!.textLayers).toHaveLength(2);
    const paths = assets!.textLayers.map(l => l.pngPath);
    expect(new Set(paths).size).toBe(2);
    for (const p of paths) expect(fs.existsSync(p)).toBe(true);
  });
});
