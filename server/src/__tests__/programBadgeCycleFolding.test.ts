import {
  detectScheduleCycle,
  foldGroupsIntoCycle,
  buildOverlayEnableExpression,
  buildBadgeCropYExpression,
} from '../overlay/programBadgeOverlay';

// Build a periodic schedule: `titles` programs back-to-back filling one `period`,
// repeated `cycles` times. Durations vary per cycle (different episodes) when
// `jitter` is set, but every program START stays phase-locked to its slot.
function buildPeriodicGroups(
  titles: string[],
  slotSeconds: number,
  cycles: number,
  jitter = 0
) {
  const period = titles.length * slotSeconds;
  return titles.map((title, index) => ({
    title,
    ranges: Array.from({ length: cycles }, (_, c) => {
      const start = c * period + index * slotSeconds;
      const wobble = jitter ? ((c * 37 + index * 13) % jitter) : 0;
      // Duration varies but always stays inside the slot so windows don't overlap.
      const dur = Math.max(60, slotSeconds - wobble);
      return { startSeconds: start, endSeconds: start + dur };
    }),
  }));
}

describe('program badge schedule cycle folding', () => {
  it('detects the period of a perfectly repeated schedule', () => {
    const groups = buildPeriodicGroups(['A', 'B', 'C', 'D'], 600, 10); // 4×600s = 2400s cycle
    const cycle = detectScheduleCycle(groups);
    expect(cycle).not.toBeNull();
    expect(cycle!.period).toBe(2400);
  });

  it('detects the period even when episode durations vary per cycle', () => {
    // Same slots every cycle, but durations wobble by up to ~200s.
    const groups = buildPeriodicGroups(['A', 'B', 'C', 'D'], 600, 20, 200);
    const cycle = detectScheduleCycle(groups);
    expect(cycle).not.toBeNull();
    expect(cycle!.period).toBe(2400);
  });

  it('folds thousands of ranges into one cycle of between() terms', () => {
    const groups = buildPeriodicGroups(['A', 'B', 'C', 'D'], 600, 45, 200); // 45 cycles
    const cycle = detectScheduleCycle(groups)!;
    const allRanges = groups.flatMap(g => g.ranges);
    expect(allRanges.length).toBe(4 * 45); // 180 absolute ranges

    const folded = foldGroupsIntoCycle(groups, cycle.period);
    // Each title collapses to one window (no boundary wrap in this layout).
    const foldedRanges = folded.flatMap(g => g.ranges);
    expect(foldedRanges.length).toBe(4);

    const expr = buildBadgeCropYExpression(folded, 60, cycle);
    expect(expr).toContain('mod(t,2400)');
    const betweenCount = (expr.match(/between\(/g) ?? []).length;
    expect(betweenCount).toBe(4);
  });

  it('uses mod(t,period) in the crop y-expression and stays small', () => {
    const groups = buildPeriodicGroups(['A', 'B', 'C', 'D'], 600, 45, 200);
    const cycle = detectScheduleCycle(groups)!;
    const folded = foldGroupsIntoCycle(groups, cycle.period);
    const expr = buildBadgeCropYExpression(folded, 60, cycle);
    const betweenCount = (expr.match(/between\(/g) ?? []).length;
    expect(betweenCount).toBe(4); // one term per group
    expect(expr).toContain('mod(t,2400)');
  });

  it('folded badge uses the longest episode duration so it never disappears early', () => {
    // Title A runs a 120s episode in one cycle and a 540s episode in another.
    // The folded window must use the LONGEST (540s) so the badge stays for the
    // whole episode in every cycle — never vanishing while A is still on air.
    const groups = [
      { title: 'A', ranges: [
        { startSeconds: 0, endSeconds: 120 },
        { startSeconds: 2400, endSeconds: 2400 + 540 },
        { startSeconds: 4800, endSeconds: 4800 + 300 },
      ] },
      { title: 'B', ranges: [
        { startSeconds: 600, endSeconds: 1200 },
        { startSeconds: 3000, endSeconds: 3600 },
        { startSeconds: 5400, endSeconds: 6000 },
      ] },
      { title: 'C', ranges: [
        { startSeconds: 1200, endSeconds: 1800 },
        { startSeconds: 3600, endSeconds: 4200 },
        { startSeconds: 6000, endSeconds: 6600 },
      ] },
      { title: 'D', ranges: [
        { startSeconds: 1800, endSeconds: 2400 },
        { startSeconds: 4200, endSeconds: 4800 },
        { startSeconds: 6600, endSeconds: 7200 },
      ] },
    ];
    const cycle = detectScheduleCycle(groups)!;
    expect(cycle.period).toBe(2400);
    const folded = foldGroupsIntoCycle(groups, cycle.period);
    // Longest A episode = 540s, under the 600s slot → folded window is [0,540].
    expect(folded[0]!.ranges).toEqual([{ startSeconds: 0, endSeconds: 540 }]);
    const expr = buildBadgeCropYExpression(folded, 60, cycle);
    expect(expr).toContain('between(mod(t,2400),0,540)');
  });

  it('returns null (no folding) when a slot is reused by two different titles', () => {
    const groups = [
      { title: 'A', ranges: [
        { startSeconds: 0, endSeconds: 100 },
        { startSeconds: 2400, endSeconds: 2500 },
        { startSeconds: 4800, endSeconds: 4900 },
      ] },
      // B mostly lives at phase 1200, but one instance lands at phase 0 (A's slot)
      // with a different title → the cycle is not clean → no folding.
      { title: 'B', ranges: [
        { startSeconds: 1200, endSeconds: 1300 },
        { startSeconds: 2400, endSeconds: 2450 },
        { startSeconds: 3600, endSeconds: 3700 },
      ] },
    ];
    expect(detectScheduleCycle(groups)).toBeNull();
  });

  it('returns null (no folding) for a non-periodic schedule', () => {
    const groups = [
      { title: 'A', ranges: [{ startSeconds: 0, endSeconds: 100 }, { startSeconds: 5000, endSeconds: 5100 }] },
      { title: 'B', ranges: [{ startSeconds: 200, endSeconds: 300 }, { startSeconds: 9999, endSeconds: 10222 }] },
    ];
    expect(detectScheduleCycle(groups)).toBeNull();
  });

  it('falls back to absolute time when no cycle is given', () => {
    const ranges = [{ startSeconds: 10, endSeconds: 20 }];
    const expr = buildOverlayEnableExpression(ranges);
    expect(expr).toBe('between(t,10,20)');
  });
});
