import type { PlaylistItem } from '../playlist/builder';
import { buildConcatFileContents } from '../broadcast/ffmpegRunner';

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
});
