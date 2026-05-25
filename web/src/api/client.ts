import axios from 'axios';

export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.response.use(
  r => r,
  err => {
    const requestUrl = String(err.config?.url ?? '');
    const isSessionProbe = requestUrl.includes('/auth/me');
    const alreadyOnLogin = window.location.pathname === '/admin/login';
    if (err.response?.status === 401 && !isSessionProbe && !alreadyOnLogin) {
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
  programFolders: () => api.get('/media/program-folders'),
  programFolderEpisodes: (folderId: string) => api.get(`/media/program-folders/${folderId}/episodes`),
  trash: () => api.get('/media/trash'),
  trashFile: (mediaFileId: string, reason?: string) => api.post(`/media/files/${mediaFileId}/trash`, { reason }),
  trashProgramFolder: (folderId: string, reason?: string) => api.post(`/media/program-folders/${folderId}/trash`, { reason }),
  restoreTrashItem: (kind: 'file' | 'folder', id: string) => api.post(`/media/trash/${kind}/${id}/restore`),
  deleteTrashItem: (kind: 'file' | 'folder', id: string, adminPassword: string) =>
    api.delete(`/media/trash/${kind}/${id}`, { data: { adminPassword } }),
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
  safeNamingControlPanel: () => api.get('/scheduler-foundation/safe-naming/control-panel'),
  safeNamingImportPreview: (payload: {
    csvContent?: string;
    csvPath?: string;
    manualSlugOverrides?: Record<string, string>;
  }) => api.post('/scheduler-foundation/safe-naming/import-preview', payload),
  safeNamingImportApply: (payload: {
    csvContent?: string;
    csvPath?: string;
    manualSlugOverrides?: Record<string, string>;
    confirmationText?: string;
    dryRun?: boolean;
  }) => api.post('/scheduler-foundation/safe-naming/import-apply', payload),
  safeNamingImportPreviewFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/scheduler-foundation/safe-naming/import-preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  safeNamingImportApplyFile: (file: File, confirmationText: string, dryRun: boolean) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('dryRun', String(dryRun));
    if (!dryRun) {
      fd.append('confirmImport', 'true');
      fd.append('confirmationText', confirmationText);
    }
    return api.post('/scheduler-foundation/safe-naming/import-apply', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  programCandidates: () => api.get('/scheduler-foundation/program-candidates'),
  excelImportPreview: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/scheduler-foundation/excel-import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  scheduleInputPreview: (payload: {
    settings?: Record<string, unknown>[];
    programs?: Record<string, unknown>[];
    slots?: Record<string, unknown>[];
  }) => api.post('/scheduler-foundation/excel-import/preview', payload),
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
  getActiveSchedule: () => api.get('/scheduler-foundation/active-schedule'),
  activatePublishedSchedule: (id: string, payload: {
    scheduleId: string;
    confirmActivation: boolean;
    confirmationText: string;
  }) => api.post(`/scheduler-foundation/published-schedules/${id}/activate`, payload),
  createPlaylistMaterializationDryRun: (payload: {
    confirmDryRun: boolean;
    publishedScheduleId?: string;
  }) => api.post('/scheduler-foundation/playlist-materialization/dry-run', payload),
  listPlaylistMaterializationRuns: () => api.get('/scheduler-foundation/playlist-materialization/runs'),
  getPlaylistMaterializationRun: (id: string) => api.get(`/scheduler-foundation/playlist-materialization/runs/${id}`),
  startMaterializationRunHls: (id: string) =>
    api.post(`/scheduler-foundation/playlist-materialization/runs/${id}/start-hls`),
  createTestPlayoutPlan: (payload: {
    confirmPrepareOnly: boolean;
    sourcePlaylistPath: string;
    outputMode: 'local_file' | 'localhost_hls';
    durationLimitSeconds?: number;
    useControlPanelOverlays?: boolean;
    overlayDate?: string;
  }) => api.post('/scheduler-foundation/test-playout/plans', payload),
  listTestPlayoutPlans: () => api.get('/scheduler-foundation/test-playout/plans'),
  getTestPlayoutPlan: (id: string) => api.get(`/scheduler-foundation/test-playout/plans/${id}`),
  runTestPlayout: (payload: {
    confirmExecution: boolean;
    confirmationText: string;
    sourcePlaylistPath: string;
    outputMode: 'local_file' | 'localhost_hls';
    durationLimitSeconds?: number;
    useControlPanelOverlays?: boolean;
    overlayDate?: string;
  }) => api.post('/scheduler-foundation/test-playout/runs', payload),
  listTestPlayoutRuns: () => api.get('/scheduler-foundation/test-playout/runs'),
  getTestPlayoutRun: (id: string) => api.get(`/scheduler-foundation/test-playout/runs/${id}`),
  getTestPlayoutRunLogs: (id: string, lines?: number) =>
    api.get(`/scheduler-foundation/test-playout/runs/${id}/logs`, { params: { lines } }),
  normalizationStatus: () => api.get('/scheduler-foundation/normalization/status'),
  normalizationPreflight: (payload: {
    scope?: 'active_schedule' | 'published_schedule' | 'media_roots';
    publishedScheduleId?: string;
    rootKeys?: string[];
    limit?: number;
  }) => api.post('/scheduler-foundation/normalization/preflight', payload),
  createNormalizationPlan: (payload: {
    confirmDryRun: boolean;
    scope?: 'active_schedule' | 'published_schedule' | 'media_roots';
    publishedScheduleId?: string;
    rootKeys?: string[];
    limit?: number;
  }) => api.post('/scheduler-foundation/normalization/plans', payload),
  listNormalizationPlans: () => api.get('/scheduler-foundation/normalization/plans'),
  getNormalizationPlan: (id: string) => api.get(`/scheduler-foundation/normalization/plans/${id}`),
  startNormalizationRun: (payload: {
    planId: string;
    confirmExecution: boolean;
    confirmationText: string;
  }) => api.post('/scheduler-foundation/normalization/runs', payload),
  listNormalizationRuns: () => api.get('/scheduler-foundation/normalization/runs'),
  getNormalizationRun: (id: string) => api.get(`/scheduler-foundation/normalization/runs/${id}`),
  getNormalizationRunLogs: (id: string, lines?: number) =>
    api.get(`/scheduler-foundation/normalization/runs/${id}/logs`, { params: { lines } }),
  stopNormalizationRun: (id: string) => api.post(`/scheduler-foundation/normalization/runs/${id}/stop`),
  serverNormalizationStatus: () => api.get('/scheduler-foundation/normalization/server-status'),
  getNormalizationNextTask: () => api.get('/scheduler-foundation/normalization/next-task'),
  saveNormalizationNextTask: (payload: unknown) => api.put('/scheduler-foundation/normalization/next-task', payload),
  publishNormalizedSet: (payload: { runId: string; confirmPublish: boolean }) =>
    api.post('/scheduler-foundation/normalization/sets', payload),
  listNormalizedSets: () => api.get('/scheduler-foundation/normalization/sets'),
  overlaySettings: () => api.get('/scheduler-foundation/overlays/settings'),
  saveOverlaySettings: (payload: unknown) => api.put('/scheduler-foundation/overlays/settings', payload),
  listLogoAssets: () => api.get('/scheduler-foundation/overlays/logo-assets'),
  uploadLogoAsset: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post('/scheduler-foundation/overlays/logo-assets', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  deleteLogoAsset: (id: string) => api.delete(`/scheduler-foundation/overlays/logo-assets/${id}`),
  tickerPreview: (payload: unknown) => api.post('/scheduler-foundation/overlays/ticker/preview', payload),
  tickerExportAss: (payload: unknown) => api.post('/scheduler-foundation/overlays/ticker/export-ass', payload),
  todayScheduleOverlay: (params?: { date?: string; limit?: number }) =>
    api.get('/scheduler-foundation/overlays/today-schedule', { params }),
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
  status: () => api.get('/system/status'),
  disk:   () => api.get('/system/disk'),
  logs:   (type?: string, lines?: number) => api.get('/system/logs', { params: { type, lines } }),
  audit:  (params?: Record<string, string>) => api.get('/system/audit', { params }),
};
