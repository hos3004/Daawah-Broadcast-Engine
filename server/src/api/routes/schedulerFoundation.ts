import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireRole } from '../../auth';
import {
  generateProgramCandidatesFromIndexedFolders,
  getFolderMatchCandidates,
  getMediaRegistryStatus,
  previewSafeNaming,
  scanMediaRegistry,
} from '../../media/registry';
import { SafeRootError } from '../../media/safeRoots';
import {
  activatePublishedSchedule,
  DraftValidationError,
  getPublishedSchedule,
  getSchedulerDraft,
  getActiveScheduleState,
  listPublishedSchedules,
  listSchedulerDrafts,
  publishSchedulerDraft,
  saveSchedulerDraft,
} from '../../schedule/drafts';
import {
  createPlaylistMaterializationDryRun,
  getPlaylistMaterializationRun,
  listPlaylistMaterializationRuns,
} from '../../schedule/playlistMaterialization';
import {
  previewExcelImport,
  previewExcelImportFromXlsx,
  type ExcelImportPreviewResult,
} from '../../schedule/excelPreview';
import { buildMonthlySchedulePreviewStub } from '../../schedule/monthlyPreview';
import { isSafeUploadMime } from '../../utils/fileUtils';

export const schedulerFoundationRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
      cb(new Error('Only .xlsx preview files are accepted for this foundation endpoint'));
      return;
    }
    if (!isSafeUploadMime(file.mimetype)) {
      cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

schedulerFoundationRouter.get('/media-registry/status', (_req: Request, res: Response): void => {
  res.json(getMediaRegistryStatus());
});

schedulerFoundationRouter.post(
  '/media-registry/scan-preview',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    if (!isMediaScanPreviewEnabled()) {
      res.status(403).json({
        error: 'Media registry scan preview is disabled by default. Set ENABLE_MEDIA_SCAN_PREVIEW=true to enable this read-only preview endpoint.',
        code: 'MEDIA_SCAN_PREVIEW_DISABLED',
      });
      return;
    }

    const body = req.body as {
      root_key?: string;
      maxDepth?: number;
      skipRecentlyModifiedMinutes?: number;
      dryRun?: boolean;
    };

    if (body.dryRun === false) {
      res.status(400).json({ error: 'Foundation scan endpoint is preview-only; dryRun=false is disabled here.' });
      return;
    }

    try {
      res.json(scanMediaRegistry({
        rootKey: body.root_key,
        dryRun: true,
        provisional: true,
        maxDepth: body.maxDepth,
        skipRecentlyModifiedMinutes: body.skipRecentlyModifiedMinutes,
      }));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post('/safe-naming/preview', (req: Request, res: Response): void => {
  const body = req.body as { names?: unknown };
  const names = Array.isArray(body.names) ? body.names.map(value => String(value)) : [];
  res.json({
    mode: 'preview',
    mappings: previewSafeNaming(names),
  });
});

schedulerFoundationRouter.get('/program-candidates', (_req: Request, res: Response): void => {
  res.json(generateProgramCandidatesFromIndexedFolders({ persist: false }));
});

schedulerFoundationRouter.get('/excel-template', (_req: Request, res: Response): void => {
  const templatePath = path.resolve(__dirname, '../../../../docs/templates/scheduler_excel_import_template.xlsx');
  if (!fs.existsSync(templatePath)) {
    res.status(404).json({ error: 'Excel template not found' });
    return;
  }
  res.download(templatePath, 'scheduler_excel_import_template.xlsx');
});

schedulerFoundationRouter.post(
  '/excel-import/preview',
  requireRole('admin', 'editor'),
  upload.single('file'),
  (req: Request, res: Response): void => {
    try {
      if (req.file) {
        res.json(previewExcelImportFromXlsx(req.file.buffer, {
          appTimezone: 'Europe/Istanbul',
          folderCandidates: getFolderMatchCandidates(),
        }));
        return;
      }

      const body = req.body as {
        settings?: Record<string, unknown>[];
        programs?: Record<string, unknown>[];
        slots?: Record<string, unknown>[];
        overrides?: Record<string, unknown>[];
      };

      res.json(previewExcelImport({
        settings: body.settings ?? [],
        programs: body.programs ?? [],
        slots: body.slots ?? [],
        overrides: body.overrides ?? [],
      }, {
        appTimezone: 'Europe/Istanbul',
        folderCandidates: getFolderMatchCandidates(),
      }));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/draft-schedules',
  requireRole('admin', 'editor'),
  (req: Request, res: Response): void => {
    try {
      const body = req.body as {
        name?: string;
        sourceExcel?: {
          filename?: string;
          sha256?: string;
        };
        preview?: unknown;
      };
      const draft = saveSchedulerDraft({
        name: body.name,
        sourceExcel: {
          filename: body.sourceExcel?.filename ?? '',
          sha256: body.sourceExcel?.sha256 ?? '',
        },
        preview: body.preview as ExcelImportPreviewResult,
        createdBy: req.user?.id ?? null,
      });

      res.status(201).json({
        mode: 'draft',
        draft,
        safety: {
          inactiveByDefault: true,
          scheduleActivation: false,
          cursorUpdates: false,
          playlistMaterialization: false,
          ffmpeg: false,
          playout: false,
          broadcast: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/draft-schedules',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const limit = Number(req.query['limit'] ?? 50);
    res.json({
      mode: 'draft-list',
      drafts: listSchedulerDrafts(limit),
    });
  }
);

schedulerFoundationRouter.post(
  '/draft-schedules/:id/publish',
  requireRole('admin', 'editor'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Draft schedule id is required', code: 'DRAFT_ID_REQUIRED' });
      return;
    }

    try {
      const publishedSchedule = publishSchedulerDraft({
        draftId: id,
        publishedBy: req.user?.id ?? null,
      });

      res.status(201).json({
        mode: 'published',
        publishedSchedule,
        safety: {
          inactiveByDefault: true,
          scheduleActivation: false,
          cursorUpdates: false,
          playlistMaterialization: false,
          ffmpeg: false,
          playout: false,
          broadcast: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/draft-schedules/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Draft schedule id is required', code: 'DRAFT_ID_REQUIRED' });
      return;
    }

    const draft = getSchedulerDraft(id);
    if (!draft) {
      res.status(404).json({ error: 'Draft schedule not found', code: 'DRAFT_NOT_FOUND' });
      return;
    }
    res.json({
      mode: 'draft',
      draft,
    });
  }
);

schedulerFoundationRouter.get(
  '/published-schedules',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const limit = Number(req.query['limit'] ?? 50);
    res.json({
      mode: 'published-list',
      publishedSchedules: listPublishedSchedules(limit),
    });
  }
);

schedulerFoundationRouter.get(
  '/active-schedule',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    const activeState = getActiveScheduleState();
    const activeSchedule = activeState ? getPublishedSchedule(activeState.publishedScheduleId) : null;
    res.json({
      mode: 'active-schedule',
      activeState,
      activeSchedule,
      safety: {
        readOnly: true,
        cursorUpdates: false,
        playlistMaterialization: false,
        ffmpeg: false,
        ffprobe: false,
        playout: false,
        broadcast: false,
      },
    });
  }
);

schedulerFoundationRouter.post(
  '/playlist-materialization/dry-run',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    const body = req.body as {
      confirmDryRun?: boolean;
      publishedScheduleId?: string;
      outputRoot?: string;
    };

    try {
      const run = createPlaylistMaterializationDryRun({
        confirmDryRun: body.confirmDryRun,
        publishedScheduleId: body.publishedScheduleId,
        outputRoot: body.outputRoot,
        createdBy: req.user?.id ?? null,
      });
      res.status(201).json({
        mode: 'playlist-materialization-dry-run',
        run,
        safety: {
          dryRun: true,
          cursorUpdates: false,
          playlistArtifactsUsedForPlayout: false,
          ffmpeg: false,
          ffprobe: false,
          playout: false,
          broadcast: false,
          mediaModification: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/playlist-materialization/runs',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const limit = Number(req.query['limit'] ?? 50);
    res.json({
      mode: 'playlist-materialization-run-list',
      runs: listPlaylistMaterializationRuns(limit),
    });
  }
);

schedulerFoundationRouter.get(
  '/playlist-materialization/runs/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Playlist materialization run id is required', code: 'MATERIALIZATION_RUN_ID_REQUIRED' });
      return;
    }

    const run = getPlaylistMaterializationRun(id);
    if (!run) {
      res.status(404).json({ error: 'Playlist materialization run not found', code: 'MATERIALIZATION_RUN_NOT_FOUND' });
      return;
    }
    res.json({
      mode: 'playlist-materialization-run',
      run,
    });
  }
);

schedulerFoundationRouter.post(
  '/published-schedules/:id/activate',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Published schedule id is required', code: 'PUBLISHED_SCHEDULE_ID_REQUIRED' });
      return;
    }

    const body = req.body as {
      scheduleId?: string;
      confirmActivation?: boolean;
      confirmationText?: string;
    };

    try {
      const result = activatePublishedSchedule({
        publishedScheduleId: id,
        requestedScheduleId: body.scheduleId,
        confirmActivation: body.confirmActivation,
        confirmationText: body.confirmationText,
        activatedBy: req.user?.id ?? null,
      });

      res.json({
        mode: 'activated',
        ...result,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/published-schedules/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Published schedule id is required', code: 'PUBLISHED_SCHEDULE_ID_REQUIRED' });
      return;
    }

    const publishedSchedule = getPublishedSchedule(id);
    if (!publishedSchedule) {
      res.status(404).json({ error: 'Published schedule not found', code: 'PUBLISHED_SCHEDULE_NOT_FOUND' });
      return;
    }
    res.json({
      mode: 'published',
      publishedSchedule,
    });
  }
);

schedulerFoundationRouter.get('/validation-result', (_req: Request, res: Response): void => {
  res.json({
    mode: 'preview',
    willActivateSchedule: false,
    willUpdateCursors: false,
    message: 'Validation results are returned by /excel-import/preview in this foundation phase.',
  });
});

schedulerFoundationRouter.get('/monthly-schedule-preview', (_req: Request, res: Response): void => {
  res.json(buildMonthlySchedulePreviewStub());
});

function sendFoundationError(res: Response, err: unknown): void {
  if (err instanceof DraftValidationError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof SafeRootError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}

function isMediaScanPreviewEnabled(): boolean {
  return process.env['ENABLE_MEDIA_SCAN_PREVIEW'] === 'true';
}
