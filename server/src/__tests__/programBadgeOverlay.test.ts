import type { PlaylistItem } from '../playlist/builder';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import {
  buildBadgeCropYExpression,
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  // IHDR width/height are big-endian uint32 at byte offsets 16 and 20.
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('program badge image overlay', () => {
  it('truncates program titles to the first three words', () => {
    expect(truncateProgramBadgeTitle('  Alpha   Beta Gamma Delta  ')).toBe('Alpha Beta Gamma');
    expect(truncateProgramBadgeTitle('Alpha Beta')).toBe('Alpha Beta');
    expect(truncateProgramBadgeTitle('‫Alpha‬ Beta ‏Gamma Delta')).toBe('Alpha Beta Gamma');
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

  it('builds a nested crop-y expression mapping each group to its sprite row', () => {
    // Row 0 is the transparent gap; group 0 -> row 1 (y=60), group 1 -> row 2 (y=120).
    const expr = buildBadgeCropYExpression([
      { title: 'First', ranges: [{ startSeconds: 0, endSeconds: 10 }] },
      { title: 'Second', ranges: [{ startSeconds: 10, endSeconds: 20 }] },
    ], 60);
    expect(expr).toBe('if(between(t,0,10),60,if(between(t,10,20),120,0))');
  });

  it('renders all titles into one transparent sprite PNG selected by a time crop', () => {
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
    expect(assets!.spriteWidth).toBe(256);
    expect(assets!.rowHeight).toBe(60);
    // Strip sits just above the pill centre (height 720, ticker 60).
    expect(assets!.textLayerY).toBe(600);
    // One title -> 2 rows (transparent gap + the title row).
    expect(assets!.cropYExpression).toBe('if(between(t,0,10),60,0)');
    expect(assets!.backgroundRanges).toEqual([{ startSeconds: 0, endSeconds: 10 }]);

    expect(fs.existsSync(assets!.spritePath)).toBe(true);
    const png = fs.readFileSync(assets!.spritePath);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    // A real PNG sized 256 x (rows * 60) is written, not an ASS file.
    expect(pngDimensions(png)).toEqual({ width: 256, height: 120 });
  });

  it('grows the sprite by one row per distinct title', () => {
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
    // 2 titles -> 3 rows (gap + 2 titles).
    expect(pngDimensions(fs.readFileSync(assets!.spritePath))).toEqual({ width: 256, height: 180 });
    expect(assets!.cropYExpression).toBe('if(between(t,0,10),60,if(between(t,10,20),120,0))');
  });

  it('renders shaped Arabic (no tofu) for a real Arabic program title', () => {
    // Regression guard for the libass tofu bug: contextual Arabic forms must paint
    // visible glyph pixels via canvas, not .notdef boxes. We render the requested
    // title and assert the title row contains non-transparent (drawn) pixels.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-badge-ar-'));
    const templatePath = path.join(tempDir, 'now.png');
    fs.writeFileSync(templatePath, 'png');

    const assets = prepareProgramBadgeOverlayAssets(
      [item({ title_ar: 'آية وهداية مع د محمود القلعاوي' })],
      0,
      {
        date: '2026-05-29',
        width: 1280,
        height: 720,
        tickerHeight: 60,
        templatePath,
        outputDir: tempDir,
      }
    );

    expect(assets).not.toBeNull();
    const png = fs.readFileSync(assets!.spritePath);
    expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);

    // prepareProgramBadgeOverlayAssets registers Tajawal as ProgramBadgeFont
    // globally. Re-render the truncated title ("آية وهداية مع") and confirm canvas
    // paints visible glyph pixels — shaped Arabic, not transparent .notdef tofu.
    const probe = createCanvas(256, 60);
    const pctx = probe.getContext('2d');
    pctx.font = 'bold 30px "ProgramBadgeFont"';
    pctx.fillStyle = '#FFFFFF';
    pctx.textBaseline = 'middle';
    pctx.direction = 'rtl';
    pctx.textAlign = 'right';
    pctx.fillText('آية وهداية مع', 137, 30);
    const { data } = pctx.getImageData(0, 0, 256, 60);
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) opaque++;
    expect(opaque).toBeGreaterThan(50);
  });
});
