import { describe, expect, it } from 'vitest';
import {
  advancePreview,
  buildExportPayload,
  countReadingChars,
  evaluateBatch,
  formatSpeed,
  formatTime,
  parseTime,
  previewBounds,
  subtitlesAt,
} from '../../src/lib/subtitles';

const T = '\t';
const line = (start: string, end: string, text: string) =>
  `${start}${T}${end}${T}${text}`;

describe('parseTime 时间边界', () => {
  it('接受合法边界 00:00:00.000 与 23:59:59.999', () => {
    expect(parseTime('00:00:00.000')).toBe(0);
    expect(parseTime('23:59:59.999')).toBe(23 * 3600_000 + 59 * 60_000 + 59_000 + 999);
  });

  it('拒绝越界时间', () => {
    expect(parseTime('24:00:00.000')).toBeNull();
    expect(parseTime('00:60:00.000')).toBeNull();
    expect(parseTime('00:00:60.000')).toBeNull();
  });

  it('拒绝形状不合法的时间', () => {
    expect(parseTime('0:00:00.000')).toBeNull();
    expect(parseTime('00:00:00,000')).toBeNull(); // 逗号而非点
    expect(parseTime('00:00:00.00')).toBeNull();
    expect(parseTime('00:00:00.0000')).toBeNull();
    expect(parseTime('')).toBeNull();
  });

  it('formatTime 往返一致', () => {
    expect(formatTime(0)).toBe('00:00:00.000');
    expect(formatTime(86_399_999)).toBe('23:59:59.999');
    expect(formatTime(parseTime('01:02:03.456')!)).toBe('01:02:03.456');
  });
});

describe('countReadingChars 阅读字数', () => {
  it('普通字符按 Unicode 码点计数', () => {
    expect(countReadingChars('你好world')).toBe(7);
  });

  it('空白字符不计数（含全角空格）', () => {
    expect(countReadingChars('a b\tc　d')).toBe(4);
  });

  it('中英文常用标点不计数', () => {
    expect(countReadingChars('你好，世界。！？；：,.!?;:')).toBe(4);
  });

  it('代理对 emoji 只算 1 个码点', () => {
    expect(countReadingChars('a😀b，！')).toBe(3);
  });
});

describe('evaluateBatch 格式校验', () => {
  it('字段数错误：整批拒绝并给出物理行号', () => {
    const input = ['00:00:00.000\t00:00:01.000\tabc', 'x\ty'].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].lineNo).toBe(2);
    }
  });

  it('4 个字段同样拒绝', () => {
    const r = evaluateBatch('00:00:00.000\t00:00:01.000\ta\tb');
    expect(r.ok).toBe(false);
  });

  it('结束时间必须晚于开始时间（相等与更早都拒绝）', () => {
    const equal = evaluateBatch(line('00:00:01.000', '00:00:01.000', '文本'));
    expect(equal.ok).toBe(false);
    const earlier = evaluateBatch(line('00:00:02.000', '00:00:01.000', '文本'));
    expect(earlier.ok).toBe(false);
  });

  it('文本去除首尾空白后为空则拒绝', () => {
    const r = evaluateBatch(line('00:00:00.000', '00:00:01.000', '   　 '));
    expect(r.ok).toBe(false);
  });

  it('时间字段非法时整批拒绝', () => {
    const r = evaluateBatch(line('00:00:00.00', '00:00:01.000', '文本'));
    expect(r.ok).toBe(false);
  });

  it('一次返回全部错误行', () => {
    const input = [
      line('00:00:00.000', '00:00:01.000', '正常'),
      'bad',
      line('00:00:01.000', '00:00:00.000', '倒置'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.lineNo)).toEqual([2, 3]);
  });

  it('严格格式：两条字幕之间夹空白行整批拒绝', () => {
    const input = [
      line('00:00:00.000', '00:00:01.000', '第一条'),
      '   ',
      line('00:00:01.000', '00:00:02.000', '第二条'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].lineNo).toBe(2);
      expect(r.errors[0].message).toContain('空白行');
    }
  });

  it('严格格式：首尾空白行同样整批拒绝', () => {
    const withLeading = ['', line('00:00:00.000', '00:00:01.000', '文本')].join('\n');
    expect(evaluateBatch(withLeading).ok).toBe(false);
    const withTrailing = [line('00:00:00.000', '00:00:01.000', '文本'), '\t  '].join('\n');
    expect(evaluateBatch(withTrailing).ok).toBe(false);
  });

  it('空白行错误与其他格式错误都被收集且按行号排序', () => {
    const input = [
      line('00:00:00.000', '00:00:01.000', '正常'),
      '',
      'bad',
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.lineNo)).toEqual([2, 3]);
  });

  it('整段输入全为空白时为空批次（不算错误）', () => {
    const r = evaluateBatch('   \n\t\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.sorted).toHaveLength(0);
  });

  it('兼容 CRLF 行尾粘贴', () => {
    const r = evaluateBatch(
      [line('00:00:00.000', '00:00:01.000', '甲'), line('00:00:01.000', '00:00:02.000', '乙')].join('\r\n'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.sorted).toHaveLength(2);
  });
});

describe('evaluateBatch 排序', () => {
  it('按开始时间升序裁决', () => {
    const input = [
      line('00:00:05.000', '00:00:06.000', '五'),
      line('00:00:01.000', '00:00:02.000', '一'),
      line('00:00:03.000', '00:00:04.000', '三'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.sorted.map((s) => s.lineNo)).toEqual([2, 3, 1]);
  });

  it('开始时间相同保持输入顺序（稳定性）', () => {
    const input = [
      line('00:00:01.000', '00:00:01.500', '甲'),
      line('00:00:00.000', '00:00:00.500', '零'),
      line('00:00:01.000', '00:00:02.000', '丙'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.sorted.map((s) => s.text)).toEqual(['零', '甲', '丙']);
  });
});

describe('速度裁决临界值（未舍入值，上限 15 字/秒）', () => {
  it('恰好 15.000 字/秒合格', () => {
    const text = '字'.repeat(15);
    const r = evaluateBatch(line('00:00:00.000', '00:00:01.000', text));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.speedingIndices).toHaveLength(0);
      expect(r.verdict.passed).toBe(true);
      expect(r.verdict.sorted[0].speed).toBeCloseTo(15, 10);
      expect(formatSpeed(r.verdict.sorted[0].speed)).toBe('15.00');
    }
  });

  it('16 字/秒超速', () => {
    const text = '字'.repeat(16);
    const r = evaluateBatch(line('00:00:00.000', '00:00:01.000', text));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.speedingIndices).toEqual([0]);
      expect(r.verdict.passed).toBe(false);
    }
  });

  it('原始值约 15.00375 超速，但两位小数显示为 15.00（按未舍入值裁决）', () => {
    // 60 个阅读字 / 3.999 秒 ≈ 15.0037509
    const text = '字'.repeat(60);
    const r = evaluateBatch(line('00:00:00.000', '00:00:03.999', text));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.sorted[0].speed).toBeCloseTo(15.0037509, 5);
      expect(formatSpeed(r.verdict.sorted[0].speed)).toBe('15.00');
      expect(r.verdict.speedingIndices).toEqual([0]);
    }
  });

  it('标点与空白不计字：30 个标点+15 个字在 1 秒内仍合格', () => {
    const text = '字'.repeat(15) + '，。！？'.repeat(3) + '     ';
    const r = evaluateBatch(line('00:00:00.000', '00:00:01.000', text));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.sorted[0].readingChars).toBe(15);
      expect(r.verdict.passed).toBe(true);
    }
  });
});

describe('重叠裁决临界值', () => {
  it('结束时间等于下一条开始时间：不重叠', () => {
    const input = [
      line('00:00:00.000', '00:00:02.000', '甲'),
      line('00:00:02.000', '00:00:04.000', '乙'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.overlaps).toHaveLength(0);
      expect(r.verdict.passed).toBe(true);
    }
  });

  it('结束时间比下一条开始晚 1 毫秒：重叠', () => {
    const input = [
      line('00:00:00.000', '00:00:02.000', '甲'),
      line('00:00:01.999', '00:00:04.000', '乙'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.overlaps).toHaveLength(1);
      const o = r.verdict.overlaps[0];
      expect(formatTime(o.overlapStartMs)).toBe('00:00:01.999');
      expect(formatTime(o.overlapEndMs)).toBe('00:00:02.000');
    }
  });

  it('仅比较排序后相邻对（任一字幕结束晚于下一条开始）', () => {
    // A 0~10s，B 2~3s，C 4~11s：相邻对只有 A-B 重叠
    const input = [
      line('00:00:00.000', '00:00:10.000', 'A'),
      line('00:00:02.000', '00:00:03.000', 'B'),
      line('00:00:04.000', '00:00:11.000', 'C'),
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.overlaps).toHaveLength(1);
      expect(r.verdict.overlaps[0].earlierIndex).toBe(0);
      expect(r.verdict.overlaps[0].laterIndex).toBe(1);
    }
  });
});

describe('拒绝原因集合', () => {
  it('同时超速与重叠时原因去重且各出现一次', () => {
    const input = [
      line('00:00:00.000', '00:00:02.000', '甲'.repeat(40)), // 超速且与乙重叠
      line('00:00:01.000', '00:00:02.000', '乙'.repeat(40)), // 超速
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.passed).toBe(false);
      expect(r.verdict.reasons).toHaveLength(2);
      expect(new Set(r.verdict.reasons).size).toBe(2);
      expect(r.verdict.reasons.join(' ')).toContain('超速');
      expect(r.verdict.reasons.join(' ')).toContain('重叠');
    }
  });
});

describe('出屏预览：previewBounds 时间边界', () => {
  it('起点为首条开始时间，终点为全部字幕最晚结束时间（乱序输入亦正确）', () => {
    const input = [
      line('00:00:05.000', '00:00:07.000', '丙'),
      line('00:00:01.000', '00:00:02.000', '甲'),
      line('00:00:03.000', '00:00:09.500', '乙'), // 结束最晚
    ].join('\n');
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(previewBounds(r.verdict)).toEqual({ startMs: 1000, endMs: 9500 });
    }
  });

  it('空批次返回 null（不显示预览控制）', () => {
    const r = evaluateBatch('   \n\t\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(previewBounds(r.verdict)).toBeNull();
  });
});

describe('出屏预览：subtitlesAt 当前时刻字幕', () => {
  // 甲 0~2s，乙 1~3s（与甲重叠 1~2s），丙 5~6s；3~5s 为空档
  const input = [
    line('00:00:00.000', '00:00:02.000', '甲'),
    line('00:00:01.000', '00:00:03.000', '乙'),
    line('00:00:05.000', '00:00:06.000', '丙'),
  ].join('\n');

  it('起止边界：开始时刻命中，结束时刻（半开区间）不再命中', () => {
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(subtitlesAt(r.verdict, 0).map((s) => s.text)).toEqual(['甲']);
      // t = 2000：甲已下屏，乙仍在屏（与重叠裁决的边界语义一致）
      expect(subtitlesAt(r.verdict, 2000).map((s) => s.text)).toEqual(['乙']);
      expect(subtitlesAt(r.verdict, 3000).map((s) => s.text)).toEqual([]);
    }
  });

  it('间隙无字幕：空档时刻返回空数组', () => {
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(subtitlesAt(r.verdict, 4000)).toEqual([]);
      expect(subtitlesAt(r.verdict, 4999)).toEqual([]);
    }
  });

  it('重叠时同时返回两条，且保持排序顺序', () => {
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hits = subtitlesAt(r.verdict, 1500);
      expect(hits.map((s) => s.text)).toEqual(['甲', '乙']);
    }
  });

  it('预览末尾时刻（endMs）无字幕命中', () => {
    const r = evaluateBatch(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const b = previewBounds(r.verdict)!;
      expect(b.endMs).toBe(6000);
      expect(subtitlesAt(r.verdict, b.endMs)).toEqual([]);
    }
  });
});

describe('出屏预览：advancePreview 播放头推进与末尾停止', () => {
  const bounds = { startMs: 1000, endMs: 5000 };

  it('按真实经过毫秒推进', () => {
    expect(advancePreview(bounds, 1000, 500)).toEqual({ tMs: 1500, done: false });
    expect(advancePreview(bounds, 1000, 3999.6)).toEqual({ tMs: 4999.6, done: false });
  });

  it('到达末尾停在结束位置并标记完成，不越过终点', () => {
    expect(advancePreview(bounds, 4500, 500)).toEqual({ tMs: 5000, done: true });
    // 推进量超出剩余时长：仍停在 endMs
    expect(advancePreview(bounds, 4500, 10_000)).toEqual({ tMs: 5000, done: true });
    // 已在末尾继续推进：保持结束位置
    expect(advancePreview(bounds, 5000, 100)).toEqual({ tMs: 5000, done: true });
  });
});

describe('buildExportPayload 导出内容', () => {
  it('含原始行、两位小数速度与总判定', () => {
    const raw = line('00:00:00.000', '00:00:01.000', '字'.repeat(16));
    const r = evaluateBatch(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const payload = buildExportPayload(r.verdict);
      expect(payload.verdict).toBe('REJECT');
      expect(payload.totalLines).toBe(1);
      expect(payload.rows[0].rawLine).toBe(raw);
      expect(payload.rows[0].speed).toBe('16.00');
      expect(payload.rows[0].speeding).toBe(true);
    }
  });

  it('合格批次导出 PASS 且重叠明细为空', () => {
    const raw = [
      line('00:00:00.000', '00:00:02.000', '观众朋友晚上好'),
      line('00:00:02.000', '00:00:05.000', '欢迎收看本期节目'),
    ].join('\n');
    const r = evaluateBatch(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const payload = buildExportPayload(r.verdict);
      expect(payload.verdict).toBe('PASS');
      expect(payload.overlaps).toEqual([]);
      expect(payload.reasons).toEqual([]);
    }
  });
});
