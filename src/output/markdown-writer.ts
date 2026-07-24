/**
 * JSON → Markdown 转换器
 * 读取 latest-24h.json，按素心拾穗六模块分类，生成 Markdown
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import type { ArchiveItem, LatestPayload } from '../types.js';
import { getSuxinCategory } from '../filters/ai-related.js';

// ====== 模块分类逻辑 ======

interface ClassifiedItem {
  title: string;
  url: string;
  source: string;
  categories: string[];
}

/** 严格新闻模式：标题核心就是说"有人做了XX事" */
function looksLikeNews(title: string): boolean {
  const strongNews = [
    '发布', '推出', '上线', '开源', '宣布', '正式',
    '融资', '收购', '上市',
    'launch', 'release', 'announce', 'unveil',
    'shipped', 'raises', 'raised',
  ];
  const weakNews = [
    '更新', '升级', '突破', '新功能', '新版', '最新',
    '突然', '终于', '来了', '曝光',
    'update', 'new model', 'new version', 'now available',
  ];
  const t = title.toLowerCase();
  // 强信号直接判定为新闻
  if (strongNews.some((p) => t.includes(p))) return true;
  // 弱信号 + AI关键词 → 可能是新闻
  if (weakNews.some((p) => t.includes(p)) && 
      (t.includes('ai') || t.includes('模型') || t.includes('model') || t.includes('gpt') || t.includes('claude'))) return true;
  return false;
}

/** 实践/方法类判断 */
function looksLikePractice(title: string): boolean {
  const patterns = [
    '怎么用', '如何用', '实操', '实战', '案例', '教程',
    '方法', '技巧', '分享', '我用', '试试', '试了',
    '经验', '踩坑', '避坑', '指南', '攻略',
    'how to', 'tutorial', 'guide', 'workflow', 'build',
    '手把手', '零基础', '保姆级',
  ];
  const t = title.toLowerCase();
  return patterns.some((p) => t.includes(p));
}

/** 深度洞见判断：不是新闻也不是实践，但包含概念/分析/趋势 */
function looksLikeInsight(title: string): boolean {
  const patterns = [
    '为什么', '如何理解', '本质', '悖论', '底层', '核心',
    '逻辑', '反思', '思考', '趋势', '未来', '启示',
    '深度', '分析', '解读', '洞见',
    'why', 'how', 'paradox', 'insight', 'deep dive',
  ];
  const t = title.toLowerCase();
  return patterns.some((p) => t.includes(p));
}

/** 按模块分组 */
function classifyIntoModules(items: ClassifiedItem[]): Record<string, ClassifiedItem[]> {
  const modules: Record<string, ClassifiedItem[]> = {
    '认知弹药': [],
    'AI实战情报': [],
    'AI界动态': [],
    '同行拆解': [],
    '变现雷达': [],
  };

  for (const item of items) {
    const cats = item.categories;
    const title = item.title;

    // 1. AI界动态：AI/技术类 + 新闻发布性质
    if ((cats.includes('AI') || cats.includes('认知')) && looksLikeNews(title)) {
      modules['AI界动态'].push(item);
      continue;
    }

    // 2. AI实战情报：AI + 实践/教程性质
    if (cats.includes('AI') && looksLikePractice(title)) {
      modules['AI实战情报'].push(item);
      continue;
    }

    // 3. 变现雷达：变现类
    if (cats.includes('变现')) {
      modules['变现雷达'].push(item);
      continue;
    }

    // 4. 同行拆解：IP/回乡类
    if (cats.includes('IP') || cats.includes('回乡')) {
      modules['同行拆解'].push(item);
      continue;
    }

    // 5. 认知弹药：认知类 或 有深度洞见的AI内容
    if (cats.includes('认知') || looksLikeInsight(title)) {
      modules['认知弹药'].push(item);
      continue;
    }

    // 6. 剩余AI内容也进认知弹药（但要控制数量）
    if (cats.includes('AI')) {
      modules['认知弹药'].push(item);
      continue;
    }

    // 兜底
    modules['认知弹药'].push(item);
  }

  // 认知弹药只保留 TOP 最多15条（避免信息过载）
  if (modules['认知弹药'].length > 15) {
    modules['认知弹药'] = modules['认知弹药'].slice(0, 15);
  }

  return modules;
}

/** 去重：标题相似度 > 0.7 的只保留一个 */
function dedupeByTitle(items: ClassifiedItem[]): ClassifiedItem[] {
  const seen = new Set<string>();
  const result: ClassifiedItem[] = [];

  for (const item of items) {
    // 取标题前30字符做去重键
    const key = item.title.slice(0, 30).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

/** 生成模块 Markdown 表格 */
function renderModuleTable(
  moduleName: string,
  items: ClassifiedItem[],
  icon: string,
  maxRows: number = 5
): string {
  if (items.length === 0) {
    return `## ${icon} ${moduleName}\n\n> 今日无优质信息源，待补充。\n`;
  }

  const display = items.slice(0, maxRows);
  let md = `## ${icon} ${moduleName}\n\n`;
  md += '| # | 标题 | 来源 | 分类 |\n';
  md += '|---|------|------|------|\n';

  for (let i = 0; i < display.length; i++) {
    const item = display[i];
    const cats = item.categories.join('/');
    md += `| ${i + 1} | [${item.title}](${item.url}) | ${item.source} | ${cats} |\n`;
  }

  if (items.length > maxRows) {
    md += `\n> 共 ${items.length} 条，以上为 TOP ${maxRows}。\n`;
  }

  return md;
}

/** 生成完整 Markdown */
function generateMarkdown(
  modules: Record<string, ClassifiedItem[]>,
  payload: LatestPayload
): string {
  const today = new Date().toISOString().slice(0, 10);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekday = weekdays[new Date().getDay()];

  let md = '';
  md += `# 素心拾穗 · 每日情报 · ${today}（周${weekday}）\n\n`;
  md += '> 主攻：素心拾穗（践行记录） | 辅：路边放映日记 | 素心观禅暂停\n\n';
  md += '> 📡 数据底座：suxin-news-aggregator（公众号52个 + RSS 70+源 自动聚合）\n\n';
  md += '---\n\n';

  // 各模块
  const moduleIcons: Record<string, string> = {
    '认知弹药': '🧠',
    'AI实战情报': '🤖',
    'AI界动态': '📡',
    '同行拆解': '🔍',
    '变现雷达': '💰',
  };

  const moduleOrder = ['认知弹药', 'AI实战情报', 'AI界动态', '同行拆解', '变现雷达'];

  for (const mod of moduleOrder) {
    md += renderModuleTable(mod, modules[mod] || [], moduleIcons[mod] || '📌');
    md += '\n---\n\n';
  }

  // 姜胡说追踪（标注需手动补充）
  md += '## 🎯 姜胡说追踪\n\n';
  md += '> ⚠️ 此模块需每日自动化补充 WebSearch/公众号搜索结果。RSS 聚合不包含姜胡说内容。\n\n';

  // 数据统计
  md += '---\n\n';
  md += '## 📊 数据底座统计\n\n';
  md += `- **聚合时间**：${payload.generated_at}\n`;
  md += `- **总资讯数**：${payload.total_items_raw} 条原始 → ${payload.total_items} 条筛选后\n`;
  md += `- **覆盖站点**：${payload.site_count} 个来源\n`;
  md += `- **筛选主题**：AI/科技/认知/IP/变现/回乡\n\n`;
  md += `> 由 suxin-news-aggregator 自动生成，每日 08:00 补充人工精选内容后发布。\n`;

  return md;
}

// ====== 主函数 ======

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputDir = args[0] || 'data';
  const jsonPath = join(outputDir, 'latest-24h.json');
  const mdPath = join(outputDir, 'daily-briefing.md');

  if (!existsSync(jsonPath)) {
    console.error(`❌ JSON 文件不存在: ${jsonPath}`);
    console.error('   请先运行 pnpm run fetch');
    process.exit(1);
  }

  console.log(`📖 读取 ${jsonPath}...`);
  const raw = await readFile(jsonPath, 'utf-8');
  const payload: LatestPayload = JSON.parse(raw);

  console.log(`   共 ${payload.total_items} 条资讯`);

  // 分类
  const classified: ClassifiedItem[] = [];
  for (const item of payload.items) {
    const categories = getSuxinCategory(item);
    classified.push({
      title: item.title_bilingual || item.title_zh || item.title,
      url: item.url,
      source: item.source || item.site_name,
      categories,
    });
  }

  // 去重
  const deduped = dedupeByTitle(classified);
  console.log(`   去重后 ${deduped.length} 条`);

  // 入模块
  const modules = classifyIntoModules(deduped);

  // 各模块再内部去重
  for (const key of Object.keys(modules)) {
    modules[key] = dedupeByTitle(modules[key]);
    console.log(`   ${key}: ${modules[key].length} 条`);
  }

  // 生成 Markdown
  const md = generateMarkdown(modules, payload);

  await writeFile(mdPath, md, 'utf-8');
  console.log(`✅ 已生成 ${mdPath}`);
  console.log(`   ${md.split('\n').length} 行`);
}

main().catch((err) => {
  console.error('❌ 转换失败:', err);
  process.exit(1);
});
