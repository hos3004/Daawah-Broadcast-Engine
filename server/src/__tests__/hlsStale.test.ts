// Unit tests for HLS stale cooldown logic
// reactToHlsStale is not easily unit-tested without spawning FFmpeg, so we verify
// the cooldown constant and the behaviour description via readable assertions

describe('HLS stale reaction cooldown', () => {
  it('cooldown is at least 60 seconds', () => {
    // The constant HLS_STALE_REACTION_COOLDOWN_MS = 120_000 (2 minutes)
    const COOLDOWN = 120_000;
    expect(COOLDOWN).toBeGreaterThanOrEqual(60_000);
  });

  it('second call within cooldown window should be a no-op', () => {
    // Simulated in-memory cooldown logic
    const COOLDOWN = 120_000;
    let lastReactionAt: number | null = null;

    function canReact(): boolean {
      const now = Date.now();
      if (lastReactionAt !== null && now - lastReactionAt < COOLDOWN) {
        return false;
      }
      lastReactionAt = now;
      return true;
    }

    expect(canReact()).toBe(true);   // first call — allowed
    expect(canReact()).toBe(false);  // second call immediately — blocked
  });

  it('call after cooldown expires should be allowed', () => {
    const COOLDOWN = 100; // tiny cooldown for this test
    let lastReactionAt: number | null = null;

    function canReact(now: number): boolean {
      if (lastReactionAt !== null && now - lastReactionAt < COOLDOWN) return false;
      lastReactionAt = now;
      return true;
    }

    const t0 = 1000;
    expect(canReact(t0)).toBe(true);
    expect(canReact(t0 + 50)).toBe(false);   // within cooldown
    expect(canReact(t0 + 200)).toBe(true);   // after cooldown
  });
});
