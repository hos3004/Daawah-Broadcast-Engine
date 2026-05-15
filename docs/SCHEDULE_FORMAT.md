# Schedule Format

The schedule represents a 3-month broadcast plan. It is imported once, validated, then published as the active schedule. A daily playlist is built from it each night.

---

## Supported Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| JSON   | `.json`   | Recommended — most flexible |
| CSV    | `.csv`    | Simple tabular format |
| Excel  | `.xlsx`   | First sheet is read |

---

## JSON Format

An array of schedule items:

```json
[
  {
    "date": "2025-06-01",
    "start_time": "06:00",
    "type": "program",
    "program_id": "uuid-of-program",
    "episode_id": "uuid-of-episode",
    "title": "برنامج الفجر",
    "expected_duration": 1800,
    "duration_policy": "exact"
  }
]
```

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | `YYYY-MM-DD` | ✅ | Air date |
| `start_time` | `HH:MM` or `HH:MM:SS` | ✅ | Start time (24-hour) |
| `type` | string | ✅ | Item type (see below) |
| `title` | string | ✅ | Display name (Arabic supported) |
| `program_id` | UUID | ✗ | Link to a program in the library |
| `episode_id` | UUID | ✗ | Link to a specific episode |
| `expected_duration` | number (seconds) | ✗ | Expected running time |
| `duration_policy` | string | ✗ | How to handle duration (see below) |

---

## Item Types

| Type | Description |
|------|-------------|
| `program` | Main show — shows lower third overlay |
| `filler` | Gap filler content (bumpers, idents) |
| `quran` | Quran recitation segment |
| `promo` | Channel promo / advertisement |
| `emergency` | Emergency fallback content |

---

## Duration Policies

| Policy | Behaviour |
|--------|-----------|
| `exact` | Play the file to its natural end. Gap/overlap handled by gap filler. |
| `fit` | Trim or pad to fit exactly within the slot duration. |
| `allow_overrun` | Play the full file even if it runs past the next slot start. |
| `fill_gap` | Play the file, then fill remaining time with fillers. |

**Default:** `exact`

---

## CSV Format

The CSV header row must contain these column names (order does not matter):

```
date,start_time,type,program_id,episode_id,title,expected_duration,duration_policy
```

Example:
```csv
date,start_time,type,program_id,episode_id,title,expected_duration,duration_policy
2025-06-01,06:00,program,,,برنامج الفجر,1800,exact
2025-06-01,07:30,quran,,,تلاوة قرآنية,3600,fill_gap
2025-06-01,18:00,program,,,برنامج المساء,3600,exact
```

- Empty `program_id` / `episode_id` cells are allowed (leave blank or omit)
- File must be UTF-8 encoded for Arabic text

---

## Validation Rules

Before a schedule can be published, it must pass validation:

| Rule | Severity |
|------|----------|
| Time conflict (two items overlap) | 🔴 Error |
| No media assigned to a `program` type item | 🔴 Error |
| Episode not found in library | 🔴 Error |
| Program has no ready episodes | 🔴 Error |
| Time gap between items > 1 minute | ⚠️ Warning |
| Item has no `expected_duration` | ⚠️ Warning |
| Episode appears twice on same day | ⚠️ Warning |

Schedules with **errors** cannot be published. Warnings can be accepted.

---

## Workflow

```
Import → Validate → Publish
                      │
              Daily Playlist Builder (23:00)
                      │
               YYYY-MM-DD.json
                      │
              FFmpeg Broadcast Runner
```

1. Import via Admin Dashboard → **الجدول** → **استيراد جدول**
2. Validate: click **تحقق** on the imported schedule
3. Review validation report — fix any errors in the source file and re-import if needed
4. Publish: click **نشر** to activate the schedule
5. The playlist builder runs automatically at 23:00 and builds next day's playlist

---

## Multiple Active Schedules

Only **one** schedule can be in `published` state at a time. Publishing a new one replaces the previous. Old schedules are archived.

---

## Sample Files

- [`samples/schedules/sample-7days.json`](../samples/schedules/sample-7days.json)
- [`samples/schedules/sample-7days.csv`](../samples/schedules/sample-7days.csv)
