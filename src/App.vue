<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  buildExportPayload,
  evaluateBatch,
  formatSpeed,
  formatTime,
  type ParseResult,
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
  // 整批裁决；格式错误时 evaluateBatch 返回错误，旧判定即被替换（清空）
  result.value = evaluateBatch(rawInput.value);
}

function clearAll() {
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
      <h2>时间轴</h2>
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
