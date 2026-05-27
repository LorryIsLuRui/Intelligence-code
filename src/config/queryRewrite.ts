/**
 * queryRewrite.ts — query 预处理配置：噪音词清洗 + 同义词/别名扩展。
 *
 * 用于 buildQueryVariants，通过消除口语化干扰词和补充同义词变体，
 * 提升语义检索的 recall（尤其是中英混用、别名查询场景）。
 */

// ─── 噪音词清洗正则（从 recommendationService 迁移） ────────────────────────

/**
 * 依次对原始 query 做替换，去掉无实际语义的口语词。
 * 注意：每个 pattern 带 /g 标志，替换后产生多余空格由调用方合并。
 */
export const NOISE_PATTERNS: RegExp[] = [
    /^帮我找(找)?(一个|一下)?/g,
    /^有没有(现成的)?/g,
    /^请推荐(一个|一下)?/g,
    /可复用/g,
    /现成的/g,
    /封装好的/g,
    /(组件|函数|hook|工具|util)(实现)?/gi,
];

// ─── 同义词/别名字典 ─────────────────────────────────────────────────────────

/**
 * 每个 key 为一组同义词的首选英文词根，value 为同一概念的其他表达形式（中文、缩写、别名）。
 *
 * 匹配规则：任意一项（key 或 value 中的词）出现在 query 里即视为命中，
 * 然后取组内第一个当前 query 中未出现的词作为替代词，生成同义扩展变体。
 *
 * 新增规则：key 使用最短、最通用的英文词根；中文词放在 value 数组最前。
 */
export const SYNONYM_MAP: Record<string, string[]> = {
    // 表单输入
    input: ['输入框', '输入', 'textfield', 'textinput'],
    textarea: ['文本域', '多行输入', 'multiline'],
    select: ['选择器', '下拉框', '下拉', 'dropdown'],
    checkbox: ['复选框', '勾选'],
    radio: ['单选框', '单选'],
    // 弹层
    dialog: ['弹窗', '弹框', '对话框', 'modal', 'popup'],
    tooltip: ['提示', '气泡提示', '悬浮提示', 'popover'],
    drawer: ['抽屉', '侧边栏', 'sidebar'],
    // 反馈
    loading: ['加载', '加载中', 'spinner'],
    skeleton: ['骨架屏', '占位图', 'placeholder'],
    notification: ['通知', '消息', '提醒', 'toast'],
    alert: ['警告', '警示', '提示框'],
    // 数据展示
    table: ['表格'],
    list: ['列表'],
    pagination: ['分页', '翻页', 'pager'],
    tabs: ['标签页', '选项卡', 'tab'],
    badge: ['徽标', '角标', '标记'],
    tag: ['标签', 'chip'],
    // 导航
    navigation: ['导航', 'nav'],
    menu: ['菜单'],
    breadcrumb: ['面包屑'],
    // 媒体/布局
    carousel: ['轮播', '走马灯', 'slider', 'swiper'],
    upload: ['上传', '文件上传', 'file upload'],
    image: ['图片', '图像', 'img'],
    // 常用 Hook
    debounce: ['防抖', '去抖', 'usedebounce'],
    throttle: ['节流', 'usethrottle'],
    // 搜索
    search: ['搜索', '查询', 'filter'],
    // 按钮
    button: ['按钮', 'btn'],
};

// ─── 同义词扩展函数 ──────────────────────────────────────────────────────────

/**
 * 在 query 中查找 SYNONYM_MAP 里命中的词，替换成同组内一个当前未出现的词，
 * 生成同义扩展变体。若未命中任何同义词则返回 null。
 *
 * @example
 * buildSynonymVariant('弹窗 onChange') // => 'dialog onChange'
 * buildSynonymVariant('input onChange') // => '输入框 onChange'
 */
export function buildSynonymVariant(query: string): string | null {
    const lower = query.toLowerCase();

    for (const [canonical, aliases] of Object.entries(SYNONYM_MAP)) {
        const allTerms = [canonical, ...aliases];
        const matchedTerm = allTerms.find((t) =>
            lower.includes(t.toLowerCase())
        );
        if (!matchedTerm) continue;

        const substitute = allTerms.find(
            (t) => !lower.includes(t.toLowerCase()) && t !== matchedTerm
        );
        if (!substitute) continue;

        // 大小写不敏感替换
        const replaced = query.replace(
            new RegExp(
                matchedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                'gi'
            ),
            substitute
        );
        const trimmed = replaced.replace(/\s+/g, ' ').trim();
        if (trimmed && trimmed !== query) return trimmed;
    }

    return null;
}
