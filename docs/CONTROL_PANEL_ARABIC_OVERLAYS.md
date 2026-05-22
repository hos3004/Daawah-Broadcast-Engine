# Control Panel Arabic Naming and Overlay Foundation

This foundation adds preview-only control panel surfaces for Arabic safe naming,
logo overlay settings, and Arabic ASS ticker generation. It does not activate
anything in live playout.

## Safety Status

- Original Arabic filenames and paths are preserved.
- No rename, move, delete, copy, or link action is exposed.
- `/srv/daawah/media/original-ar` remains a protected archive root.
- `/srv/daawah/media/source` remains the scheduling root.
- System identity should use database IDs and safe slugs, not Arabic filenames.
- Overlay outputs are project-controlled JSON/ASS artifacts only.
- No OBS dependency is introduced.
- No live activation, FFmpeg restart, playout mutation, DNS change, RTMP, or
  stream-key path is included in this phase.

## Safe Naming DB Fields

The safe naming control panel displays:

- original Arabic name
- original path
- `display_name`
- `normalized_name`
- `safe_slug`
- root
- review status
- scheduling status
- archive status
- collision group

The import preview supports draft manual slug overrides. Those overrides are
preview data until a later protected import is explicitly confirmed.

The apply endpoint remains guarded by the exact confirmation text:

```text
IMPORT SAFE NAMING
```

Do not run apply against the real DB during this foundation phase.

## Logo Overlay Config

Logo settings are saved as JSON under the project data directory. The model
supports:

- enabled/disabled
- logo path or asset id
- position: top-right, top-left, bottom-right, bottom-left, custom
- x/y margins
- width/height or scale
- opacity
- safe area

Logo paths must stay inside project-controlled asset paths such as:

```text
data/overlay-assets/
assets/overlays/
```

Logo assets must not be written into `/srv/daawah/media`.

## Arabic Ticker as ASS

The ticker generator emits UTF-8 ASS subtitle files for FFmpeg/libass. It does
not rely on OBS, browser capture, or HTML overlays.

Generated artifacts:

```text
data/overlays/tickers/<runId>/ticker.ass
data/overlays/tickers/<runId>/ticker.json
data/overlays/tickers/<runId>/overlay-manifest.json
```

The ASS renderer supports:

- Arabic-capable font family by configurable name
- RTL Arabic text wrapping markers
- moving ticker text
- font size
- text and background color
- background opacity
- ticker opacity
- speed
- top/bottom position
- safe area

Font files are not bundled or shared by this feature.

## تشاهدون اليوم

The “تشاهدون اليوم” mode reads the active published schedule snapshot and builds
Arabic text in this form:

```text
تشاهدون اليوم: 08:00 برنامج كذا • 09:30 برنامج كذا • 11:00 برنامج كذا
```

When safe naming display names are available, the ticker uses those display
names. Otherwise it falls back to the Arabic program title from the schedule.
Times are taken from the schedule snapshot in the configured local schedule
timezone.

## Future FFmpeg Integration

Future direct file-based playout can use the generated artifacts like this:

Logo overlay:

```text
-i input.mp4 -i logo.png -filter_complex "[0:v][1:v]overlay=W-w-32:32:format=auto"
```

ASS ticker overlay:

```text
-vf "subtitles='data/overlays/tickers/<runId>/ticker.ass'"
```

Combined future filter graph:

```text
-i input.mp4 -i logo.png \
-filter_complex "[0:v][1:v]overlay=W-w-32:32:format=auto[logo];[logo]subtitles='ticker.ass'[v]" \
-map "[v]" -map 0:a
```

Those examples are for future playout integration only. This PR does not apply
them to the running 24-hour test or to production.
