import { useState } from 'react';
import { authApi } from '../api/client';

interface User { id: string; email: string; role: string; }

export default function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login(email, password);
      onLogin(res.data.user);
    } catch {
      setError('بريد إلكتروني أو كلمة مرور غير صحيحة');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <div className="card w-full max-w-sm">
        <h1 className="text-xl font-bold mb-1 text-center" style={{ color: 'var(--accent)' }}>
          Daawah Broadcast Engine
        </h1>
        <p className="text-center text-sm mb-6" style={{ color: 'var(--text-muted)' }}>لوحة التحكم</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-muted)' }}>البريد الإلكتروني</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-md text-sm outline-none focus:ring-1"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
              dir="ltr"
            />
          </div>
          <div>
            <label className="block text-sm mb-1" style={{ color: 'var(--text-muted)' }}>كلمة المرور</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--bg-border)', color: 'var(--text-primary)' }}
              dir="ltr"
            />
          </div>
          {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full"
          >
            {loading ? 'جارٍ تسجيل الدخول...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  );
}
