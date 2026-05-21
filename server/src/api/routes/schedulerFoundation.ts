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
import { previewExcelImport, previewExcelImportFromXlsx } from '../../schedule/excelPreview';
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
  if (err instanceof SafeRootError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}
