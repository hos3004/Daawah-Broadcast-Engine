#!/usr/bin/env python3
import csv
import hashlib
import os
import shutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import continue_normalize_ar_server as normalize


SOURCE_ROOT = Path(os.environ.get("PROMOTE_SOURCE_ROOT", os.environ.get("NORMALIZE_SOURCE_ROOT", "/srv/daawah/media/original-ar"))).resolve()
OUTPUT_ROOT = Path(os.environ.get("PROMOTE_OUTPUT_ROOT", os.environ.get("NORMALIZE_OUTPUT_ROOT", "/srv/daawah/media/normalized-ar"))).resolve()
MAX_PARALLEL = max(1, min(5, int(os.environ.get("PROMOTE_READY_MAX_PARALLEL", "2"))))
LIMIT = int(os.environ["PROMOTE_READY_LIMIT"]) if os.environ.get("PROMOTE_READY_LIMIT") else None
MANIFEST_PATH = os.environ.get("PROMOTE_READY_MANIFEST")
DRY_RUN = os.environ.get("DRY_RUN", "1").lower() not in {"0", "false", "no"}
MOVE_READY = os.environ.get("MOVE_READY_TO_NORMALIZED", "0").lower() in {"1", "true", "yes"}
DELETE_ORIGINAL = os.environ.get("DELETE_ORIGINAL_AFTER_VALIDATION", "0").lower() in {"1", "true", "yes"}
ALLOW_WITH_RUNNING_NORMALIZE = os.environ.get("ALLOW_WITH_RUNNING_NORMALIZE", "0").lower() in {"1", "true", "yes"}
PROMOTE_CONFIRMATION = "PROMOTE READY NORMALIZED"
MOVE_CONFIRMATION = "MOVE READY ORIGINAL TO NORMALIZED"
DELETE_CONFIRMATION = "DELETE ORIGINAL AFTER VALIDATION"
MEDIA_ROOT = Path("/srv/daawah/media").resolve()
VIDEO_EXTS = normalize.VIDEO_EXTS

RUN_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
REPORT_DIR = OUTPUT_ROOT / "reports"
LOG_DIR = OUTPUT_ROOT / "logs_promote_ready"
REPORT_PATH = REPORT_DIR / f"promote_ready_normalized_ar_{RUN_ID}.csv"
PROGRAM_REPORT_PATH = REPORT_DIR / f"promote_ready_normalized_ar_programs_{RUN_ID}.csv"
LOCK = threading.Lock()
STARTED_AT = datetime.now()


def log(message: str) -> None:
    print(message, flush=True)


def ensure_safe_config() -> None:
    if not SOURCE_ROOT.exists():
        raise SystemExit(f"source root missing: {SOURCE_ROOT}")
    if not normalize.is_inside(MEDIA_ROOT, SOURCE_ROOT):
        raise SystemExit(f"source root must be inside {MEDIA_ROOT}")
    if not normalize.is_inside(MEDIA_ROOT, OUTPUT_ROOT):
        raise SystemExit(f"output root must be inside {MEDIA_ROOT}")
    if SOURCE_ROOT == OUTPUT_ROOT:
        raise SystemExit("source and output roots must be different")
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    if DRY_RUN:
        return

    if os.environ.get("PROMOTE_READY_CONFIRMATION") != PROMOTE_CONFIRMATION:
        raise SystemExit(f"PROMOTE_READY_CONFIRMATION must be exactly: {PROMOTE_CONFIRMATION}")
    if MOVE_READY and os.environ.get("MOVE_CONFIRMATION") != MOVE_CONFIRMATION:
        raise SystemExit(f"MOVE_CONFIRMATION must be exactly: {MOVE_CONFIRMATION}")
    if DELETE_ORIGINAL and os.environ.get("DELETE_CONFIRMATION") != DELETE_CONFIRMATION:
        raise SystemExit(f"DELETE_CONFIRMATION must be exactly: {DELETE_CONFIRMATION}")
    if not MOVE_READY and not DELETE_ORIGINAL:
        raise SystemExit("live mode needs MOVE_READY_TO_NORMALIZED=1 and/or DELETE_ORIGINAL_AFTER_VALIDATION=1")
    if not ALLOW_WITH_RUNNING_NORMALIZE:
        running = running_normalization_jobs()
        if running:
            raise SystemExit(
                "another normalization job is running; stop it first or set ALLOW_WITH_RUNNING_NORMALIZE=1: "
                + ", ".join(running)
            )


def running_normalization_jobs():
    running = []
    for pid_path in [
        "/tmp/continue_normalize_ar_server.pid",
        "/tmp/fix_normalized_ar_server.pid",
    ]:
        try:
            pid = int(Path(pid_path).read_text(encoding="utf-8").strip())
        except Exception:
            continue
        if Path(f"/proc/{pid}").exists():
            running.append(f"{pid_path}:{pid}")
    return running


def output_path_for(src: Path) -> Path:
    rel = src.resolve().relative_to(SOURCE_ROOT).with_suffix(".mp4")
    return OUTPUT_ROOT / rel


def file_log_path(src: Path, index: int) -> Path:
    digest = hashlib.sha1(str(src).encode("utf-8", "replace")).hexdigest()[:16]
    return LOG_DIR / f"promote_ready_{index:05d}_{digest}.log"


def source_ready_reasons(probe, src: Path):
    reasons = []
    if not probe or not probe.get("duration"):
        reasons.append("duration")
    video = (probe or {}).get("video")
    audio = (probe or {}).get("audio")
    if not video:
        reasons.append("video_missing")
    else:
        if (video.get("codec") or "").lower() != "h264":
            reasons.append(f"video_codec:{video.get('codec')}")
        if video.get("width") != normalize.TARGET_WIDTH or video.get("height") != normalize.TARGET_HEIGHT:
            reasons.append(f"resolution:{video.get('width')}x{video.get('height')}")
        if not normalize.fps_matches(video.get("fps")):
            reasons.append(f"fps:{video.get('fps')}")
        if (video.get("pix_fmt") or "").lower() != "yuv420p":
            reasons.append(f"pix_fmt:{video.get('pix_fmt')}")
    if not audio:
        reasons.append("audio_missing")
    else:
        if (audio.get("codec") or "").lower() != "aac":
            reasons.append(f"audio_codec:{audio.get('codec')}")
        if audio.get("sample_rate") != normalize.TARGET_AUDIO_RATE:
            reasons.append(f"sample_rate:{audio.get('sample_rate')}")
        if audio.get("channels") != normalize.TARGET_AUDIO_CHANNELS:
            reasons.append(f"channels:{audio.get('channels')}")
    if src.suffix.lower() != ".mp4":
        reasons.append("container")
    bit_rate = (probe or {}).get("bit_rate")
    if bit_rate is None:
        reasons.append("bitrate_unknown")
    elif bit_rate > normalize.MAX_VIDEO_BITRATE:
        reasons.append(f"bitrate:{bit_rate}")
    return reasons


def append_report(row):
    with LOCK:
        with REPORT_PATH.open("a", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(row)


def delete_source(src: Path):
    if not DELETE_ORIGINAL:
        return False, "delete_disabled"
    src_resolved = src.resolve()
    if not normalize.is_inside(SOURCE_ROOT, src_resolved):
        return False, "unsafe_delete_path"
    if not src_resolved.exists():
        return False, "source_already_missing"
    src_resolved.unlink()
    return True, "deleted"


def move_ready_source(src: Path, out: Path, source_probe, log_path: Path, index: int):
    if not MOVE_READY:
        return False, "move_disabled"
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f"{out.name}.tmp.promote.{os.getpid()}.{index}.mp4")
    if tmp.exists():
        tmp.unlink()
    src_parent = src.parent
    try:
        src.rename(tmp)
    except OSError:
        shutil.move(str(src), str(tmp))
    ok, reason = normalize.validate_output(tmp, source_probe, log_path)
    if not ok:
        try:
            src_parent.mkdir(parents=True, exist_ok=True)
            if not src.exists():
                tmp.rename(src)
        except Exception as exc:
            return False, f"validate_moved:{reason};restore_failed:{exc}"
        return False, f"validate_moved:{reason};restored"
    tmp.replace(out)
    ok, reason = normalize.validate_output(out, source_probe, log_path)
    if not ok:
        try:
            src_parent.mkdir(parents=True, exist_ok=True)
            if not src.exists():
                out.rename(src)
        except Exception as exc:
            return False, f"validate_final:{reason};restore_failed:{exc}"
        return False, f"validate_final:{reason};restored"
    return True, reason


def process_one(index: int, total: int, src: Path, collision: bool):
    program = src.relative_to(SOURCE_ROOT).parts[0] if len(src.relative_to(SOURCE_ROOT).parts) > 1 else "(root)"
    out = output_path_for(src)
    log_path = file_log_path(src, index)
    rel_status = f"[{index}/{total}]"
    log(f"CHECK {rel_status}: {src}")
    source_size = src.stat().st_size if src.exists() else 0
    source_probe, source_err = normalize.ffprobe(src)
    if source_err:
        append_report([program, str(src), "failed", "probe_source", "failed", source_err, str(out), str(log_path), source_size, "", "no"])
        log(f"FAILED {rel_status}: {source_err}")
        return False
    if collision:
        append_report([program, str(src), "failed", "collision", "failed", "output_path_collision", str(out), str(log_path), source_size, "", "no"])
        log(f"FAILED {rel_status}: output path collision")
        return False

    if out.exists():
        if DRY_RUN:
            append_report([program, str(src), "dry_run", "existing_output", "validate_later", "output_exists_not_deep_checked", str(out), str(log_path), source_size, out.stat().st_size, "no"])
            log(f"DRY-RUN {rel_status}: existing output; validation would run before delete")
            return True
        ok, reason = normalize.validate_output(out, source_probe, log_path)
        if not ok:
            append_report([program, str(src), "pending", "existing_invalid", "needs_normalize", reason, str(out), str(log_path), source_size, out.stat().st_size, "no"])
            log(f"PENDING {rel_status}: existing output invalid: {reason}")
            return False
        deleted, delete_reason = delete_source(src)
        append_report([program, str(src), "ok", "existing_valid", "ready", reason, str(out), str(log_path), source_size, out.stat().st_size, "yes" if deleted else delete_reason])
        log(f"OK {rel_status}: existing normalized valid; original {delete_reason}")
        return True

    reasons = source_ready_reasons(source_probe, src)
    if reasons:
        append_report([program, str(src), "skipped", "needs_normalize", "normalize_required", "|".join(reasons), str(out), str(log_path), source_size, "", "no"])
        log(f"SKIP {rel_status}: needs normalize: {'|'.join(reasons)}")
        return True

    if DRY_RUN:
        append_report([program, str(src), "dry_run", "ready_to_promote", "ready", "source_matches_target_not_deep_checked", str(out), str(log_path), source_size, "", "no"])
        log(f"DRY-RUN {rel_status}: ready to promote")
        return True

    ok, reason = normalize.validate_output(src, source_probe, log_path)
    if not ok:
        append_report([program, str(src), "failed", "validate_source", "ready", reason, str(out), str(log_path), source_size, "", "no"])
        log(f"FAILED {rel_status}: source validation {reason}")
        return False
    moved, move_reason = move_ready_source(src, out, source_probe, log_path, index)
    if not moved:
        append_report([program, str(src), "failed", "promote_ready", "ready", move_reason, str(out), str(log_path), source_size, "", "no"])
        log(f"FAILED {rel_status}: promote {move_reason}")
        return False
    append_report([program, str(src), "ok", "promoted_ready", "ready", move_reason, str(out), str(log_path), source_size, out.stat().st_size, "moved"])
    log(f"OK {rel_status}: promoted ready source to normalized-ar")
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
        if not normalize.is_inside(SOURCE_ROOT, candidate):
            raise SystemExit(f"manifest path is outside source root: {candidate}")
        if candidate.is_file() and candidate.suffix.lower() in VIDEO_EXTS:
            files.append(candidate)
    files = sorted(dict.fromkeys(files))
    if LIMIT is not None:
        files = files[:LIMIT]
    return files


def write_program_summary():
    summary = {}
    with REPORT_PATH.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            program = row["program"]
            item = summary.setdefault(program, {
                "total": 0,
                "ok": 0,
                "failed": 0,
                "ready_to_promote": 0,
                "promoted_ready": 0,
                "existing_valid": 0,
                "needs_normalize": 0,
                "deleted_or_moved": 0,
                "source_bytes": 0,
            })
            item["total"] += 1
            item["source_bytes"] += int(row.get("source_bytes") or 0)
            status = (row.get("status") or "").lower()
            action = (row.get("action") or "").lower()
            deleted = (row.get("deleted_original") or "").lower()
            if status == "ok":
                item["ok"] += 1
            if status == "failed":
                item["failed"] += 1
            if action == "ready_to_promote":
                item["ready_to_promote"] += 1
            if action == "promoted_ready":
                item["promoted_ready"] += 1
            if action == "existing_valid":
                item["existing_valid"] += 1
            if action == "needs_normalize":
                item["needs_normalize"] += 1
            if deleted in {"yes", "moved"}:
                item["deleted_or_moved"] += 1
    with PROGRAM_REPORT_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "program",
            "total",
            "ok",
            "failed",
            "ready_to_promote",
            "promoted_ready",
            "existing_valid",
            "needs_normalize",
            "deleted_or_moved",
            "source_gb",
        ])
        for program, item in sorted(summary.items(), key=lambda kv: (-kv[1]["needs_normalize"], kv[0])):
            writer.writerow([
                program,
                item["total"],
                item["ok"],
                item["failed"],
                item["ready_to_promote"],
                item["promoted_ready"],
                item["existing_valid"],
                item["needs_normalize"],
                item["deleted_or_moved"],
                round(item["source_bytes"] / 1024 ** 3, 3),
            ])


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
        writer.writerow([
            "program",
            "file",
            "status",
            "action",
            "decision",
            "reason",
            "output",
            "log",
            "source_bytes",
            "output_bytes",
            "deleted_original",
        ])
    log("==== PROMOTE READY NORMALIZED AR ====")
    log(f"source={SOURCE_ROOT}")
    log(f"output={OUTPUT_ROOT}")
    log(f"report={REPORT_PATH}")
    log(f"program_report={PROGRAM_REPORT_PATH}")
    log(f"total={len(sources)} parallel={MAX_PARALLEL} dry_run={DRY_RUN} move_ready={MOVE_READY} delete_original={DELETE_ORIGINAL}")
    success = 0
    failed = 0
    if not sources:
        write_program_summary()
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
                append_report(["", str(src), "failed", "exception", "failed", str(exc), str(output_path_for(src)), "", "", "", "no"])
    write_program_summary()
    elapsed = datetime.now() - STARTED_AT
    log("")
    log("==== PROMOTE READY SUMMARY ====")
    log(f"success={success}")
    log(f"failed={failed}")
    log(f"elapsed_seconds={int(elapsed.total_seconds())}")
    log(f"Report: {REPORT_PATH}")
    log(f"Program report: {PROGRAM_REPORT_PATH}")
    log("DONE" if failed == 0 else "DONE_WITH_FAILURES")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
