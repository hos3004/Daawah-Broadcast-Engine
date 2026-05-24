#!/usr/bin/env python3
import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path


SOURCE_ROOT = Path(os.environ.get("NORMALIZE_SOURCE_ROOT", "/srv/daawah/media/original-ar")).resolve()
OUTPUT_ROOT = Path(os.environ.get("NORMALIZE_OUTPUT_ROOT", "/srv/daawah/media/normalized-ar")).resolve()
MAX_PARALLEL = max(1, min(10, int(os.environ.get("NORMALIZE_MAX_PARALLEL", "5"))))
LIMIT = int(os.environ["NORMALIZE_LIMIT"]) if os.environ.get("NORMALIZE_LIMIT") else None
MANIFEST_PATH = os.environ.get("NORMALIZE_MANIFEST")
DRY_RUN = os.environ.get("DRY_RUN", "0") in {"1", "true", "yes"}
DELETE_ORIGINAL = os.environ.get("DELETE_ORIGINAL_AFTER_VALIDATION", "0") in {"1", "true", "yes"}
DELETE_CONFIRMATION = "DELETE ORIGINAL AFTER VALIDATION"
MAX_VIDEO_BITRATE = int(os.environ.get("NORMALIZE_MAX_VIDEO_BITRATE", "3500000"))
VIDEO_BITRATE = os.environ.get("NORMALIZE_VIDEO_BITRATE", "2500k")
VIDEO_MAXRATE = os.environ.get("NORMALIZE_VIDEO_MAXRATE", "3500k")
VIDEO_BUFSIZE = os.environ.get("NORMALIZE_VIDEO_BUFSIZE", "7000k")
AUDIO_BITRATE = os.environ.get("NORMALIZE_AUDIO_BITRATE", "192k")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
TARGET_WIDTH = 1280
TARGET_HEIGHT = 720
TARGET_FPS = 25.0
TARGET_AUDIO_RATE = 48000
TARGET_AUDIO_CHANNELS = 2
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".mxf", ".webm", ".ts"}

RUN_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
REPORT_DIR = OUTPUT_ROOT / "reports"
LOG_DIR = OUTPUT_ROOT / "logs_continue"
REPORT_PATH = REPORT_DIR / f"continue_normalize_ar_{RUN_ID}.csv"
LOCK = threading.Lock()
STARTED_AT = datetime.now()


def log(message: str) -> None:
    print(message, flush=True)


def ensure_safe_config() -> None:
    if not SOURCE_ROOT.exists():
        raise SystemExit(f"source root missing: {SOURCE_ROOT}")
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if DELETE_ORIGINAL and os.environ.get("DELETE_CONFIRMATION") != DELETE_CONFIRMATION:
        raise SystemExit(f"DELETE_CONFIRMATION must be exactly: {DELETE_CONFIRMATION}")
    if not is_inside(SOURCE_ROOT, SOURCE_ROOT) or not is_inside(OUTPUT_ROOT, OUTPUT_ROOT):
        raise SystemExit("unsafe root configuration")


def is_inside(root: Path, candidate: Path) -> bool:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    return candidate_resolved == root_resolved or root_resolved in candidate_resolved.parents


def quote_path(path: Path) -> str:
    return str(path)


def run_command(args, log_path: Path, timeout=None):
    with log_path.open("ab") as log_file:
        log_file.write(("COMMAND: " + " ".join(map(str, args)) + "\n").encode("utf-8", "replace"))
        log_file.flush()
        proc = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=log_file,
            timeout=timeout,
        )
    return proc.returncode


def ffprobe(path: Path):
    try:
        result = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                quote_path(path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180,
        )
    except Exception as exc:
        return None, f"ffprobe_exception:{exc}"
    if result.returncode != 0:
        return None, f"ffprobe_failed:{result.stderr.strip()[:500]}"
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return None, f"ffprobe_json:{exc}"
    return parse_probe(data, path), None


def parse_probe(data, path: Path):
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}
    duration = number(fmt.get("duration"))
    if duration is None and video:
        duration = number(video.get("duration"))
    if duration is None and audio:
        duration = number(audio.get("duration"))
    bit_rate = integer(fmt.get("bit_rate"))
    if bit_rate is None and duration and duration > 0 and path.exists():
        bit_rate = int(path.stat().st_size * 8 / duration)
    return {
        "duration": duration,
        "bit_rate": bit_rate,
        "format_name": fmt.get("format_name") or "",
        "video": {
            "codec": (video or {}).get("codec_name"),
            "width": integer((video or {}).get("width")),
            "height": integer((video or {}).get("height")),
            "fps": parse_rate((video or {}).get("avg_frame_rate")) or parse_rate((video or {}).get("r_frame_rate")),
            "pix_fmt": (video or {}).get("pix_fmt"),
        } if video else None,
        "audio": {
            "codec": (audio or {}).get("codec_name"),
            "sample_rate": integer((audio or {}).get("sample_rate")),
            "channels": integer((audio or {}).get("channels")),
        } if audio else None,
    }


def number(value):
    try:
        if value is None:
            return None
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except Exception:
        return None


def integer(value):
    try:
        if value is None:
            return None
        return int(float(value))
    except Exception:
        return None


def parse_rate(value):
    if not value or value == "0/0":
        return None
    try:
        if "/" in value:
            a, b = value.split("/", 1)
            denominator = float(b)
            if denominator == 0:
                return None
            return float(a) / denominator
        return float(value)
    except Exception:
        return None


def classify_source(probe, src: Path):
    reasons = []
    if not probe or not probe.get("duration"):
        return "failed", ["duration"]
    video = probe.get("video")
    audio = probe.get("audio")
    if not video:
        return "failed", ["video_missing"]
    if not audio:
        reasons.append("audio_missing")
    video_ok = (
        (video.get("codec") or "").lower() == "h264"
        and video.get("width") == TARGET_WIDTH
        and video.get("height") == TARGET_HEIGHT
        and fps_matches(video.get("fps"))
        and (video.get("pix_fmt") or "").lower() == "yuv420p"
    )
    audio_ok = (
        audio is not None
        and (audio.get("codec") or "").lower() == "aac"
        and audio.get("sample_rate") == TARGET_AUDIO_RATE
        and audio.get("channels") == TARGET_AUDIO_CHANNELS
    )
    container_ok = src.suffix.lower() == ".mp4"
    bitrate_ok = probe.get("bit_rate") is None or probe.get("bit_rate") <= MAX_VIDEO_BITRATE
    if not video_ok:
        reasons.append("video_profile")
    if not bitrate_ok:
        reasons.append("bitrate")
    if not audio_ok:
        reasons.append("audio_profile")
    if not container_ok:
        reasons.append("container")
    if video_ok and audio_ok and container_ok and bitrate_ok:
        return "remux", []
    if video_ok and bitrate_ok:
        return "audio-only", reasons
    return "full-transcode", reasons


def fps_matches(value):
    return value is not None and abs(value - TARGET_FPS) <= 0.08


def validate_output(out: Path, source_probe, log_path: Path):
    if not out.exists() or out.stat().st_size < 1024:
        return False, "output_missing_or_small"
    probe, err = ffprobe(out)
    if err:
        return False, err
    video = probe.get("video")
    audio = probe.get("audio")
    if not probe.get("duration"):
        return False, "duration_missing"
    if source_probe and source_probe.get("duration"):
        diff = abs(probe["duration"] - source_probe["duration"])
        allowed = max(3.0, source_probe["duration"] * 0.02)
        if diff > allowed:
            return False, f"duration_diff:{diff:.3f}>{allowed:.3f}"
    if not video:
        return False, "video_missing"
    if (video.get("codec") or "").lower() != "h264":
        return False, f"video_codec:{video.get('codec')}"
    if video.get("width") != TARGET_WIDTH or video.get("height") != TARGET_HEIGHT:
        return False, f"resolution:{video.get('width')}x{video.get('height')}"
    if not fps_matches(video.get("fps")):
        return False, f"fps:{video.get('fps')}"
    if (video.get("pix_fmt") or "").lower() != "yuv420p":
        return False, f"pix_fmt:{video.get('pix_fmt')}"
    if not audio:
        return False, "audio_missing"
    if (audio.get("codec") or "").lower() != "aac":
        return False, f"audio_codec:{audio.get('codec')}"
    if audio.get("sample_rate") != TARGET_AUDIO_RATE:
        return False, f"sample_rate:{audio.get('sample_rate')}"
    if audio.get("channels") != TARGET_AUDIO_CHANNELS:
        return False, f"channels:{audio.get('channels')}"
    if probe.get("bit_rate") and probe["bit_rate"] > MAX_VIDEO_BITRATE:
        return False, f"bitrate:{probe['bit_rate']}"
    code = run_command(
        [
            FFMPEG,
            "-v",
            "error",
            "-nostdin",
            "-i",
            quote_path(out),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-f",
            "null",
            "-",
        ],
        log_path,
    )
    if code != 0:
        return False, f"deep_decode_exit:{code}"
    return True, "ok"


def build_ffmpeg_args(decision, src: Path, tmp: Path):
    if decision == "remux":
        return [
            FFMPEG,
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            quote_path(src),
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            quote_path(tmp),
        ]
    if decision == "audio-only":
        return [
            FFMPEG,
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            quote_path(src),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            AUDIO_BITRATE,
            "-ar",
            str(TARGET_AUDIO_RATE),
            "-ac",
            str(TARGET_AUDIO_CHANNELS),
            "-movflags",
            "+faststart",
            quote_path(tmp),
        ]
    vf = (
        "scale=1280:720:force_original_aspect_ratio=decrease,"
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1,fps=25,setpts=N/(25*TB),settb=1/25"
    )
    af = "aresample=48000:async=1:first_pts=0"
    return [
        FFMPEG,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        quote_path(src),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        vf,
        "-af",
        af,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        VIDEO_BITRATE,
        "-maxrate",
        VIDEO_MAXRATE,
        "-bufsize",
        VIDEO_BUFSIZE,
        "-pix_fmt",
        "yuv420p",
        "-r",
        "25",
        "-c:a",
        "aac",
        "-b:a",
        AUDIO_BITRATE,
        "-ar",
        str(TARGET_AUDIO_RATE),
        "-ac",
        str(TARGET_AUDIO_CHANNELS),
        "-movflags",
        "+faststart",
        quote_path(tmp),
    ]


def output_path_for(src: Path):
    rel = src.resolve().relative_to(SOURCE_ROOT)
    return (OUTPUT_ROOT / rel).with_suffix(".mp4")


def file_log_path(src: Path, index: int):
    digest = hashlib.sha1(str(src).encode("utf-8", "replace")).hexdigest()[:16]
    return LOG_DIR / f"continue_{index:05d}_{digest}.log"


def append_report(row):
    with LOCK:
        with REPORT_PATH.open("a", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(row)


def delete_original(src: Path):
    if not DELETE_ORIGINAL:
        return False, "delete_disabled"
    src_resolved = src.resolve()
    if not is_inside(SOURCE_ROOT, src_resolved):
        return False, "unsafe_delete_path"
    if not src_resolved.exists():
        return False, "source_already_missing"
    src_resolved.unlink()
    return True, "deleted"


def process_one(index, total, src: Path, collision=False):
    out = output_path_for(src)
    log_path = file_log_path(src, index)
    rel_status = f"[{index}/{total}]"
    log(f"CHECK {rel_status}: {src}")
    source_probe, source_err = ffprobe(src)
    if source_err:
        append_report([str(src), "failed", "probe_source", "failed", source_err, str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: {source_err}")
        return False
    if collision:
        append_report([str(src), "failed", "collision", "failed", "output_path_collision", str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: output path collision")
        return False
    if DRY_RUN:
        if out.exists():
            append_report([str(src), "dry_run", "existing_output", "validate_later", "output_exists_not_deep_checked", str(out), str(log_path), "no"])
            log(f"DRY-RUN {rel_status}: existing output; validation would run before delete")
            return True
        decision, reasons = classify_source(source_probe, src)
        append_report([str(src), "dry_run", "would_normalize", decision, "|".join(reasons), str(out), str(log_path), "no"])
        log(f"DRY-RUN {rel_status}: {decision}")
        return decision != "failed"
    if out.exists():
        ok, reason = validate_output(out, source_probe, log_path)
        if ok:
            deleted, delete_reason = (False, "dry_run") if DRY_RUN else delete_original(src)
            append_report([str(src), "ok", "existing_valid", "ok", reason, str(out), str(log_path), "yes" if deleted else delete_reason])
            log(f"OK {rel_status}: existing normalized valid; original {delete_reason}")
            return True
        append_report([str(src), "pending", "existing_invalid", "validate", reason, str(out), str(log_path), "no"])
    decision, reasons = classify_source(source_probe, src)
    if decision == "failed":
        append_report([str(src), "failed", "classify", decision, "|".join(reasons), str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: {'|'.join(reasons)}")
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f"{out.name}.tmp.{os.getpid()}.{index}.mp4")
    if tmp.exists():
        tmp.unlink()
    code = run_command(build_ffmpeg_args(decision, src, tmp), log_path)
    if code != 0:
        append_report([str(src), "failed", "ffmpeg", decision, f"ffmpeg_exit:{code}", str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: ffmpeg exit {code}")
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        return False
    ok, reason = validate_output(tmp, source_probe, log_path)
    if not ok:
        append_report([str(src), "failed", "validate_tmp", decision, reason, str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: validation {reason}")
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        return False
    tmp.replace(out)
    ok, reason = validate_output(out, source_probe, log_path)
    if not ok:
        append_report([str(src), "failed", "validate_final", decision, reason, str(out), str(log_path), "no"])
        log(f"FAILED {rel_status}: final validation {reason}")
        return False
    deleted, delete_reason = delete_original(src)
    append_report([str(src), "ok", "normalized", decision, reason, str(out), str(log_path), "yes" if deleted else delete_reason])
    log(f"OK {rel_status}: {decision}; original {delete_reason}")
    return True


def collect_sources():
    if MANIFEST_PATH:
        return collect_manifest_sources(Path(MANIFEST_PATH))
    files = sorted(
        path for path in SOURCE_ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_EXTS
    )
    if LIMIT is not None:
        files = files[:LIMIT]
    return files


def collect_manifest_sources(manifest: Path):
    if not manifest.exists():
        raise SystemExit(f"manifest missing: {manifest}")
    files = []
    for raw in manifest.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        candidate = Path(line)
        if not candidate.is_absolute():
            candidate = SOURCE_ROOT / candidate
        candidate = candidate.resolve()
        if not is_inside(SOURCE_ROOT, candidate):
            raise SystemExit(f"manifest path is outside source root: {candidate}")
        if candidate.is_file() and candidate.suffix.lower() in VIDEO_EXTS:
            files.append(candidate)
    files = sorted(dict.fromkeys(files))
    if LIMIT is not None:
        files = files[:LIMIT]
    return files


def main():
    ensure_safe_config()
    sources = collect_sources()
    out_counts = {}
    for src in sources:
        out_counts.setdefault(str(output_path_for(src)), 0)
        out_counts[str(output_path_for(src))] += 1
    collisions = {out for out, count in out_counts.items() if count > 1}
    with REPORT_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["file", "status", "action", "decision", "reason", "output", "log", "deleted_original"])
    log("==== CONTINUE NORMALIZE AR ====")
    log(f"source={SOURCE_ROOT}")
    log(f"output={OUTPUT_ROOT}")
    log(f"report={REPORT_PATH}")
    log(f"total={len(sources)} parallel={MAX_PARALLEL} dry_run={DRY_RUN} delete_original={DELETE_ORIGINAL}")
    success = 0
    failed = 0
    if not sources:
        log("DONE")
        return 0
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = {
            pool.submit(process_one, index, len(sources), src, str(output_path_for(src)) in collisions): src
            for index, src in enumerate(sources, start=1)
        }
        for future in as_completed(futures):
            try:
                if future.result():
                    success += 1
                else:
                    failed += 1
            except Exception as exc:
                failed += 1
                src = futures[future]
                log(f"FAILED [?/{len(sources)}]: {src}: exception {exc}")
                append_report([str(src), "failed", "exception", "failed", str(exc), str(output_path_for(src)), "", "no"])
    elapsed = datetime.now() - STARTED_AT
    log("")
    log("==== CONTINUE SUMMARY ====")
    log(f"success={success}")
    log(f"failed={failed}")
    log(f"elapsed_seconds={int(elapsed.total_seconds())}")
    log(f"Report: {REPORT_PATH}")
    log("DONE" if failed == 0 else "DONE_WITH_FAILURES")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
