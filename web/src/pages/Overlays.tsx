import { useState } from 'react';
import { overlaysApi } from '../api/client';
import { Wand2, Image, Film } from 'lucide-react';
import dayjs from 'dayjs';

export default function OverlaysPage() {
  const today = dayjs().format('YYYY-MM-DD');
  const thisMonth = dayjs().format('YYYY-MM');
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<string>('');
  const [tickerDate, setTickerDate] = useState(today);
  const [monthInput, setMonthInput] = useState(thisMonth);

  const action = async (key: string, fn: () => Promise<unknown>) => {
    setLoading(key);
    setResult('');
    try {
      const r = await fn();
      setResult(`✓ نجح: ${JSON.stringify(r, null, 2)}`);
    } catch (err) {
      setResult(`✗ فشل: ${String(err)}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">إدارة الطبقات</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Logo */}
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <Image size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-medium">اللوجو</h3>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            تحويل PNG sequence إلى WebM شفاف لاستخدامه في البث.
          </p>
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            disabled={loading !== null}
            onClick={() => action('logo', () => overlaysApi.convertLogo().then(r => r.data))}
          >
            <Wand2 size={14} />
            {loading === 'logo' ? 'جارٍ التحويل...' : 'تحويل اللوجو'}
          </button>
        </div>

        {/* Ticker */}
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <Film size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-medium">تيكر اليوم</h3>
          </div>
          <input
            type="date"
            value={tickerDate}
            onChange={e => setTickerDate(e.target.value)}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
          />
          <button
            className="btn-primary w-full flex items-center justify-center gap-2"
            disabled={loading !== null}
            onClick={() => action('ticker', () => overlaysApi.generateTicker(tickerDate).then(r => r.data))}
          >
            <Wand2 size={14} />
            {loading === 'ticker' ? 'جارٍ التوليد...' : 'توليد التيكر'}
          </button>
          <div className="border-t pt-3" style={{ borderColor: 'var(--bg-border)' }}>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>توليد لشهر كامل:</p>
            <div className="flex gap-2">
              <input
                type="month"
                value={monthInput}
                onChange={e => setMonthInput(e.target.value)}
                className="flex-1 px-3 py-2 rounded-md text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
              />
              <button
                className="btn-ghost text-xs"
                disabled={loading !== null}
                onClick={() => action('ticker-month', () => overlaysApi.generateTickerMonth(monthInput).then(r => r.data))}
              >
                توليد
              </button>
            </div>
          </div>
        </div>

        {/* Now Playing */}
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <Image size={16} style={{ color: 'var(--accent)' }} />
            <h3 className="font-medium">Now Playing</h3>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            يُنشأ تلقائياً أثناء بناء قائمة التشغيل. يمكن إعادة توليده من صفحة التحكم بالبث.
          </p>
          <div className="badge badge-info text-xs">يتولّد تلقائياً مع قائمة التشغيل</div>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div
          className="card font-mono text-xs whitespace-pre-wrap overflow-auto max-h-40"
          style={{ color: result.startsWith('✓') ? '#4ade80' : '#f87171' }}
        >
          {result}
        </div>
      )}
    </div>
  );
}
