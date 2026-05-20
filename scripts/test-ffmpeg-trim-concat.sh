#!/usr/bin/env bash
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe is required" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

source_mp4="$tmp_dir/source.mp4"
concat_file="$tmp_dir/trim.ffconcat"
output_mp4="$tmp_dir/output.mp4"

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=blue:s=320x180:r=25" \
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000" \
  -t 20 \
  -c:v libx264 -pix_fmt yuv420p \
  -c:a aac -ar 48000 \
  -shortest "$source_mp4"

cat > "$concat_file" <<EOF
ffconcat version 1.0
file '$source_mp4'
outpoint 5.000
duration 5.000
EOF

ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$concat_file" \
  -c:v libx264 -pix_fmt yuv420p \
  -c:a aac -ar 48000 \
  "$output_mp4"

duration="$(
  ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$output_mp4"
)"

node - "$duration" <<'NODE'
const duration = Number(process.argv[2]);
if (!Number.isFinite(duration)) {
  console.error('Could not read output duration');
  process.exit(1);
}
if (duration < 4.5 || duration > 6.5) {
  console.error(`Expected duration near 5s, got ${duration.toFixed(3)}s`);
  process.exit(1);
}
console.log(`FFmpeg trim concat OK: ${duration.toFixed(3)}s`);
NODE
