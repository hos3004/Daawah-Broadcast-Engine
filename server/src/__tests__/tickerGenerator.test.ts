import { calculateLoopedTickerLayout } from '../overlay/tickerGenerator';

describe('ticker generator', () => {
  it('uses a repeating tile so the next ticker copy starts before a long blank area', () => {
    const layout = calculateLoopedTickerLayout({
      screenWidth: 1280,
      textWidth: 900,
      gapWidth: 36,
    });

    expect(layout.tileWidth).toBe(936);
    expect(layout.totalWidth).toBe(layout.tileWidth * layout.repeatCount);
    expect(layout.repeatCount).toBeGreaterThanOrEqual(4);
  });
});
