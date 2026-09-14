/**
 * 字幕批处理核心：解析、校验、排序、节奏裁决
 * 纯函数，无 DOM 依赖，便于单元测试。
 */

/** 时间格式：HH:MM:SS.mmm，范围 00:00:00.000 ~ 23:59:59.999 */
export const TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/** 阅读时不计数的字符：空白 + 中英文常用标点 */
const NON_COUNTING_PUNCTUATION = new Set([
  '，', '。', '！', '？', '；', '：',
  ',', '.', '!', '?', ';', ':',
]);

/** 速度合格上限（字/秒，未舍入值比较） */
export const SPEED_LIMIT = 15;

export interface RawSubtitle {
  /** 输入区中的原始行号（1 起，含全部物理行） */
  lineNo: number;
  /** 未经任何处理的原始行文本 */
  rawLine: string;
  startMs: number;
  endMs: number;
  text: string;
  durationSec: number;
  /** Unicode 码点数（去除首尾空白后文本中、且排除空白与指定标点） */
  readingChars: number;
  /** 未舍入速度（字/秒），持续时间必然 > 0 */
  speed: number;
}

export interface OverlapPair {
  /** 排序后相邻两条的下标（sortedSubs 内） */
  earlierIndex: number;
  laterIndex: number;
  /** 实际冲突的共同占屏时间段（毫秒，闭区间语义；展示用） */
  overlapStartMs: number;
  overlapEndMs: number;
}

export interface Verdict {
  /** 是否整批通过：无超速且无重叠 */
  passed: boolean;
  /** 参与裁决的字幕，已按开始时间升序、同开始时间保持输入顺序 */
  sorted: RawSubtitle[];
  /** 超速条目在 sorted 中的下标集合 */
  speedingIndices: number[];
  /** 全部重叠（排序后相邻对判定即完备） */
  overlaps: OverlapPair[];
  /** 唯一拒绝原因集合（去重后的原因短语） */
  reasons: string[];
}

export interface FormatError {
  /** 出错物理行号（1 起） */
  lineNo: number;
  message: string;
}

export type ParseResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; errors: FormatError[] };

/** 解析单个时间字段，非法范围返回 null */
export function parseTime(token: string): number | null {
  const m = TIME_PATTERN.exec(token);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4]);
  if (h > 23 || min > 59 || s > 59) return null;
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

/** 毫秒数格式化为 HH:MM:SS.mmm */
export function formatTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const min = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(h)}:${pad2(min)}:${pad2(s)}.${pad3(milli)}`;
}

/**
 * 统计阅读字数：遍历 Unicode 码点，排除空白字符与指定标点。
 * 使用 for...of 按码点迭代，代理对（emoji 等）只算 1。
 */
export function countReadingChars(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (NON_COUNTING_PUNCTUATION.has(ch)) continue;
    count += 1;
  }
  return count;
}

/** 速度保留两位小数用于展示 */
export function formatSpeed(speed: number): string {
  return speed.toFixed(2);
}

/**
 * 解析并裁决整批输入。
 * 任一行格式错误即整批拒绝（返回全部错误，调用方清空旧判定）。
 */
export function evaluateBatch(input: string): ParseResult {
  // 按物理行切分；统一去除行尾的 CR，兼容 CRLF 粘贴
  const lines = input.split('\n').map((l) => l.replace(/\r$/, ''));
  const errors: FormatError[] = [];
  const blankLineNos: number[] = [];
  const parsed: Array<Omit<RawSubtitle, 'durationSec' | 'readingChars' | 'speed'>> = [];

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;

    // 记录空白物理行（严格格式下，只要批次存在数据行即为非法）
    if (rawLine.trim() === '') {
      blankLineNos.push(lineNo);
      return;
    }

    // 严格按制表符切分，且必须恰好 3 个字段
    const fields = rawLine.split('\t');
    if (fields.length !== 3) {
      errors.push({
        lineNo,
        message: `字段数错误：应为 3 个制表符分隔字段，实际 ${fields.length} 个`,
      });
      return;
    }

    const [startToken, endToken, textRaw] = fields;
    const startMs = parseTime(startToken);
    if (startMs === null) {
      errors.push({ lineNo, message: `开始时间格式非法：「${startToken}」（需 HH:MM:SS.mmm）` });
      return;
    }
    const endMs = parseTime(endToken);
    if (endMs === null) {
      errors.push({ lineNo, message: `结束时间格式非法：「${endToken}」（需 HH:MM:SS.mmm）` });
      return;
    }
    if (endMs <= startMs) {
      errors.push({
        lineNo,
        message: `结束时间 ${formatTime(endMs)} 必须晚于开始时间 ${formatTime(startMs)}`,
      });
      return;
    }

    const text = textRaw.trim();
    if (text === '') {
      errors.push({ lineNo, message: '文本去除首尾空白后为空' });
      return;
    }

    parsed.push({ lineNo, rawLine, startMs, endMs, text });
  });

  // 严格格式：每行都必须是三个制表符分隔字段。
  // 批次中存在数据行时，夹在任何位置（含首尾、两条之间）的空白行均使整批非法；
  // 整个输入全为空白时视为“尚未提交批次”，交由界面给中性提示。
  if (parsed.length > 0 && blankLineNos.length > 0) {
    for (const lineNo of blankLineNos) {
      errors.push({ lineNo, message: '空白行：每行必须为“开始时间⇥结束时间⇥文本”三个字段' });
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.lineNo - b.lineNo);
    return { ok: false, errors };
  }
  if (parsed.length === 0) {
    // 空输入不构成批次：不视为错误，也无判定
    return {
      ok: true,
      verdict: { passed: true, sorted: [], speedingIndices: [], overlaps: [], reasons: [] },
    };
  }

  // 先计算每条的节奏指标（与顺序无关）
  const rich: RawSubtitle[] = parsed.map((p) => {
    const durationSec = (p.endMs - p.startMs) / 1000;
    const readingChars = countReadingChars(p.text);
    return { ...p, durationSec, readingChars, speed: readingChars / durationSec };
  });

  // 稳定排序：开始时间升序，相等时保持输入顺序（Array.prototype.sort 为稳定排序）
  rich.sort((a, b) => a.startMs - b.startMs);

  const speedingIndices: number[] = [];
  rich.forEach((sub, i) => {
    // 未舍入值与上限比较
    if (sub.speed > SPEED_LIMIT) speedingIndices.push(i);
  });

  const overlaps: OverlapPair[] = [];
  for (let i = 0; i < rich.length - 1; i += 1) {
    const cur = rich[i];
    const next = rich[i + 1];
    // 按开始时间排序后，重叠只需检查相邻对：
    // end(i) > start(i+1) 即重叠；相等不重叠
    if (cur.endMs > next.startMs) {
      overlaps.push({
        earlierIndex: i,
        laterIndex: i + 1,
        overlapStartMs: next.startMs,
        overlapEndMs: Math.min(cur.endMs, next.endMs),
      });
    }
  }

  const reasons = buildReasons(speedingIndices.length, overlaps.length);

  return {
    ok: true,
    verdict: {
      passed: speedingIndices.length === 0 && overlaps.length === 0,
      sorted: rich,
      speedingIndices,
      overlaps,
      reasons,
    },
  };
}

function buildReasons(speedingCount: number, overlapCount: number): string[] {
  const reasons: string[] = [];
  if (speedingCount > 0) reasons.push(`存在 ${speedingCount} 条超速字幕（速度 > ${SPEED_LIMIT} 字/秒）`);
  if (overlapCount > 0) reasons.push(`存在 ${overlapCount} 对时间重叠字幕`);
  return reasons;
}

/* ------------------------------------------------------------------ */
/* 出屏预览：基于 Verdict.sorted 的纯函数查询（不改变播出许可）          */
/* ------------------------------------------------------------------ */

/** 预览时间边界（毫秒） */
export interface PreviewBounds {
  /** 首条字幕开始时刻：播放头起点 */
  startMs: number;
  /** 全部字幕最晚结束时刻：播放头终点 */
  endMs: number;
}

/**
 * 预览时间边界。Verdict.sorted 已按开始时间升序，
 * 起点即首条开始时间；终点取全部字幕 endMs 的最大值。
 * 空批次返回 null（界面据此不显示预览控制）。
 */
export function previewBounds(verdict: Verdict): PreviewBounds | null {
  const sorted = verdict.sorted;
  if (sorted.length === 0) return null;
  let endMs = sorted[0].endMs;
  for (const s of sorted) {
    if (s.endMs > endMs) endMs = s.endMs;
  }
  return { startMs: sorted[0].startMs, endMs };
}

/**
 * 查询某一时刻命中的字幕。占屏区间为 [startMs, endMs) 半开区间，
 * 与重叠裁决一致（结束时刻等于下一条开始时刻不算重叠）。
 * 重叠时段同时返回全部命中条目；空档时段返回空数组。
 */
export function subtitlesAt(verdict: Verdict, tMs: number): RawSubtitle[] {
  return verdict.sorted.filter((s) => s.startMs <= tMs && tMs < s.endMs);
}

/**
 * 播放头按真实经过毫秒推进；到达边界末尾即停在 endMs 并标记完成，
 * 不会越过结束位置。
 */
export function advancePreview(
  bounds: PreviewBounds,
  currentMs: number,
  elapsedMs: number,
): { tMs: number; done: boolean } {
  const tMs = Math.min(currentMs + elapsedMs, bounds.endMs);
  return { tMs, done: tMs >= bounds.endMs };
}

export interface ExportRow {
  lineNo: number;
  rawLine: string;
  start: string;
  end: string;
  text: string;
  durationSec: number;
  readingChars: number;
  speed: string;
  speeding: boolean;
  overlapped: boolean;
}

export interface ExportPayload {
  verdict: 'PASS' | 'REJECT';
  totalLines: number;
  speedLimit: number;
  reasons: string[];
  rows: ExportRow[];
  overlaps: Array<{
    earlierLineNo: number;
    laterLineNo: number;
    overlapStart: string;
    overlapEnd: string;
  }>;
  evaluatedAt: string;
}

/** 构造可下载 JSON 的内容（含原始行、速度及总判定） */
export function buildExportPayload(verdict: Verdict): ExportPayload {
  const overlapIndexSet = new Set<number>();
  const overlapDetails = verdict.overlaps.map((o) => {
    overlapIndexSet.add(o.earlierIndex);
    overlapIndexSet.add(o.laterIndex);
    return {
      earlierLineNo: verdict.sorted[o.earlierIndex].lineNo,
      laterLineNo: verdict.sorted[o.laterIndex].lineNo,
      overlapStart: formatTime(o.overlapStartMs),
      overlapEnd: formatTime(o.overlapEndMs),
    };
  });

  const rows: ExportRow[] = verdict.sorted.map((sub, i) => ({
    lineNo: sub.lineNo,
    rawLine: sub.rawLine,
    start: formatTime(sub.startMs),
    end: formatTime(sub.endMs),
    text: sub.text,
    durationSec: Number(sub.durationSec.toFixed(3)),
    readingChars: sub.readingChars,
    speed: formatSpeed(sub.speed),
    speeding: verdict.speedingIndices.includes(i),
    overlapped: overlapIndexSet.has(i),
  }));

  return {
    verdict: verdict.passed ? 'PASS' : 'REJECT',
    totalLines: rows.length,
    speedLimit: SPEED_LIMIT,
    reasons: verdict.reasons,
    rows,
    overlaps: overlapDetails,
    evaluatedAt: new Date().toISOString(),
  };
}
