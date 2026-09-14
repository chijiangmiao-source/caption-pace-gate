import { expect, test } from '@playwright/test';

const T = '\t';
const line = (start: string, end: string, text: string) =>
  `${start}${T}${end}${T}${text}`;

async function evaluate(page: import('@playwright/test').Page, input: string) {
  await page.getByTestId('input-area').fill(input);
  await page.getByTestId('evaluate-btn').click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('正常放行', () => {
  test('合法批次显示绿色播出许可', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:00.000', '00:00:02.000', '观众朋友晚上好'),
        line('00:00:02.000', '00:00:05.000', '欢迎收看本期新闻节目'),
      ].join('\n'),
    );
    await expect(page.getByTestId('verdict-pass')).toBeVisible();
    await expect(page.getByTestId('verdict-pass')).toContainText('绿色播出许可');
    await expect(page.getByTestId('verdict-fail')).toHaveCount(0);
    // 时间轴无超速/重叠标记
    await expect(page.locator('.tl-bar.speeding')).toHaveCount(0);
    await expect(page.getByTestId('timeline-overlap-zone')).toHaveCount(0);
  });

  test('整批乱序输入后明细按开始时间升序排列', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:05.000', '00:00:06.000', '第五条'),
        line('00:00:01.000', '00:00:02.000', '第一条'),
        line('00:00:03.000', '00:00:04.000', '第三条'),
      ].join('\n'),
    );
    const firstRow = page.locator('table.detail tbody tr').first();
    await expect(firstRow).toContainText('00:00:01.000');
    await expect(page.locator('table.detail tbody tr').nth(2)).toContainText('00:00:05.000');
  });
});

test.describe('速度临界值', () => {
  test('恰好 15 字/秒放行', async ({ page }) => {
    await evaluate(page, line('00:00:00.000', '00:00:01.000', '字'.repeat(15)));
    await expect(page.getByTestId('verdict-pass')).toBeVisible();
  });

  test('16 字/秒拒绝并标出超速条目与时间段', async ({ page }) => {
    await evaluate(page, line('00:00:00.000', '00:00:01.000', '字'.repeat(16)));
    await expect(page.getByTestId('verdict-fail')).toBeVisible();
    await expect(page.locator('[data-testid="speed-cell"]')).toHaveText('16.00');
    await expect(page.locator('.tl-bar.speeding')).toHaveCount(1);
    await expect(page.getByTestId('speeding-item-0')).toContainText(
      '00:00:00.000 ~ 00:00:01.000 速度 16.00 字/秒',
    );
    const reasons = page.getByTestId('reason-set');
    await expect(reasons).toContainText('超速');
  });

  test('未舍入 15.00375 判超速，但界面显示两位小数 15.00', async ({ page }) => {
    await evaluate(page, line('00:00:00.000', '00:00:03.999', '字'.repeat(60)));
    await expect(page.getByTestId('verdict-fail')).toBeVisible();
    await expect(page.locator('[data-testid="speed-cell"]')).toHaveText('15.00');
    await expect(page.locator('.tl-bar.speeding')).toHaveCount(1);
  });

  test('标点与空白不计字：含 15 个阅读字加大量标点仍合格', async ({ page }) => {
    await evaluate(
      page,
      line('00:00:00.000', '00:00:01.000', '字'.repeat(15) + '，。！？；：,.!?;:    '),
    );
    await expect(page.getByTestId('verdict-pass')).toBeVisible();
  });
});

test.describe('重叠临界值', () => {
  test('结束与下条开始相等：不重叠，放行', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:00.000', '00:00:02.000', '甲甲甲'),
        line('00:00:02.000', '00:00:04.000', '乙乙乙'),
      ].join('\n'),
    );
    await expect(page.getByTestId('verdict-pass')).toBeVisible();
    await expect(page.getByTestId('timeline-overlap-zone')).toHaveCount(0);
  });

  test('晚 1 毫秒即重叠：标出重叠对与共同占屏时间段', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:00.000', '00:00:02.000', '甲甲甲'),
        line('00:00:01.999', '00:00:04.000', '乙乙乙'),
      ].join('\n'),
    );
    await expect(page.getByTestId('verdict-fail')).toBeVisible();
    await expect(page.getByTestId('timeline-overlap-zone')).toHaveCount(1);
    await expect(page.getByTestId('overlap-item-0')).toContainText(
      '共同占屏 00:00:01.999 ~ 00:00:02.000',
    );
    await expect(page.getByTestId('reason-set')).toContainText('重叠');
  });

  test('多重重叠全部标出，超速与重叠原因同时出现且唯一', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:00.000', '00:00:03.000', '超'.repeat(50)), // 超速
        line('00:00:02.000', '00:00:05.000', '重叠第二个'),
        line('00:00:04.500', '00:00:06.000', '重叠第三个'),
      ].join('\n'),
    );
    await expect(page.getByTestId('timeline-overlap-zone')).toHaveCount(2);
    await expect(page.locator('.tl-bar.speeding')).toHaveCount(1);
    const badges = page.getByTestId('reason-set').locator('.reason-badge');
    await expect(badges).toHaveCount(2);
    const texts = await badges.allTextContents();
    expect(new Set(texts).size).toBe(2);
  });
});

test.describe('整批拒绝与清空旧判定', () => {
  test('格式错误整批拒绝，旧判定清空；修正后恢复', async ({ page }) => {
    await evaluate(
      page,
      [
        line('00:00:00.000', '00:00:02.000', '观众朋友晚上好'),
        line('00:00:02.000', '00:00:05.000', '欢迎收看本期新闻'),
      ].join('\n'),
    );
    await expect(page.getByTestId('verdict-pass')).toBeVisible();

    // 粘贴含格式错误的批次：字段数不对 + 结束早于开始
    await evaluate(
      page,
      ['00:00:00.000\t缺少字段', line('00:00:03.000', '00:00:02.000', '时间倒置')].join('\n'),
    );
    await expect(page.getByTestId('errors-panel')).toBeVisible();
    await expect(page.getByTestId('verdict-pass')).toHaveCount(0);
    await expect(page.getByTestId('timeline')).toHaveCount(0);
    await expect(page.getByTestId('error-line-1')).toContainText('字段数错误');
    await expect(page.getByTestId('error-line-2')).toContainText('必须晚于开始时间');

    // 修正后重新放行
    await evaluate(page, line('00:00:00.000', '00:00:02.000', '重新合法字幕'));
    await expect(page.getByTestId('errors-panel')).toHaveCount(0);
    await expect(page.getByTestId('verdict-pass')).toBeVisible();
  });

  test('时间越界（24:00:00.000）整批拒绝', async ({ page }) => {
    await evaluate(page, line('24:00:00.000', '24:00:01.000', '越界'));
    await expect(page.getByTestId('errors-panel')).toBeVisible();
    await expect(page.getByTestId('error-line-1')).toContainText('开始时间格式非法');
  });

  test('空白文本整批拒绝', async ({ page }) => {
    await evaluate(page, line('00:00:00.000', '00:00:01.000', '  　 '));
    await expect(page.getByTestId('errors-panel')).toBeVisible();
    await expect(page.getByTestId('error-line-1')).toContainText('文本');
  });
});

test.describe('JSON 下载', () => {
  test('下载文件含原始行、两位小数速度与 REJECT 总判定', async ({ page }) => {
    const raw = line('00:00:00.000', '00:00:01.000', '字'.repeat(16));
    await evaluate(page, raw);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-btn').click(),
    ]);
    const path = await download.path();
    expect(path).toBeTruthy();
    const fs = await import('node:fs');
    const data = JSON.parse(fs.readFileSync(path!, 'utf8'));
    expect(data.verdict).toBe('REJECT');
    expect(data.totalLines).toBe(1);
    expect(data.rows[0].rawLine).toBe(raw);
    expect(data.rows[0].speed).toBe('16.00');
    expect(data.rows[0].speeding).toBe(true);
    expect(data.reasons.length).toBeGreaterThan(0);
  });

  test('合格批次下载 PASS', async ({ page }) => {
    await evaluate(page, line('00:00:00.000', '00:00:02.000', '合格字幕内容'));
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-btn').click(),
    ]);
    const path = await download.path();
    const fs = await import('node:fs');
    const data = JSON.parse(fs.readFileSync(path!, 'utf8'));
    expect(data.verdict).toBe('PASS');
    expect(data.rows[0].rawLine).toContain('合格字幕内容');
  });
});
