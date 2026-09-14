import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../src/App.vue';

const T = '\t';
const line = (start: string, end: string, text: string) =>
  `${start}${T}${end}${T}${text}`;

describe('App.vue 组件行为', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function setup(input: string) {
    const wrapper = mount(App, { attachTo: document.body });
    const ta = wrapper.get('[data-testid="input-area"]').element as HTMLTextAreaElement;
    ta.value = input;
    ta.dispatchEvent(new Event('input'));
    return wrapper;
  }

  it('合法批次显示绿色播出许可', async () => {
    const wrapper = setup(
      [
        line('00:00:00.000', '00:00:02.000', '观众朋友晚上好'),
        line('00:00:02.000', '00:00:05.000', '欢迎收看本期新闻节目'),
      ].join('\n'),
    );
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-pass"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="verdict-fail"]').exists()).toBe(false);
  });

  it('超速条目被标记且显示两位小数速度', async () => {
    const wrapper = setup(line('00:00:00.000', '00:00:01.000', '字'.repeat(16)));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-fail"]').exists()).toBe(true);
    const cells = wrapper.findAll('[data-testid="speed-cell"]');
    expect(cells[0].text()).toBe('16.00');
    expect(wrapper.find('[data-testid="timeline-bar-0"].speeding').exists()).toBe(true);
  });

  it('临界 15 字/秒放行且时间轴无超速标记', async () => {
    const wrapper = setup(line('00:00:00.000', '00:00:01.000', '字'.repeat(15)));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-pass"]').exists()).toBe(true);
    expect(wrapper.find('.tl-bar.speeding').exists()).toBe(false);
  });

  it('时间轴标出全部重叠对（相等边界不重叠）', async () => {
    const wrapper = setup(
      [
        line('00:00:00.000', '00:00:02.000', '甲甲'),
        line('00:00:02.000', '00:00:04.000', '乙乙'), // 首尾相接，不重叠
        line('00:00:03.500', '00:00:06.000', '丙丙'), // 与乙重叠 0.5s
        line('00:00:05.000', '00:00:07.000', '丁丁'), // 与丙重叠 1s
      ].join('\n'),
    );
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.findAll('[data-testid="timeline-overlap-zone"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid^="overlap-item-"]')).toHaveLength(2);
    // 参与重叠的条目均有红框
    expect(wrapper.findAll('.tl-bar.overlapped')).toHaveLength(3);
  });

  it('格式错误整批拒绝；再次输入合法批次后旧错误清空', async () => {
    const wrapper = setup('不是合法行');
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="errors-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="verdict-pass"]').exists()).toBe(false);

    // 修正为合法批次
    const ta = wrapper.get('[data-testid="input-area"]').element as HTMLTextAreaElement;
    ta.value = line('00:00:00.000', '00:00:02.000', '合法字幕内容');
    ta.dispatchEvent(new Event('input'));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="errors-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="verdict-pass"]').exists()).toBe(true);
  });

  it('拒绝时展示唯一原因集合', async () => {
    const wrapper = setup(
      [
        line('00:00:00.000', '00:00:01.000', '超'.repeat(20)),
        line('00:00:00.500', '00:00:02.000', '重'),
      ].join('\n'),
    );
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    const badges = wrapper.findAll('.reason-badge');
    const texts = badges.map((b) => b.text());
    expect(texts).toHaveLength(new Set(texts).size);
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });

  it('下载按钮触发 JSON Blob 下载（不调用外部服务）', async () => {
    const wrapper = setup(line('00:00:00.000', '00:00:01.000', '字'.repeat(16)));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');

    const created: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      created.push((blob as Blob).type);
      return 'blob:mock-url';
    };
    URL.revokeObjectURL = () => {};

    let clicked = false;
    const anchorHandler = (e: Event) => {
      clicked = true;
      e.preventDefault();
    };
    document.addEventListener('click', anchorHandler);
    await wrapper.get('[data-testid="download-btn"]').trigger('click');
    document.removeEventListener('click', anchorHandler);

    expect(clicked).toBe(true);
    expect(created).toEqual(['application/json']);

    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  it('空输入裁决不显示放行或许可横幅，仅给中性提示', async () => {
    const wrapper = setup('   \n\n');
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-pass"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="verdict-fail"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="empty-hint"]').exists()).toBe(true);
  });

  it('清空按钮清除输入与旧判定', async () => {    const wrapper = setup(line('00:00:00.000', '00:00:01.000', '字'.repeat(16)));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-fail"]').exists()).toBe(true);
    await wrapper.get('[data-testid="clear-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="verdict-fail"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="input-area"]').element as HTMLTextAreaElement).value).toBe('');
  });

  it('合法非空批次显示预览控制，初始未开始且时钟位于首条开始时间', async () => {
    const wrapper = setup(
      [
        line('00:00:01.000', '00:00:02.000', '第一条字幕'),
        line('00:00:03.000', '00:00:05.000', '第二条字幕'),
      ].join('\n'),
    );
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="preview-toggle"]').text()).toBe('开始预览');
    expect(wrapper.find('[data-testid="preview-status"]').text()).toBe('未开始');
    expect(wrapper.find('[data-testid="preview-clock"]').text()).toBe('00:00:01.000');
    expect(wrapper.find('[data-testid="preview-scrubber"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="playhead"]').exists()).toBe(true);
    // 首条开始时刻命中第一条字幕
    expect(wrapper.find('[data-testid="preview-caption"]').text()).toBe('第一条字幕');
  });

  it('空批次不显示预览控制', async () => {
    const wrapper = setup('   \n\n');
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="empty-hint"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="preview-status"]').exists()).toBe(false);
  });

  it('重新裁决遇格式错误时移除旧预览控制', async () => {
    const wrapper = setup(line('00:00:00.000', '00:00:02.000', '合法字幕内容'));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(true);

    const ta = wrapper.get('[data-testid="input-area"]').element as HTMLTextAreaElement;
    ta.value = '不是合法行';
    ta.dispatchEvent(new Event('input'));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="errors-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="preview-status"]').exists()).toBe(false);
  });

  it('清空后预览控制一并移除', async () => {
    const wrapper = setup(line('00:00:00.000', '00:00:02.000', '合法字幕内容'));
    await wrapper.get('[data-testid="evaluate-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(true);
    await wrapper.get('[data-testid="clear-btn"]').trigger('click');
    expect(wrapper.find('[data-testid="preview-toggle"]').exists()).toBe(false);
  });
});
