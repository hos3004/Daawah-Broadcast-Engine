import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Film, FolderTree, Calendar, Layers, Radio, ScrollText, LogOut, Wifi, WifiOff } from 'lucide-react';
import { useState, useCallback } from 'react';
import { authApi } from '../api/client';
import { useWebSocket } from '../hooks/useWebSocket';

interface User { id: string; email: string; role: string; }

interface Props {
  user: User;
  onLogout: () => void;
  children: React.ReactNode;
}

const navItems = [
  { to: '/',          label: 'لوحة التحكم',   icon: LayoutDashboard },
  { to: '/media',     label: 'مكتبة الوسائط', icon: Film },
  { to: '/media-browser', label: 'متصفح الوسائط', icon: FolderTree },
  { to: '/schedule',  label: 'الجدول',        icon: Calendar },
  { to: '/overlays',  label: 'الطبقات',       icon: Layers },
  { to: '/broadcast', label: 'التحكم بالبث',  icon: Radio },
  { to: '/logs',      label: 'السجلات',       icon: ScrollText },
];

export default function Layout({ user, onLogout, children }: Props) {
  const navigate = useNavigate();
  const [broadcastStatus, setBroadcastStatus] = useState<string>('idle');

  const handleWsMessage = useCallback((msg: { type: string; data?: unknown }) => {
    if (msg.type === 'broadcast_status') {
      const d = msg.data as { status?: string };
      if (d?.status) setBroadcastStatus(d.status);
    }
  }, []);

  const { connected } = useWebSocket(handleWsMessage);

  const handleLogout = async () => {
    await authApi.logout().catch(() => {});
    onLogout();
    navigate('/login');
  };

  const statusColor =
    broadcastStatus === 'running'   ? 'status-dot-green' :
    broadcastStatus === 'emergency' ? 'status-dot-yellow' :
    broadcastStatus === 'error'     ? 'status-dot-red' : 'status-dot-gray';

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 flex flex-col" style={{ background: 'var(--bg-card)', borderLeft: '1px solid var(--bg-border)' }}>
        {/* Logo */}
        <div className="p-4 border-b" style={{ borderColor: 'var(--bg-border)' }}>
          <h1 className="font-bold text-base" style={{ color: 'var(--accent)' }}>
            Daawah Broadcast
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`status-dot ${statusColor}`} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{broadcastStatus}</span>
            {connected
              ? <Wifi size={12} className="mr-auto" style={{ color: 'var(--success)' }} />
              : <WifiOff size={12} className="mr-auto" style={{ color: 'var(--danger)' }} />
            }
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'font-medium'
                    : 'hover:opacity-80'
                }`
              }
              style={({ isActive }) => ({
                background: isActive ? 'rgba(232,160,32,0.12)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              })}
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="p-3 border-t" style={{ borderColor: 'var(--bg-border)' }}>
          <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
            {user.email}
            <span className="badge badge-info mr-2">{user.role}</span>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-2 text-xs btn-ghost w-full mt-1">
            <LogOut size={12} />
            خروج
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  );
}
