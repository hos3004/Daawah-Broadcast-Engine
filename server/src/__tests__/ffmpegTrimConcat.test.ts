import type { PlaylistItem } from '../playlist/builder';
import { buildConcatFileContents, buildLogoOverlayEnableExpression } from '../broadcast/ffmpegRunner';

describe('FFmpeg concat trimming', () => {
  it('writes ffconcat outpoint and duration for trimmed playlist items', () => {
    const item: PlaylistItem = {
      id: 'item-1',
      position: 0,
      start_time_ms: 0,
      end_time_ms: 40_000,
      type: 'filler',
      program_id: null,
      media_file_id: 'media-1',
      media_path: '/media/bumpers/main.mp4',
      title: 'Main Sting',
      title_ar: null,
      duration_ms: 40_000,
      show_lower_third: false,
      lower_third_path: null,
      is_emergency: false,
      source_role: 'main_sting',
      is_trimmed: true,
      trim_out_ms: 40_000,
      forced_duration_ms: 40_000,
    };

    const contents = buildConcatFileContents([item]);

    expect(contents).toContain('ffconcat version 1.0');
    expect(contents).toContain("file '/media/bumpers/main.mp4'");
    expect(contents).toContain('outpoint 40.000');
    expect(contents).toContain('duration 40.000');
  });

  it('keeps legacy untrimmed playlist items as plain concat entries', () => {
    const legacyItem = {
      media_path: '/media/programs/show.mp4',
      duration_ms: 60_000,
    } as PlaylistItem;

    const contents = buildConcatFileContents([legacyItem]);

    expect(contents).toBe("file '/media/programs/show.mp4'");
  });

  it('seeks into the first current item when playback starts after its scheduled start', () => {
    const item = {
      media_path: '/media/programs/show.mp4',
      start_time_ms: 100_000,
      end_time_ms: 160_000,
      duration_ms: 60_000,
      is_trimmed: false,
      trim_out_ms: null,
      forced_duration_ms: null,
    } as PlaylistItem;

    const contents = buildConcatFileContents([item], 115_000);

    expect(contents).toContain('ffconcat version 1.0');
    expect(contents).toContain("file '/media/programs/show.mp4'");
    expect(contents).toContain('inpoint 15.000');
    expect(contents).not.toContain('outpoint');
  });

  it('keeps only the remaining duration for a trimmed current item', () => {
    const item = {
      media_path: '/media/programs/trimmed.mp4',
      start_time_ms: 100_000,
      end_time_ms: 140_000,
      duration_ms: 40_000,
      is_trimmed: true,
      trim_out_ms: 40_000,
      forced_duration_ms: 40_000,
    } as PlaylistItem;

    const contents = buildConcatFileContents([item], 115_000);

    expect(contents).toContain('inpoint 15.000');
    expect(contents).toContain('outpoint 40.000');
    expect(contents).toContain('duration 25.000');
  });

  it('disables the logo overlay during marked program ranges only', () => {
    const items = [
      {
        start_time_ms: 10_000,
        end_time_ms: 40_000,
        type: 'program',
        source_role: 'program',
        hide_logo: true,
      },
      {
        start_time_ms: 40_000,
        end_time_ms: 50_000,
        type: 'filler',
        source_role: 'filler',
        hide_logo: true,
      },
    ] as PlaylistItem[];

    expect(buildLogoOverlayEnableExpression(items, 5_000)).toBe('not(between(t,5,35))');
  });
});
