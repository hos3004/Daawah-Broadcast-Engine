# إصلاح تقطيع البث (FFmpeg speed < 1.0x) — السيرفر الجديد 144.91.124.112

**التاريخ:** 2026-06-03
**الملفات المعدّلة:** `server/src/broadcast/ffmpegRunner.ts`, `server/src/overlay/programBadgeOverlay.ts`, `server/src/overlay/tickerGenerator.ts`, `server/src/__tests__/programBadgeCycleFolding.test.ts`

> هذا الملف مرجع لإعادة التشخيص لو تكررت مشكلة التقطيع مستقبلاً. اقرأ "كيف تشخّص بسرعة" أولاً.

---

## الأعراض (Symptoms)

- البث المباشر (HLS) يتقطّع كل بضع ثوانٍ ("تقطيع البث").
- في سجل FFmpeg: `speed=0.70x` ثم `0.78x` — أي **أقل من 1.0x** (أبطأ من الزمن الحقيقي).
- مع وجود `-re` في الأمر، الهدف هو `~1.0x`؛ فإذا قلّت السرعة عن 1.0x يتأخر المُرمِّز عن الزمن الحقيقي → نقص في المخزن (buffer underrun) → تقطيع وإطارات مفقودة (`drop=...`).

## كيف تشخّص بسرعة (Quick diagnosis)

```bash
# 1) السرعة الحالية (يجب أن تكون >= 1.0x)
LOG=$(ls -t /var/log/daawah-broadcast/ffmpeg-*.log | head -1)
grep -oE 'speed=[ ]*[0-9.]+x' "$LOG" | tail -5

# 2) هل المعالج مشغول فعلاً؟ (لو خامل فالمشكلة ليست عدد الأنوية)
nproc; cat /proc/loadavg
PID=$(pgrep -x ffmpeg | head -1); top -H -b -n1 -p $PID | head -20

# 3) عدّ شروط between() في فلتر FFmpeg (يجب أن تكون عشرات لا آلاف)
ps -o args= -C ffmpeg | grep -oE 'between\(' | wc -l

# 4) هل الطيّ الدوري يعمل؟ (يجب أن تظهر mod(t,28800) ورسالة "schedule is periodic")
ps -o args= -C ffmpeg | grep -oE 'mod\(t,[0-9.]+\)' | head -1
journalctl -u daawah-control-backend.service --since '-5 min' | grep -i 'periodic\|folded'

# 5) قياس السرعة الخام بدون -re (لمعرفة هل السلسلة نفسها بطيئة)
#    أعد تشغيل نفس أمر FFmpeg لكن: احذف -re، وأضف -t 25 -f null - بدل مخرج HLS
```

**القاعدة الذهبية:** لو `speed < 1.0x` بينما المعالج **خامل** (idle عالي، load أقل بكثير من nproc)
→ المشكلة ليست عدد الأنوية، بل **سلسلة فلاتر متسلسلة (single-threaded)** أو **فك ترميز مهدور**.

---

## السببان الجذريان (Root causes)

### 1) تعبير شارة البرنامج العملاق (badge `enable=` / crop)

البث يعمل من "playlist artifact" يمتد **15 يوماً** في عملية FFmpeg واحدة، والجدول **يتكرر كل 28800 ثانية (8 ساعات)** ≈ 45 دورة.
كان تعبير الشارة يحتوي ~**1822 شرط `between(t,...)`** تُحسب لكل إطار على خيط واحد.

**ملاحظة مهمة:** بدايات البرامج دورية تماماً (الفجوة = 28800s ثابتة)، لكن **مدد البرامج تختلف** كل دورة (حلقات مختلفة بنفس العنوان). لذلك لا يصلح الطيّ المعتمد على تطابق المدة.

**الحل (طيّ تقريبي / approximate fold):**
- `detectScheduleCycle` يتحقق من **دورية البداية (phase) + ثبات صف العنوان (title row)** فقط — لا يتحقق من المدة.
- `foldGroupsIntoCycle` يطوي كل برنامج إلى نافذة واحدة تبدأ من طوره (phase) بطول **أطول حلقة** ظهرت لذلك العنوان، محدودة ببداية البرنامج التالي (فلا تتداخل النوافذ، والاسم **لا يختفي مبكراً**).
- `foldRangesByPeriod` يطوي تعبير إخفاء الشعار بنفس الدورة.
- البناة (`buildOverlayEnableExpression` / `buildBadgeCropYExpression`) صارت تختار متغير الزمن فقط: `mod(t,period)` عند وجود دورة، وإلا `t`.
- النتيجة: `between()` من **1822 → ~40**، ويظهر في السجل: `Program badge: schedule is periodic (cycle 28800s) — folded 695 program ranges into 16`.

> هذا الطيّ خفّض السرعة من 0.70x إلى 0.78x فقط — **لم يكن** السبب الأكبر.

### 2) (الأهم) فك ترميز صور الـ overlay الثابتة 25 مرة/الثانية

صور الـ PNG الثلاث الثابتة (حبة "الآن"، صورة عناوين البرامج sprite، الشعار) كانت تُغذّى بـ:
```
-loop 1 -framerate 25 -i <file>.png
```
فكان FFmpeg **يفك ترميز (zlib) كل صورة 25 مرة في الثانية**. هذا وحده أنزل سلسلة الفلاتر أحادية الخيط من ~2x إلى **0.42x**.

**القياسات التي أثبتت ذلك (benchmark بدون -re):**

| السيناريو | السرعة |
|---|---|
| فك ترميز concat + ترميز فقط (بدون فلاتر) | 2.58x |
| + scale/pad/fps | 1.99x |
| + 3 صور PNG @ framerate 25 | **0.82x** ← الانهيار |
| + 3 صور PNG @ framerate 2 | 1.58x |
| الأمر الكامل، PNG @ 25 | **0.42x** |
| الأمر الكامل، PNG @ 1 | 1.12x |
| الأمر الكامل، PNG @ 1 + `filter_complex_threads 4` | **1.28x** |
| الأمر الكامل، PNG @ 1 + `filter_complex_threads 8` | 1.09x (تنافس/تراجع) |

**الحل:**
- `STATIC_OVERLAY_FPS = '1'` لكل صورة overlay ثابتة. **آمن تماماً** لأن توقيت ظهور/اختفاء الـ overlay يأتي من تعبير `enable=`/crop المبني على زمن الإخراج `t`، **وليس** من معدل إطارات الدخل. فالصورة الثابتة تبقى متاحة (overlay يكرّر آخر إطار) مع تقليل فك الترميز ~25×. أقصى تأخير في تبديل الشارة = ثانية واحدة (غير محسوس عند حدود البرامج).
- `-filter_complex_threads 4` (محدود بـ `min(4, nproc)`) — لتوزيع سلسلة الفلاتر المتسلسلة على عدة أنوية كانت خاملة. 8 خيوط تسبب تنافساً وتراجعاً، لذا 4 هو الأفضل على جهاز بـ 8 أنوية.

> تغيير ثانوي مرتبط: شريط الأخبار (ticker) تحوّل من VP9/WebM إلى **H.264/MP4** (`libx264 ultrafast`, `yuv420p`) في `tickerGenerator.ts` لتفادي تكلفة ترميز/فك ترميز VP9.

---

## النتيجة بعد الإصلاح (Verified)

- `speed = 1.0x` ثابتة عند `fps=25`، **صفر إطارات مفقودة**، مقاطع HLS تُكتب كل ~4s.
- `between()` = 40 (كلها بـ `mod(t,28800)`).
- هامش خام ~**1.28x** (28%) لاستيعاب المقاطع الأثقل.

---

## لو تكررت المشكلة مستقبلاً (Checklist)

1. شغّل أوامر "كيف تشخّص بسرعة" أعلاه.
2. لو `between()` بالآلاف ولا يظهر `mod(t,...)`:
   - الطيّ الدوري تعطّل. تحقق أن الجدول فعلاً دوري (الفجوة بين بدايات نفس البرنامج ثابتة) عبر `scripts/debug_badge_cycle.js`.
   - تأكد أن نفس الطور (phase) لا يحمل عنوانين مختلفين (`detectScheduleCycle` يُرجع null في هذه الحالة عمداً).
3. لو `speed < 1.0x` والمعالج **خامل**:
   - تأكد أن صور الـ overlay الثابتة تُغذّى بـ `-framerate 1` (وليس 25) — ابحث عن `STATIC_OVERLAY_FPS` في `ffmpegRunner.ts`.
   - تأكد من وجود `-filter_complex_threads`.
   - أعد قياس السلسلة بالـ benchmark التدريجي (decode → +scale → +overlays) لعزل المرحلة المكلفة.
4. لو `speed < 1.0x` والمعالج **مشبع** (كل الأنوية 100%):
   - السيرفر أضعف من القديم؛ فكّر في خفض الدقة/البِت ريت، أو preset أسرع، أو ترميز بالعتاد (NVENC/QSV) إن توفر.
5. لو ظهرت أخطاء `Invalid data ... png` في السجل: غالباً ضوضاء إيقاف العملية القديمة عند restart (ليست في الجري الحالي). تأكد أن الكتابة الذرية للـ sprite تعمل (`.tmp` ثم `rename`).

## طريقة النشر (Deploy)

```bash
# من جهاز التطوير (alias daawah-vps معرّف في ~/.ssh/config)
scp server/src/broadcast/ffmpegRunner.ts        daawah-vps:/opt/daawah-broadcast-test/server/src/broadcast/ffmpegRunner.ts
scp server/src/overlay/programBadgeOverlay.ts   daawah-vps:/opt/daawah-broadcast-test/server/src/overlay/programBadgeOverlay.ts
scp server/src/overlay/tickerGenerator.ts       daawah-vps:/opt/daawah-broadcast-test/server/src/overlay/tickerGenerator.ts
ssh daawah-vps "cd /opt/daawah-broadcast-test/server && npx tsc -p tsconfig.json && systemctl restart daawah-control-backend.service"
```

**تنبيه:** السيرفر قد يحوي تعديلات جلسة غير موجودة في الريبو — قارن قبل أي `scp` يستبدل ملفاً (سبق أن أعاد scp ملفاً قديماً للـ ticker فأزال إصلاح .mp4).
