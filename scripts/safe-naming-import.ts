import path from 'path';
import { initDb, closeDb } from '../server/src/db/schema';
import {
  APPLY_CONFIRMATION_TEXT,
  previewImportPlan,
  applyImportPlan,
  findLatestImportCsv,
  readCsvFromFile,
  SafeNamingImportError,
} from '../server/src/media/safeNamingImport';
import { config } from '../server/src/config';

function printUsage(): void {
  console.log(`
Usage:
  npx ts-node scripts/safe-naming-import.ts <command> [options]

Commands:
  preview [--csv <path>]    Preview a safe naming import CSV (read-only)
  apply   [--csv <path>]    Apply a safe naming import CSV to the database
                            (dry-run by default; requires --confirm and --no-dry-run)

Options:
  --csv <path>              Path to the safe-name-db-import-plan CSV file.
                            If not provided, searches for the latest file in
                            SAFE_NAMING_IMPORT_DIR or the reports directory.

  --reports-dir <path>      Directory to search for CSV files (default:
                            /opt/daawah-broadcast-test/reports)

  --ready-only              Only import entries with review_status=ready
                            (default: true for 'apply')

  --no-ready-only           Attempt to import all entries (fails if any
                            needs_review entries exist)

  --no-dry-run              Actually write to the database (for 'apply')
                            WARNING: This modifies the database.
                            REQUIRES: --confirm "${APPLY_CONFIRMATION_TEXT}"

  --confirm "<text>"        Required for --no-dry-run. Must be exactly:
                            "${APPLY_CONFIRMATION_TEXT}"

  --help                    Show this help message

Examples:
  npx ts-node scripts/safe-naming-import.ts preview \\
    --csv /opt/daawah-broadcast-test/reports/safe-name-db-import-plan-20260522.csv
  npx ts-node scripts/safe-naming-import.ts preview
  npx ts-node scripts/safe-naming-import.ts apply \\
    --csv /opt/daawah-broadcast-test/reports/safe-name-db-import-plan-20260522.csv \\
    --no-dry-run --confirm "${APPLY_CONFIRMATION_TEXT}"
  npx ts-node scripts/safe-naming-import.ts apply
`);
}

function parseArgs(): Record<string, string | boolean> {
  const args = process.argv.slice(2);
  const parsed: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--help') {
      parsed['help'] = true;
      continue;
    }

    if (arg === 'preview' || arg === 'apply') {
      parsed['command'] = arg;
      continue;
    }

    if (arg.startsWith('--no-')) {
      const key = arg.slice(5);
      parsed[key] = false;
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--') && next !== 'preview' && next !== 'apply') {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }

  return parsed;
}

function main(): void {
  const opts = parseArgs();

  if (opts['help']) {
    printUsage();
    process.exit(0);
  }

  const command = opts['command'] as string | undefined;
  if (!command || (command !== 'preview' && command !== 'apply')) {
    console.error('Error: missing command. Use "preview" or "apply".');
    printUsage();
    process.exit(1);
  }

  let csvPath = opts['csv'] as string | undefined;
  const reportsDir = (opts['reports-dir'] as string) ?? '/opt/daawah-broadcast-test/reports';

  if (!csvPath) {
    csvPath = findLatestImportCsv(reportsDir) ?? undefined;
    if (!csvPath) {
      csvPath = findLatestImportCsv(process.env['SAFE_NAMING_IMPORT_DIR']) ?? undefined;
    }
  }

  if (!csvPath) {
    console.error('Error: no CSV file specified and no import CSV found.');
    console.error('Provide --csv <path> or set SAFE_NAMING_IMPORT_DIR.');
    process.exit(1);
  }

  console.log(`\n  Safe Naming Import Tool`);
  console.log(`  ${'='.repeat(40)}\n`);
  console.log(`  Command:  ${command}`);
  console.log(`  CSV path: ${csvPath}`);
  console.log();

  if (command === 'preview') {
    const csvContent = readCsvFromFile(csvPath);
    const preview = previewImportPlan({ csvContent });

    console.log(`  Entry count:         ${preview.entryCount}`);
    console.log(`  Ready to import:     ${preview.readyCount}`);
    console.log(`  Needs review:        ${preview.needsReviewCount}`);
    console.log(`  Program candidates:  ${preview.programCandidateCount}`);
    console.log();

    if (preview.byRoot.length > 0) {
      console.log(`  By Root:`);
      for (const item of preview.byRoot) {
        console.log(`    ${item.root}: ${item.count}`);
      }
      console.log();
    }

    if (preview.collisionGroups.length > 0) {
      console.log(`  Collision Groups:`);
      for (const item of preview.collisionGroups) {
        console.log(`    ${item.group}: ${item.entries} entries`);
      }
      console.log();
    }

    if (preview.slugCollisions.length > 0) {
      console.log(`  Slug Collisions (must be resolved before apply):`);
      for (const item of preview.slugCollisions) {
        console.log(`    ${item.slug}: ${item.entries} entries`);
      }
      console.log();
    }

    if (preview.sampleNeedsReview.length > 0) {
      console.log(`  Needs Review (sample):`);
      for (const item of preview.sampleNeedsReview) {
        console.log(`    ${item.originalName} — ${item.reason}`);
      }
      console.log();
    }

    console.log(`  Preview complete. No data was written.`);
    return;
  }

  if (command === 'apply') {
    const dryRun = opts['dry-run'] !== false;
    const importReadyOnly = opts['ready-only'] !== false;
    const confirmText = opts['confirm'] as string | undefined;

    if (!dryRun && (!confirmText || confirmText !== APPLY_CONFIRMATION_TEXT)) {
      console.error(`  Error: --no-dry-run requires --confirm "${APPLY_CONFIRMATION_TEXT}"`);
      console.error(`  Got: --confirm "${confirmText ?? ''}"`);
      process.exit(1);
    }

    console.log(`  Ready only:          ${importReadyOnly}`);
    console.log(`  Mode:                ${dryRun ? 'dry_run' : 'APPLY (live)'}`);
    console.log();

    if (!dryRun) {
      console.log(`  ⚠  WARNING: --no-dry-run is set. Data WILL be written to the database.`);
      console.log(`  ⚠  Confirmation received: "${confirmText}"`);
      console.log();
    }

    try {
      initDb();
      const csvContent = readCsvFromFile(csvPath);

      const result = applyImportPlan({
        csvContent,
        dryRun,
        importReadyOnly,
        confirmationText: confirmText,
      });

      console.log(`  Safe name mappings:  ${result.safeNameMappingsWritten}`);
      console.log(`  Program candidates:  ${result.programCandidatesWritten}`);
      console.log(`  Skipped (needs review): ${result.skippedNeedsReview}`);
      console.log();

      if (result.errors.length > 0) {
        console.log(`  Warnings:`);
        for (const err of result.errors) {
          console.log(`    ⚠  ${err}`);
        }
        console.log();
      }

      if (result.mode === 'dry_run') {
        console.log(`  Dry-run complete. No data was written.`);
        console.log(`  To apply, run with --no-dry-run --confirm "${APPLY_CONFIRMATION_TEXT}"`);
      } else {
        console.log(`  Import applied successfully.`);
        console.log(`  Media files on disk were NOT modified.`);
      }

      closeDb();
    } catch (err) {
      if (err instanceof SafeNamingImportError) {
        console.error(`  [${err.code}] ${err.message}`);
      } else {
        console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  }
}

main();
