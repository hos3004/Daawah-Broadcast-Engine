import {
  parseDays,
  parseTimeToMinutes,
  previewExcelImport,
} from '../schedule/excelPreview';

describe('Excel schedule import preview', () => {
  it('parses times and day aliases', () => {
    expect(parseTimeToMinutes('09:30')).toBe(570);
    expect(parseTimeToMinutes('25:00')).toBeNull();

    expect(parseDays('sat;الأحد mon')).toEqual({
      days: ['sat', 'sun', 'mon'],
      invalidTokens: [],
    });
  });

  it('parses and validates the Settings sheet', () => {
    const result = previewExcelImport({
      settings: [{
        timezone: '',
        schedule_start_date: '2026-06-01',
        schedule_end_date: '2026-07-15',
        default_duration_policy: 'fit',
        default_repeat_policy: 'same_day_same_episode',
        default_gap_policy: 'professional_gap_filler',
      }],
      programs: [],
      slots: [],
    });

    expect(result.settings.timezone).toBe('Europe/Istanbul');
    expect(result.settings.rangeDays).toBe(45);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'TIMEZONE_DEFAULTED',
      'SCHEDULE_RANGE_LONG',
    ]));
  });

  it('reports program sheet validation errors', () => {
    const result = previewExcelImport({
      programs: [
        {
          program_key: 'dupe',
          program_name: 'برنامج',
          folder_hint: 'Series/A',
          folder_root: 'original-ar',
          play_mode: 'sequential',
          slot_mode: 'file_count',
          file_count: '',
          repeat_policy: 'bad_policy',
          enabled: 'maybe',
        },
        {
          program_key: 'dupe',
          program_name: '',
          folder_hint: 'C:\\Media\\Series',
          folder_root: 'unknown-root',
          play_mode: 'random',
          slot_mode: 'single',
          enabled: 'true',
        },
      ],
      slots: [],
    });

    const codes = result.issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      'DUPLICATE_PROGRAM_KEY',
      'MISSING_PROGRAM_NAME',
      'ABSOLUTE_PATH_REJECTED',
      'UNSUPPORTED_FOLDER_ROOT',
      'UNSUPPORTED_PLAY_MODE',
      'UNSUPPORTED_SLOT_MODE',
      'MISSING_FILE_COUNT',
      'INVALID_REPEAT_POLICY',
      'INVALID_ENABLED_VALUE',
    ]));
  });

  it('reports slot validation, overlaps, gaps, and crossing-midnight slots', () => {
    const result = previewExcelImport({
      programs: [
        {
          program_key: 'prog-a',
          program_name: 'برنامج أ',
          folder_hint: 'A',
          folder_root: 'original-ar',
          play_mode: 'sequential',
          slot_mode: 'fit',
          repeat_policy: 'same_day_same_episode',
          enabled: 'true',
        },
        {
          program_key: 'prog-b',
          program_name: 'برنامج ب',
          folder_hint: 'B',
          folder_root: 'original-ar',
          play_mode: 'sequential',
          slot_mode: 'fit',
          repeat_policy: 'same_day_same_episode',
          enabled: 'true',
        },
      ],
      slots: [
        { program_key: 'prog-a', days: 'sat', start_time: '08:00', end_time: '09:00' },
        { program_key: 'prog-b', days: 'sat', start_time: '08:30', end_time: '09:30' },
        { program_key: 'prog-a', days: 'sun', start_time: '10:00', end_time: '11:00' },
        { program_key: 'prog-b', days: 'sun', start_time: '12:00', end_time: '13:00' },
        { program_key: 'prog-a', days: 'wed', start_time: '07:00', duration_minutes: '30' },
        { program_key: 'prog-b', days: 'wed', start_time: '07:00', duration_minutes: '30' },
        { program_key: 'missing', days: 'fri', start_time: '14:00', duration_minutes: '30' },
        { program_key: 'prog-a', days: 'bad-day', start_time: '15:00', duration_minutes: '30' },
        { program_key: 'prog-a', days: 'mon', start_time: '16:00' },
        { program_key: 'prog-a', days: 'tue', start_time: '23:30', end_time: '00:30' },
      ],
    });

    const codes = result.issues.map(issue => issue.code);
    expect(codes).toEqual(expect.arrayContaining([
      'PROGRAM_KEY_NOT_FOUND',
      'INVALID_DAYS',
      'MISSING_DURATION',
      'OVERLAPPING_SLOTS',
      'SLOT_TRIMMED_TO_NEXT_HARD_START',
      'GAP_DETECTED',
      'CROSSING_MIDNIGHT',
    ]));
    expect(result.willActivateSchedule).toBe(false);
    expect(result.willUpdateCursors).toBe(false);
    expect(result.willMaterializePlaylist).toBe(false);
  });

  it('returns normalized rows, folder matching, and slot-only preview without activation', () => {
    const result = previewExcelImport({
      settings: [{
        timezone: 'Europe/Istanbul',
        schedule_start_date: '2026-06-06',
        schedule_end_date: '2026-06-07',
      }],
      programs: [
        {
          program_key: 'tafseer',
          program_name: 'برنامج التفسير',
          folder_hint: 'Tafseer/Season 01',
          folder_root: 'original-ar',
          play_mode: 'sequential',
          slot_mode: 'fit',
          repeat_policy: 'same_day_same_episode',
          enabled: 'true',
        },
        {
          program_key: 'missing-folder',
          program_name: 'برنامج مفقود',
          folder_hint: 'Missing',
          folder_root: 'original-ar',
          play_mode: 'sequential',
          slot_mode: 'fit',
          repeat_policy: 'same_day_same_episode',
          enabled: 'true',
        },
      ],
      slots: [
        { program_key: 'tafseer', days: 'sat', start_time: '08:00', end_time: '09:00' },
      ],
    }, {
      folderCandidates: [{
        folder_id: 'folder-1',
        root_key: 'original-ar',
        original_relative_path: 'Tafseer/Season 01',
        display_name_ar: 'برنامج التفسير',
        normalized_name: 'season 01',
        safe_slug: 'tafseer-season-01',
        file_count: 12,
      }],
    });

    expect(result.programs).toHaveLength(2);
    expect(result.slots).toHaveLength(1);
    expect(result.folderMatches.map(match => match.status)).toEqual(['matched', 'folder_missing']);
    expect(result.summary.matchedPrograms).toBe(1);
    expect(result.summary.missingFolders).toBe(1);
    expect(result.schedulePreview.days[0]?.rows.some(row => row.type === 'gap' && row.title === 'Professional Gap Preview')).toBe(true);
    expect(result.productionSafety).toMatchObject({
      previewOnly: true,
      cursorUpdates: false,
      playlistMaterialization: false,
      ffmpeg: false,
      scheduleActivation: false,
    });
  });
});
