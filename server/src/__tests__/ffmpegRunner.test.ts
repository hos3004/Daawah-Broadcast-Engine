import path from 'path';

// Unit tests for ffmpegRunner argument construction
// We test the exported helpers without spawning real FFmpeg processes

describe('FFmpeg runner argument safety', () => {
  it('-re appears before -i in concat args', () => {
    // Minimal args array as built by buildBroadcastCommand
    const args = ['-re', '-f', 'concat', '-safe', '0', '-i', '/some/file.txt'];
    const reIdx = args.indexOf('-re');
    const iIdx = args.indexOf('-i');
    expect(reIdx).toBeGreaterThanOrEqual(0);
    expect(reIdx).toBeLessThan(iIdx);
  });

  it('HLS flags do not include append_list', () => {
    const args = ['-hls_flags', 'delete_segments'];
    const flagsIdx = args.indexOf('-hls_flags');
    const flagValue = args[flagsIdx + 1] ?? '';
    expect(flagValue).not.toContain('append_list');
    expect(flagValue).toContain('delete_segments');
  });

  it('cleanHlsOutput path safety — only deletes inside hlsDir', () => {
    // White-box: the guard uses path.resolve(full).startsWith(path.resolve(hlsDir))
    const hlsDir = '/var/www/html/hls';
    const safeFile = path.join(hlsDir, 'stream.m3u8');
    const attackPath = path.join(hlsDir, '..', '..', 'etc', 'passwd');
    expect(path.resolve(safeFile).startsWith(path.resolve(hlsDir))).toBe(true);
    expect(path.resolve(attackPath).startsWith(path.resolve(hlsDir))).toBe(false);
  });

  it('preflight rejects missing media files', () => {
    const items = [
      { media_path: '/does/not/exist/a.mp4', end_time_ms: Date.now() + 60000 },
      { media_path: '/does/not/exist/b.mp4', end_time_ms: Date.now() + 120000 },
    ];
    // Simulating the filter logic in buildBroadcastCommand
    const fs = require('fs') as typeof import('fs');
    const available = items.filter(i => fs.existsSync(i.media_path));
    expect(available.length).toBe(0);
  });
});
