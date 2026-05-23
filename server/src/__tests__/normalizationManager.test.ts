import {
  classifyNormalizationDecision,
  NORMALIZATION_EXECUTION_CONFIRMATION_TEXT,
  NormalizationManagerError,
  rejectNormalizationExecution,
} from '../media/normalizationManager';

describe('normalization manager', () => {
  it('classifies ready broadcast-profile media as ok', () => {
    expect(classifyNormalizationDecision({
      path: '/srv/daawah/media/source/ok.mp4',
      status: 'ready',
      duration_sec: 60,
      width: 1280,
      height: 720,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      audio_rate: 48000,
    }, true)).toEqual({ decision: 'ok', reasons: [] });
  });

  it('separates remux, audio-only, full-transcode, and failed decisions', () => {
    expect(classifyNormalizationDecision({
      path: '/srv/daawah/media/source/remux.mov',
      status: 'ready',
      duration_sec: 60,
      width: 1280,
      height: 720,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      audio_rate: 48000,
    }, true).decision).toBe('remux');

    expect(classifyNormalizationDecision({
      path: '/srv/daawah/media/source/audio.mp4',
      status: 'ready',
      duration_sec: 60,
      width: 1280,
      height: 720,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      audio_rate: 44100,
    }, true).decision).toBe('audio-only');

    expect(classifyNormalizationDecision({
      path: '/srv/daawah/media/source/video.mp4',
      status: 'ready',
      duration_sec: 60,
      width: 1920,
      height: 1080,
      fps: 29.97,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      audio_rate: 48000,
    }, true).decision).toBe('full-transcode');

    const failed = classifyNormalizationDecision({
      path: '/srv/daawah/media/source/missing.mp4',
      status: 'ready',
      duration_sec: null,
      width: 1280,
      height: 720,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      audio_rate: 48000,
    }, false);

    expect(failed.decision).toBe('failed');
    expect(failed.reasons).toEqual(expect.arrayContaining(['missing', 'duration']));
  });

  it('requires full transcode when broadcast-profile video bitrate is too high', () => {
    const decision = classifyNormalizationDecision({
      path: '/srv/daawah/media/original-ar/high-bitrate.mp4',
      status: 'ready',
      duration_sec: 600,
      width: 1280,
      height: 720,
      fps: 25,
      video_codec: 'h264',
      audio_codec: 'aac',
      pixel_format: 'yuv420p',
      bitrate: 17000000,
      audio_rate: 48000,
    }, true);

    expect(decision.decision).toBe('full-transcode');
    expect(decision.reasons).toContain('bitrate');
  });

  it('requires explicit smart normalization confirmation text before execution can proceed', () => {
    expect(() => rejectNormalizationExecution({
      planId: 'plan-1',
      confirmExecution: true,
      confirmationText: 'wrong',
    })).toThrow(NormalizationManagerError);

    expect(() => rejectNormalizationExecution({
      planId: 'plan-1',
      confirmExecution: true,
      confirmationText: NORMALIZATION_EXECUTION_CONFIRMATION_TEXT,
    })).toThrow(NormalizationManagerError);

    try {
      rejectNormalizationExecution({
        planId: 'plan-1',
        confirmExecution: true,
        confirmationText: NORMALIZATION_EXECUTION_CONFIRMATION_TEXT,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(NormalizationManagerError);
      expect((err as NormalizationManagerError).code).toBe('NORMALIZATION_EXECUTION_REJECTED');
    }
  });
});
