import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { authApi } from './api/client';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import DashboardPage from './pages/Dashboard';
import MediaLibraryPage from './pages/MediaLibrary';
import SchedulePage from './pages/Schedule';
import OverlaysPage from './pages/Overlays';
import BroadcastPage from './pages/BroadcastControl';
import LogsPage from './pages/Logs';

interface User { id: string; email: string; role: string; }

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authApi.me()
      .then(r => setUser(r.data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent rounded-full border-t-transparent animate-spin mx-auto mb-2" />
          <p style={{ color: 'var(--text-muted)' }}>جارٍ التحميل...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={setUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout user={user} onLogout={() => setUser(null)}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/media" element={<MediaLibraryPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/overlays" element={<OverlaysPage />} />
        <Route path="/broadcast" element={<BroadcastPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
