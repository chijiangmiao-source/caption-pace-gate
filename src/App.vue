<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  advancePreview,
  buildExportPayload,
  evaluateBatch,
  formatSpeed,
  formatTime,
  previewBounds,
  subtitlesAt,
  type ParseResult,
  type PreviewBounds,
  type RawSubtitle,
  type Verdict,
} from './lib/subtitles';

const rawInput = ref('');
const result = ref<ParseResult | null>(null);

const SAMPLE = [
  '00:00:00.000\t00:00:02.000\t观众朋友晚上好',
  '00:00:02.000\t00:00:05.000\t欢迎收看本期新闻节目',
  '00:00:05.000\t00:00:08.000\t以下是今天的主要内容',
].join('\n');

function runEvaluation() {
  // 重新裁决：立即停止并移除旧预览（格式错误时旧判定同样被替换清空）
  resetPreview();
  result.value = evaluateBatch(rawInput.value);
  // 新批次合法且非空：播放头复位到首条开始时间，等待开始预览
  const b = bounds.value;
  if (b) previewMs.value = b.startMs;
}

function clearAll() {
  resetPreview();
  rawInput.value = '';
  result.value = null;
}

function loadSample() {
  rawInput.value = SAMPLE;
  runEvaluation();
}

const verdict = computed<Verdict | null>(() =>
  result.value && result.value.ok ? result.value.verdict : null,
);
const errors = computed(() => (result.value && !result.value.ok ? result.value.errors : []));

const overlapIndexSet = computed(() => {
  const set = new Set<number>();
  if (verdict.value) {
    for (const o of verdict.value.overlaps) {
      set.add(o.earlierIndex);
      set.add(o.laterIndex);
    }
  }
  return set;
});

/* ---- 时间轴比例 ---- */
const tlDomain = computed(() => {
  const v = verdict.value;
  if (!v || v.sorted.length === 0) return { min: 0, span: 1 };
  const min = v.sorted[0].startMs;
  let max = v.sorted[0].endMs;
  for (const s of v.sorted) max = Math.max(max, s.endMs);
  const span = Math.max(max - min, 1);
  return { min, span };
});

function pct(ms: number): number {
  const { min, span } = tlDomain.value;
  return ((ms - min) / span) * 100;
}

const ticks = computed(() => {
  const { min, span } = tlDomain.value;
  const count = 8;
  return Array.from({ length: count + 1 }, (_, i) => {
    const ms = Math.round(min + (span * i) / count);
    const pos = (i / count) * 100;
    // 首尾刻度不做居中偏移，避免标签被容器裁切
    const transform = i === 0 ? 'translateX(0)' : i === count ? 'translateX(-100%)' : 'translateX(-50%)';
    return { ms, pos, transform, label: formatTime(ms) };
  });
});

/* ---- 出屏预览 ---- */
/** 预览状态：未开始 / 播放中 / 已暂停 / 已完成 */
type PreviewStatus = 'idle' | 'playing' | 'paused' | 'done';
const previewStatus = ref<PreviewStatus>('idle');
/** 播放头当前时刻（毫秒）：播放头、时间标签、字幕卡片共享同一值 */
const previewMs = ref(0);

/** 预览时间边界；null 表示空批次（不显示预览控制） */
const bounds = computed<PreviewBounds | null>(() =>
  verdict.value ? previewBounds(verdict.value) : null,
);

/** 当前时刻命中的字幕（重叠时段多条，空档为空） */
const activeSubs = computed<RawSubtitle[]>(() => {
  const v = verdict.value;
  if (!v || v.sorted.length === 0) return [];
  return subtitlesAt(v, previewMs.value);
});

const previewStatusLabel = computed(() => {
  switch (previewStatus.value) {
    case 'playing':
      return '播放中';
    case 'paused':
      return '已暂停';
    case 'done':
      return '预览完成';
    default:
      return '未开始';
  }
});

const previewToggleLabel = computed(() => {
  switch (previewStatus.value) {
    case 'playing':
      return '暂停';
    case 'paused':
      return '继续预览';
    case 'done':
      return '重新预览';
    default:
      return '开始预览';
  }
});

let rafId: number | null = null;
/** 播放锚点：开始/续播时刻的 performance.now 与对应播放头位置，避免逐帧累积误差 */
let anchorPerf = 0;
let anchorMs = 0;

function stopClock() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function tick(now: number) {
  const b = bounds.value;
  if (!b) {
    rafId = null;
    return;
  }
  const next = advancePreview(b, anchorMs, now - anchorPerf);
  previewMs.value = Math.round(next.tMs);
  if (next.done) {
    // 拖到/播到末尾：停在结束位置并标记预览完成
    previewStatus.value = 'done';
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(tick);
}

function startClock() {
  stopClock();
  anchorPerf = performance.now();
  anchorMs = previewMs.value;
  rafId = requestAnimationFrame(tick);
}

function togglePreview() {
  const b = bounds.value;
  if (!b) return;
  if (previewStatus.value === 'playing') {
    stopClock();
    previewStatus.value = 'paused';
    return;
  }
  // 未开始/已完成：从首条开始时间起播；已暂停：从当前位置继续
  if (previewStatus.value !== 'paused') previewMs.value = b.startMs;
  previewStatus.value = 'playing';
  startClock();
}

function onScrub(event: Event) {
  const b = bounds.value;
  if (!b) return;
  const ms = Number((event.target as HTMLInputElement).value);
  previewMs.value = Math.min(Math.max(ms, b.startMs), b.endMs);
  if (previewMs.value >= b.endMs) {
    stopClock();
    previewStatus.value = 'done';
  } else if (previewStatus.value === 'playing') {
    startClock(); // 以新位置为锚点继续播放
  } else {
    previewStatus.value = 'paused';
  }
}

/** 立即停止并移除旧预览（重新裁决 / 清空 / 格式错误时调用） */
function resetPreview() {
  stopClock();
  previewStatus.value = 'idle';
  previewMs.value = 0;
}

onBeforeUnmount(stopClock);

/* ---- 下载 JSON ---- */
function downloadJson() {
  const v = verdict.value;
  if (!v) return;
  const payload = buildExportPayload(v);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `subtitle-verdict-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
</script>

<template>
  <header class="app-header">
    <h1>字幕节奏门禁</h1>
    <p>
      粘贴多行字幕（每行：开始时间 ⇥ 结束时间 ⇥ 文本，时间格式 HH:MM:SS.mmm），整批裁决阅读速度与时间重叠。
      合格线：速度 ≤ 15 字/秒（空白与标点 ，。！？；：,.!?:; 不计字）。
    </p>
  </header>

  <section class="panel">
    <h2>输入区</h2>
    <textarea
      v-model="rawInput"
      class="input-area"
      data-testid="input-area"
      spellcheck="false"
      placeholder="00:00:00.000	00:00:02.000	观众朋友晚上好&#10;00:00:02.000	00:00:05.000	欢迎收看本期节目"
    ></textarea>
    <div class="toolbar">
      <button class="primary" data-testid="evaluate-btn" @click="runEvaluation">开始裁决</button>
      <button data-testid="sample-btn" @click="loadSample">载入示例</button>
      <button data-testid="clear-btn" @click="clearAll">清空</button>
      <span class="hint">字段以制表符（Tab）分隔；整批按开始时间升序裁决。</span>
    </div>
  </section>

  <!-- 格式错误：整批拒绝 -->
  <section v-if="errors.length > 0" class="errors" data-testid="errors-panel">
    <h3>格式错误，整批拒绝（旧判定已清空）</h3>
    <ul>
      <li v-for="e in errors" :key="e.lineNo" :data-testid="`error-line-${e.lineNo}`">
        第 {{ e.lineNo }} 行：{{ e.message }}
      </li>
    </ul>
  </section>

  <template v-if="verdict">
    <!-- 总判定横幅 -->
    <div
      v-if="verdict.passed && verdict.sorted.length > 0"
      class="verdict pass"
      data-testid="verdict-pass"
      role="status"
    >
      <span>✅ 绿色播出许可：全部 {{ verdict.sorted.length }} 条字幕节奏合格，准予播出。</span>
    </div>
    <div v-else-if="!verdict.passed" class="verdict fail" data-testid="verdict-fail" role="alert">
      <span>⛔ 拒绝播出</span>
      <div class="reasons" data-testid="reason-set">
        <span v-for="r in verdict.reasons" :key="r" class="reason-badge">{{ r }}</span>
      </div>
    </div>
    <p v-else class="hint" data-testid="empty-hint">输入区为空，请粘贴至少一行合法字幕后再裁决。</p>

    <section v-if="verdict.sorted.length > 0" class="panel">
      <h2>时间轴 · 出屏预览</h2>
      <!-- 预览控制：开始/暂停 + 时间轴拖动 + 当前时刻 + 状态（仅合法非空批次渲染） -->
      <div class="preview-controls">
        <button class="primary" data-testid="preview-toggle" @click="togglePreview">
          {{ previewToggleLabel }}
        </button>
        <input
          type="range"
          class="preview-scrubber"
          data-testid="preview-scrubber"
          :min="bounds!.startMs"
          :max="bounds!.endMs"
          step="1"
          :value="previewMs"
          aria-label="拖动定位预览时刻"
          @input="onScrub"
        />
        <span class="preview-clock" data-testid="preview-clock">{{ formatTime(previewMs) }}</span>
        <span class="preview-status" :data-status="previewStatus" data-testid="preview-status">
          {{ previewStatusLabel }}
        </span>
      </div>
      <div class="timeline-scroll">
        <div class="timeline" data-testid="timeline">
          <div class="tl-axis">
            <span
              v-for="t in ticks"
              :key="t.label + t.pos"
              class="tl-tick"
              :style="{ left: t.pos + '%', transform: t.transform }"
              >{{ t.label }}</span
            >
          </div>
          <div class="tl-zones">
            <div
              v-for="(o, i) in verdict.overlaps"
              :key="'z' + i"
              class="tl-zone"
              data-testid="timeline-overlap-zone"
              :style="{
                left: pct(o.overlapStartMs) + '%',
                width: Math.max(pct(o.overlapEndMs) - pct(o.overlapStartMs), 0.5) + '%',
              }"
            ></div>
          </div>
          <div
            v-for="(s, i) in verdict.sorted"
            :key="'l' + s.lineNo"
            class="tl-lane"
          >
            <div
              class="tl-bar"
              :class="{
                speeding: verdict.speedingIndices.includes(i),
                overlapped: overlapIndexSet.has(i),
              }"
              :data-testid="`timeline-bar-${i}`"
              :style="{
                left: pct(s.startMs) + '%',
                width: Math.max(pct(s.endMs) - pct(s.startMs), 0.3) + '%',
              }"
            >
              <span class="tl-bar-label">#{{ s.lineNo }} {{ s.text }}</span>
            </div>
          </div>
          <!-- 播放头：与时间标签、字幕卡片共享 previewMs -->
          <div
            class="tl-playhead"
            data-testid="playhead"
            :style="{ left: pct(previewMs) + '%' }"
          ></div>
        </div>
      </div>
      <div class="tl-legend">
        <span><span class="swatch" style="background: var(--blue)"></span>正常</span>
        <span><span class="swatch" style="background: var(--orange)"></span>超速（&gt;15 字/秒）</span>
        <span
          ><span
            class="swatch"
            style="background: repeating-linear-gradient(45deg, var(--red), var(--red) 3px, #7f1d1d 3px, #7f1d1d 6px)"
          ></span
          >重叠时段</span
        >
      </div>
      <!-- 出屏舞台：当前时刻命中的字幕文本（重叠时同时显示多条） -->
      <div class="preview-stage" data-testid="preview-stage">
        <span v-if="activeSubs.length === 0" class="preview-gap" data-testid="preview-gap">
          （此时刻无字幕）
        </span>
        <div
          v-for="s in activeSubs"
          :key="'cap' + s.lineNo"
          class="preview-caption"
          data-testid="preview-caption"
        >
          {{ s.text }}
        </div>
      </div>
    </section>

    <!-- 问题时间段清单 -->
    <section v-if="!verdict.passed" class="panel lists" data-testid="issue-lists">
      <div>
        <p class="section-title">超速条目时间段</p>
        <ul v-if="verdict.speedingIndices.length > 0" data-testid="speeding-list">
          <li
            v-for="i in verdict.speedingIndices"
            :key="'sp' + i"
            :data-testid="`speeding-item-${i}`"
          >
            #{{ verdict.sorted[i].lineNo }}
            {{ formatTime(verdict.sorted[i].startMs) }} ~
            {{ formatTime(verdict.sorted[i].endMs) }}
            速度 {{ formatSpeed(verdict.sorted[i].speed) }} 字/秒
          </li>
        </ul>
        <p v-else class="hint">无</p>
      </div>
      <div>
        <p class="section-title overlap">重叠对时间段</p>
        <ul v-if="verdict.overlaps.length > 0" data-testid="overlap-list">
          <li
            v-for="(o, i) in verdict.overlaps"
            :key="'ov' + i"
            :data-testid="`overlap-item-${i}`"
          >
            #{{ verdict.sorted[o.earlierIndex].lineNo }}
            与 #{{ verdict.sorted[o.laterIndex].lineNo }}
            共同占屏 {{ formatTime(o.overlapStartMs) }} ~
            {{ formatTime(o.overlapEndMs) }}
          </li>
        </ul>
        <p v-else class="hint">无</p>
      </div>
    </section>

    <!-- 明细表 -->
    <section v-if="verdict.sorted.length > 0" class="panel">
      <h2>
        裁决明细
        <button
          style="float: right; padding: 4px 14px; font-size: 13px"
          data-testid="download-btn"
          @click="downloadJson"
        >
          下载判定 JSON
        </button>
      </h2>
      <div style="overflow-x: auto">
        <table class="detail">
          <thead>
            <tr>
              <th>原始行</th>
              <th>开始</th>
              <th>结束</th>
              <th>文本</th>
              <th>字数</th>
              <th>时长(秒)</th>
              <th>速度(字/秒)</th>
              <th>判定</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(s, i) in verdict.sorted"
              :key="'r' + s.lineNo"
              :class="{
                speeding: verdict.speedingIndices.includes(i),
                overlapped: overlapIndexSet.has(i),
              }"
            >
              <td>{{ s.lineNo }}</td>
              <td>{{ formatTime(s.startMs) }}</td>
              <td>{{ formatTime(s.endMs) }}</td>
              <td>{{ s.text }}</td>
              <td>{{ s.readingChars }}</td>
              <td>{{ s.durationSec.toFixed(3) }}</td>
              <td data-testid="speed-cell">{{ formatSpeed(s.speed) }}</td>
              <td>
                <span v-if="verdict.speedingIndices.includes(i)" class="tag speed-tag">超速</span>
                <span v-if="overlapIndexSet.has(i)" class="tag overlap-tag">重叠</span>
                <span
                  v-if="!verdict.speedingIndices.includes(i) && !overlapIndexSet.has(i)"
                  class="tag ok-tag"
                  >合格</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
