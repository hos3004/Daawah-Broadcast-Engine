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
import {
  applySafeNamingImport,
  getSafeNamingControlPanel,
  previewSafeNamingImport,
  SafeNamingControlError,
} from '../../media/safeNamingControl';
import {
  APPLY_CONFIRMATION_TEXT,
  applyImportPlan,
  previewImportPlan,
  SafeNamingImportError,
} from '../../media/safeNamingImport';
import { SafeRootError } from '../../media/safeRoots';
import {
  createNormalizationPlanDryRun,
  createNormalizationPreflight,
  getNormalizationPlan,
  getNormalizationRun,
  getNormalizationStatus,
  getServerNormalizationNextTask,
  getServerNormalizationStatus,
  listNormalizationPlans,
  listNormalizationRuns,
  listNormalizedSets,
  NormalizationManagerError,
  publishNormalizedSet,
  readNormalizationRunLog,
  saveServerNormalizationNextTask,
  startNormalizationRun,
  stopNormalizationRun,
  type ServerNormalizationNextTaskConfig,
  type NormalizationPlanInput,
  type NormalizationPreflightInput,
  type NormalizationRunInput,
} from '../../media/normalizationManager';
import {
  buildTickerPreview,
  deleteLogoAsset,
  exportTickerAss,
  getOverlaySettings,
  getTodayScheduleItems,
  listLogoAssets,
  saveLogoAsset,
  saveOverlaySettings,
} from '../../overlays/controlPanel';
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
  listTestPlayoutPlans,
  listTestPlayoutRuns,
  readTestPlayoutPlan,
  readTestPlayoutRun,
  readTestPlayoutRunLog,
  runIsolatedTestPlayout,
  writeTestPlayoutPlan,
  type TestPlayoutPlanInput,
  type TestPlayoutRunInput,
} from '../../playout/testPlayout';
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

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv') {
      cb(new Error('Only .csv files are accepted'));
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

const logoAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

schedulerFoundationRouter.get(
  '/safe-naming/control-panel',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json(getSafeNamingControlPanel());
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/safe-naming/import-preview',
  requireRole('admin', 'editor'),
  csvUpload.single('file'),
  (req: Request, res: Response): void => {
    const body = req.body as {
      csvContent?: string;
      csvPath?: string;
      manualSlugOverrides?: Record<string, string>;
    };

    try {
      if (req.file) {
        res.json(previewImportPlan({ csvContent: req.file.buffer.toString('utf8') }));
        return;
      }

      res.json(previewSafeNamingImport({
        csvContent: body.csvContent,
        csvPath: body.csvPath,
        manualSlugOverrides: body.manualSlugOverrides,
      }));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/safe-naming/import-apply',
  requireRole('admin'),
  csvUpload.single('file'),
  (req: Request, res: Response): void => {
    const body = req.body as {
      csvContent?: string;
      csvPath?: string;
      manualSlugOverrides?: Record<string, string>;
      confirmationText?: string;
      confirmImport?: string;
      dryRun?: boolean | string;
      importReadyOnly?: string;
    };

    try {
      if (req.file) {
        const dryRun = body.dryRun !== false && body.dryRun !== 'false';
        if (!dryRun) {
          if (body.confirmImport !== 'true') {
            res.status(400).json({ error: 'Confirm import is required for non-dry-run apply', code: 'CONFIRM_IMPORT_REQUIRED' });
            return;
          }
          if (body.confirmationText !== APPLY_CONFIRMATION_TEXT) {
            res.status(400).json({
              error: `Confirmation text mismatch. Expected: "${APPLY_CONFIRMATION_TEXT}"`,
              code: 'CONFIRMATION_TEXT_MISMATCH',
            });
            return;
          }
        }

        const result = applyImportPlan({
          csvContent: req.file.buffer.toString('utf8'),
          importReadyOnly: body.importReadyOnly !== 'false',
          dryRun,
          confirmationText: dryRun ? APPLY_CONFIRMATION_TEXT : body.confirmationText,
        });

        if (dryRun) {
          res.json(result);
          return;
        }

        res.status(201).json({
          ...result,
          safety: {
            safeNameMappingsWritten: result.safeNameMappingsWritten,
            programCandidatesWritten: result.programCandidatesWritten,
            schedulerActivation: false,
            cursorUpdates: false,
            playlistMaterialization: false,
            ffmpeg: false,
            playout: false,
            broadcast: false,
            mediaModification: false,
          },
        });
        return;
      }

      const controlDryRun = body.dryRun === undefined
        ? undefined
        : body.dryRun === false || body.dryRun === 'false'
          ? false
          : true;

      res.json(applySafeNamingImport({
        csvContent: body.csvContent,
        csvPath: body.csvPath,
        manualSlugOverrides: body.manualSlugOverrides,
        confirmationText: body.confirmationText,
        dryRun: controlDryRun,
      }));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/program-candidates/import',
  requireRole('admin'),
  csvUpload.single('file'),
  (req: Request, res: Response): void => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'CSV file is required', code: 'CSV_REQUIRED' });
        return;
      }
      const body = req.body as {
        dryRun?: string;
        confirmImport?: string;
        confirmationText?: string;
      };
      const dryRun = body.dryRun !== 'false';

      if (!dryRun) {
        if (body.confirmImport !== 'true') {
          res.status(400).json({ error: 'Confirm import is required for non-dry-run apply', code: 'CONFIRM_IMPORT_REQUIRED' });
          return;
        }
        if (body.confirmationText !== APPLY_CONFIRMATION_TEXT) {
          res.status(400).json({
            error: `Confirmation text mismatch. Expected: "${APPLY_CONFIRMATION_TEXT}"`,
            code: 'CONFIRMATION_TEXT_MISMATCH',
          });
          return;
        }
      }

      const result = applyImportPlan({
        csvContent: req.file.buffer.toString('utf8'),
        importReadyOnly: true,
        dryRun,
        confirmationText: dryRun ? APPLY_CONFIRMATION_TEXT : body.confirmationText,
      });

      if (dryRun) {
        res.json(result);
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

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
  '/test-playout/plans',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    const body = req.body as TestPlayoutPlanInput;

    try {
      const plan = writeTestPlayoutPlan(body);
      res.status(201).json({
        mode: 'test-playout-plan',
        plan,
        safety: {
          prepareOnly: true,
          ffmpegExecution: false,
          playoutStarted: false,
          broadcastStarted: false,
          rtmpPush: false,
          streamKeyUsage: false,
          cursorUpdates: false,
          mediaAccess: false,
          dnsChanges: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/test-playout/plans',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const limit = Number(req.query['limit'] ?? 50);
    res.json({
      mode: 'test-playout-plan-list',
      plans: listTestPlayoutPlans(limit),
      safety: {
        readOnly: true,
        ffmpegExecution: false,
        playoutStarted: false,
        broadcastStarted: false,
      },
    });
  }
);

schedulerFoundationRouter.get(
  '/test-playout/plans/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Test playout plan id is required', code: 'TEST_PLAYOUT_PLAN_ID_REQUIRED' });
      return;
    }

    const plan = readTestPlayoutPlan(id);
    if (!plan) {
      res.status(404).json({ error: 'Test playout plan not found', code: 'TEST_PLAYOUT_PLAN_NOT_FOUND' });
      return;
    }
    res.json({
      mode: 'test-playout-plan',
      plan,
      safety: {
        readOnly: true,
        ffmpegExecution: false,
        playoutStarted: false,
        broadcastStarted: false,
      },
    });
  }
);

schedulerFoundationRouter.post(
  '/test-playout/runs',
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as TestPlayoutRunInput;

    try {
      const run = await runIsolatedTestPlayout(body);
      res.status(run.status === 'completed' ? 201 : 500).json({
        mode: 'test-playout-run',
        run,
        safety: {
          isolated: true,
          ffmpegExecution: true,
          playoutStarted: true,
          broadcastStarted: false,
          rtmpPush: false,
          streamKeyUsage: false,
          cursorUpdates: false,
          dnsChanges: false,
          productionPaths: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/test-playout/runs',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      const limit = Number(req.query['limit'] ?? 50);
      res.json({
        mode: 'test-playout-run-list',
        runs: listTestPlayoutRuns(limit),
        safety: {
          readOnly: true,
          broadcastStarted: false,
          rtmpPush: false,
          streamKeyUsage: false,
          productionPaths: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/test-playout/runs/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Test playout run id is required', code: 'TEST_PLAYOUT_RUN_ID_REQUIRED' });
      return;
    }

    try {
      const run = readTestPlayoutRun(id);
      if (!run) {
        res.status(404).json({ error: 'Test playout run not found', code: 'TEST_PLAYOUT_RUN_NOT_FOUND' });
        return;
      }
      res.json({
        mode: 'test-playout-run',
        run,
        safety: {
          readOnly: true,
          broadcastStarted: false,
          rtmpPush: false,
          streamKeyUsage: false,
          productionPaths: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/test-playout/runs/:id/logs',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Test playout run id is required', code: 'TEST_PLAYOUT_RUN_ID_REQUIRED' });
      return;
    }

    try {
      res.json({
        mode: 'test-playout-run-log',
        log: readTestPlayoutRunLog(id, Number(req.query['lines'] ?? 200)),
        safety: {
          readOnly: true,
          broadcastStarted: false,
          productionPaths: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
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

schedulerFoundationRouter.get(
  '/normalization/status',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json(getNormalizationStatus());
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/server-status',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json(getServerNormalizationStatus());
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/next-task',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json(getServerNormalizationNextTask());
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.put(
  '/normalization/next-task',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    try {
      res.json(saveServerNormalizationNextTask(req.body as Partial<ServerNormalizationNextTaskConfig>));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/normalization/preflight',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json(createNormalizationPreflight(req.body as NormalizationPreflightInput));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/normalization/plans',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    try {
      const plan = createNormalizationPlanDryRun(req.body as NormalizationPlanInput, req.user?.id ?? null);
      res.status(201).json({
        mode: 'normalization-plan',
        plan,
        safety: plan.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/plans',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json({
        mode: 'normalization-plan-list',
        plans: listNormalizationPlans(Number(req.query['limit'] ?? 20)),
        safety: {
          readOnly: true,
          ffmpegExecution: false,
          mediaModification: false,
          broadcast: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/plans/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Normalization plan id is required', code: 'NORMALIZATION_PLAN_ID_REQUIRED' });
      return;
    }

    try {
      const plan = getNormalizationPlan(id);
      if (!plan) {
        res.status(404).json({ error: 'Normalization plan not found', code: 'NORMALIZATION_PLAN_NOT_FOUND' });
        return;
      }
      res.json({
        mode: 'normalization-plan',
        plan,
        safety: plan.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/normalization/runs',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    try {
      const run = startNormalizationRun(req.body as NormalizationRunInput);
      res.status(202).json({
        mode: 'normalization-run',
        run,
        safety: run.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/runs',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json({
        mode: 'normalization-run-list',
        runs: listNormalizationRuns(Number(req.query['limit'] ?? 20)),
        safety: {
          readOnly: true,
          originalMediaModification: false,
          playlistActivation: false,
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
  '/normalization/runs/:id',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Normalization run id is required', code: 'NORMALIZATION_RUN_ID_REQUIRED' });
      return;
    }

    try {
      const run = getNormalizationRun(id);
      if (!run) {
        res.status(404).json({ error: 'Normalization run not found', code: 'NORMALIZATION_RUN_NOT_FOUND' });
        return;
      }
      res.json({
        mode: 'normalization-run',
        run,
        safety: run.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/runs/:id/logs',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Normalization run id is required', code: 'NORMALIZATION_RUN_ID_REQUIRED' });
      return;
    }

    try {
      res.json({
        mode: 'normalization-run-log',
        log: readNormalizationRunLog(id, Number(req.query['lines'] ?? 240)),
        safety: {
          readOnly: true,
          originalMediaModification: false,
          playlistActivation: false,
          playout: false,
          broadcast: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/normalization/runs/:id/stop',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Normalization run id is required', code: 'NORMALIZATION_RUN_ID_REQUIRED' });
      return;
    }

    try {
      const run = stopNormalizationRun({ runId: id });
      res.json({
        mode: 'normalization-run-stop',
        run,
        safety: run.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/normalization/sets',
  requireRole('admin'),
  (req: Request, res: Response): void => {
    try {
      const set = publishNormalizedSet(req.body as { runId?: string; confirmPublish?: boolean });
      res.status(201).json({
        mode: 'normalized-set',
        set,
        safety: set.safety,
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/normalization/sets',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json({
        mode: 'normalized-set-list',
        sets: listNormalizedSets(Number(req.query['limit'] ?? 20)),
        safety: {
          readOnly: true,
          deletesOriginal: false,
          mediaModification: false,
          playlistActivation: false,
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
  '/overlays/settings',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json(getOverlaySettings());
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.put(
  '/overlays/settings',
  requireRole('admin', 'editor'),
  (req: Request, res: Response): void => {
    try {
      res.json(saveOverlaySettings(req.body as Record<string, unknown>));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/overlays/logo-assets',
  requireRole('admin', 'editor', 'operator'),
  (_req: Request, res: Response): void => {
    try {
      res.json({
        mode: 'logo-asset-list',
        assets: listLogoAssets(),
        safety: {
          previewOnly: true,
          mediaWrites: false,
          liveActivation: false,
          restartPlayout: false,
          ffmpegExecution: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/overlays/logo-assets',
  requireRole('admin', 'editor'),
  logoAssetUpload.single('file'),
  (req: Request, res: Response): void => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Logo asset file is required', code: 'LOGO_ASSET_REQUIRED' });
        return;
      }
      const asset = saveLogoAsset({
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        buffer: req.file.buffer,
      });
      res.status(201).json({
        mode: 'logo-asset',
        asset,
        safety: {
          previewOnly: true,
          outputRoot: 'data/overlay-assets',
          mediaWrites: false,
          liveActivation: false,
          restartPlayout: false,
          ffmpegExecution: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.delete(
  '/overlays/logo-assets/:id',
  requireRole('admin', 'editor'),
  (req: Request, res: Response): void => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Logo asset id is required', code: 'LOGO_ASSET_ID_REQUIRED' });
        return;
      }
      const asset = deleteLogoAsset(id);
      if (!asset) {
        res.status(404).json({ error: 'Logo asset not found', code: 'LOGO_ASSET_NOT_FOUND' });
        return;
      }
      res.json({
        mode: 'logo-asset-deleted',
        asset,
        safety: {
          previewOnly: true,
          mediaWrites: false,
          liveActivation: false,
          restartPlayout: false,
          ffmpegExecution: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/overlays/ticker/preview',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json(buildTickerPreview(req.body as Record<string, unknown>));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.post(
  '/overlays/ticker/export-ass',
  requireRole('admin', 'editor'),
  (req: Request, res: Response): void => {
    try {
      res.status(201).json(exportTickerAss(req.body as Record<string, unknown>));
    } catch (err) {
      sendFoundationError(res, err);
    }
  }
);

schedulerFoundationRouter.get(
  '/overlays/today-schedule',
  requireRole('admin', 'editor', 'operator'),
  (req: Request, res: Response): void => {
    try {
      res.json({
        mode: 'today-schedule',
        date: typeof req.query['date'] === 'string' ? req.query['date'] : undefined,
        items: getTodayScheduleItems({
          date: typeof req.query['date'] === 'string' ? req.query['date'] : undefined,
          limit: Number(req.query['limit'] ?? 12),
        }),
        safety: {
          readOnly: true,
          liveActivation: false,
          restartPlayout: false,
          ffmpegExecution: false,
          broadcast: false,
        },
      });
    } catch (err) {
      sendFoundationError(res, err);
    }
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
  if (err instanceof SafeNamingControlError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof SafeNamingImportError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof NormalizationManagerError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}

function isMediaScanPreviewEnabled(): boolean {
  return process.env['ENABLE_MEDIA_SCAN_PREVIEW'] === 'true';
}
