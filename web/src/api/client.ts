import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      window.location.href = '/admin/login';
    }
    return Promise.reject(err);
  }
);

// Auth
export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: { id: string; email: string; role: string } }>('/auth/login', { email, password }),
  logout: () => api.post('/auth/logout'),
  me: () => api.get<{ user: { id: string; email: string; role: string } }>('/auth/me'),
};

// Media
export const mediaApi = {
  scan:      () => api.post('/media/scan'),
  files:     (params?: Record<string, string>) => api.get('/media/files', { params }),
  stats:     () => api.get('/media/stats'),
  browserRoots: () => api.get('/media/browser/roots'),
  browserList: (params: Record<string, string>) => api.get('/media/browser/list', { params }),
  scanBrowserFolder: (rootId: string, pathValue: string) =>
    api.post('/media/browser/scan', { rootId, path: pathValue }),
  programs:  () => api.get('/media/programs'),
  episodes:  (programId?: string) => api.get('/media/episodes', { params: programId ? { program_id: programId } : {} }),
  transcode: (mediaFileId: string) => api.post('/media/transcode', { media_file_id: mediaFileId }),
};

// Schedule
export const scheduleApi = {
  list:    () => api.get('/schedules'),
  get:     (id: string) => api.get(`/schedules/${id}`),
  import:  (file: File, name?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (name) fd.append('name', name);
    return api.post('/schedules/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  validate: (id: string) => api.post(`/schedules/validate/${id}`),
  publish:  (id: string) => api.post(`/schedules/publish/${id}`),
  dayItems: (date: string) => api.get(`/schedules/items/${date}`),
  playlist: (date: string) => api.get(`/schedules/playlist/${date}`),
  buildPlaylist: (date: string) => api.post(`/schedules/playlist/build/${date}`),
};

// Scheduler foundation preview APIs
export const schedulerFoundationApi = {
  excelTemplateUrl: '/api/scheduler-foundation/excel-template',
  registryStatus: () => api.get('/scheduler-foundation/media-registry/status'),
  scanPreview: (payload?: { root_key?: string; maxDepth?: number; skipRecentlyModifiedMinutes?: number }) =>
    api.post('/scheduler-foundation/media-registry/scan-preview', payload ?? {}),
  safeNamingPreview: (names: string[]) =>
    api.post('/scheduler-foundation/safe-naming/preview', { names }),
  programCandidates: () => api.get('/scheduler-foundation/program-candidates'),
  excelImportPreview: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/scheduler-foundation/excel-import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  saveDraftSchedule: (payload: {
    name?: string;
    sourceExcel: { filename: string; sha256: string };
    preview: unknown;
  }) => api.post('/scheduler-foundation/draft-schedules', payload),
  listDraftSchedules: () => api.get('/scheduler-foundation/draft-schedules'),
  getDraftSchedule: (id: string) => api.get(`/scheduler-foundation/draft-schedules/${id}`),
  publishDraftSchedule: (id: string) => api.post(`/scheduler-foundation/draft-schedules/${id}/publish`),
  listPublishedSchedules: () => api.get('/scheduler-foundation/published-schedules'),
  getPublishedSchedule: (id: string) => api.get(`/scheduler-foundation/published-schedules/${id}`),
  activatePublishedSchedule: (id: string, payload: {
    scheduleId: string;
    confirmActivation: boolean;
    confirmationText: string;
  }) => api.post(`/scheduler-foundation/published-schedules/${id}/activate`, payload),
  validationResult: () => api.get('/scheduler-foundation/validation-result'),
  monthlyPreview: () => api.get('/scheduler-foundation/monthly-schedule-preview'),
};

// Broadcast
export const broadcastApi = {
  start:     () => api.post('/broadcast/start'),
  stop:      () => api.post('/broadcast/stop'),
  restart:   () => api.post('/broadcast/restart'),
  emergency: () => api.post('/broadcast/emergency'),
  status:    () => api.get('/broadcast/status'),
  now:       () => api.get('/broadcast/now'),
};

// Overlays
export const overlaysApi = {
  convertLogo:       (sourcePath?: string, fps?: number) => api.post('/overlays/logo/convert', { source_path: sourcePath, fps }),
  generateTicker:    (date: string) => api.post(`/overlays/ticker/generate/${date}`),
  generateTickerMonth: (yearMonth: string) => api.post('/overlays/ticker/generate-month', { year_month: yearMonth }),
  generateNowPlaying: (playlistItemId: string) => api.post(`/overlays/now-playing/${playlistItemId}`),
};

// System
export const systemApi = {
  health: () => api.get('/system/health'),
  disk:   () => api.get('/system/disk'),
  logs:   (type?: string, lines?: number) => api.get('/system/logs', { params: { type, lines } }),
  audit:  (params?: Record<string, string>) => api.get('/system/audit', { params }),
};
