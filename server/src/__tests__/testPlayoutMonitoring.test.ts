import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  classifyTestPlayoutFailure,
  inspectTestPlayoutOutput,
} from '../playout/testPlayout';

describe('test playout monitoring helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-test-playout-monitor-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks localhost HLS output stale when the index is older than the configured threshold', () => {
    const indexPath = path.join(tempDir, 'index.m3u8');
    fs.writeFileSync(indexPath, '#EXTM3U\n', 'utf8');
    const oldTime = new Date(Date.now() - 45_000);
    fs.utimesSync(indexPath, oldTime, oldTime);

    const output = inspectTestPlayoutOutput('localhost_hls', tempDir);

    expect(output.exists).toBe(true);
    expect(output.hlsIndexAgeSeconds).toBeGreaterThanOrEqual(30);
    expect(output.hlsStaleThresholdSeconds).toBe(30);
    expect(output.hlsHealthy).toBe(false);
    expect(output.hlsStale).toBe(true);
  });

  it('keeps local file output out of HLS stale health decisions', () => {
    const outputPath = path.join(tempDir, 'output.mp4');
    fs.writeFileSync(outputPath, 'placeholder', 'utf8');

    const output = inspectTestPlayoutOutput('local_file', outputPath);

    expect(output.exists).toBe(true);
    expect(output.sizeBytes).toBeGreaterThan(0);
    expect(output.hlsHealthy).toBeNull();
    expect(output.hlsStale).toBe(false);
  });

  it('classifies common FFmpeg failure signatures for the control panel', () => {
    expect(classifyTestPlayoutFailure('Error opening input file /missing.mp4: No such file or directory')?.code)
      .toBe('MISSING_FILE');
    expect(classifyTestPlayoutFailure('Application provided invalid, non monotonically increasing dts')?.code)
      .toBe('DTS_PTS');
    expect(classifyTestPlayoutFailure('Invalid data found when processing input')?.code)
      .toBe('DECODER_ERROR');
  });
});
