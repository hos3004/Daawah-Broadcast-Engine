import { buildAudioNormAf, buildVideoNormVf } from '../media/normalizer';

describe('media normalizer filters', () => {
  it('normalizes video geometry, frame rate, and timestamps', () => {
    expect(buildVideoNormVf({ width: 1280, height: 720, fps: 25 })).toBe(
      [
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        'setsar=1',
        'fps=25',
        'setpts=N/(25*TB)',
        'settb=1/25',
      ].join(',')
    );
  });

  it('normalizes audio sample rate, channel layout, and timestamps', () => {
    expect(buildAudioNormAf({ audioRate: 48000 })).toBe(
      'aresample=48000:first_pts=0,asetpts=N/SR/TB,aformat=sample_fmts=fltp:channel_layouts=stereo'
    );
  });
});
