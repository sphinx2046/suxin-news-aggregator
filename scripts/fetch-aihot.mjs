/**
 * fetch-aihot.mjs —— AI今日热榜（aihot.today）本地补抓
 *
 * 为什么要补抓：GitHub Actions 跑在美国机房，抓 aihot.today 只耗时 79ms 就返回空内容
 * （其他源 1289-4945ms），机房 IP 被拒。本地是国内 IP，能正常抓到。
 * 这个脚本在每日情报生成时（本地执行）运行，产出 data/aihot-latest.json，
 * 由 generate_full_source.py 合并进当天的全量信息源文件。
 *
 * ⚠️ 关键价值：aihot 每条都带 **中文摘要**（des_trans）。底座里 693/750 条没有正文
 *    （summary 填充率仅 7.6%，且全在 OPML RSS 上），这个源是唯一能补上"中文源无正文"
 *    这个洞的来源 —— 有了摘要，判断相关性与否不必 WebFetch。
 *
 * 过滤逻辑：直接读 src/config.ts 里的关键词组，避免与 CI 底座产生两份关键词配置。
 *
 * 用法：node scripts/fetch-aihot.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'aihot-latest.json');
const CFG = path.join(ROOT, 'src', 'config.ts');
const SOURCE_URL = 'https://aihot.today/';
const SITE_NAME = 'AI今日热榜（本地补抓）';

// ------------------------------------------------------------------ 读 config.ts 的关键词
function grab(name) {
  const cfg = fs.readFileSync(CFG, 'utf8');
  const i = cfg.indexOf(`${name}: [`);
  if (i === -1) return [];
  const start = cfg.indexOf('[', i);
  const end = cfg.indexOf(']', start);
  return [...cfg.slice(start + 1, end).matchAll(/'([^']*)'/g)].map((m) => m[1]);
}
const RELEVANT = [
  ...grab('aiKeywords'), ...grab('techKeywords'), ...grab('cognitionKeywords'),
  ...grab('ipKeywords'), ...grab('monetizeKeywords'), ...grab('ruralKeywords'),
  ...grab('emotionKeywords'), ...grab('humanitiesKeywords'),
].map((w) => w.toLowerCase()).filter(Boolean);
const NOISE = [...grab('noiseKeywords'), ...grab('commerceNoiseKeywords')]
  .map((w) => w.toLowerCase()).filter(Boolean);

// ------------------------------------------------------------------ 解析 Next.js 数据流
function extractNextFMerged(html) {
  const chunks = html.match(/self\.__next_f\.push\(\[1,"(.*?)"\]\)<\/script>/gs) || [];
  const merged = chunks
    .map((c) => (c.match(/self\.__next_f\.push\(\[1,"(.*?)"\]\)<\/script>/s) || [, ''])[1])
    .join('');
  try { return JSON.parse(`"${merged}"`); }
  catch { return merged.replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}

function extractBalancedJson(decoded, key) {
  const idx = decoded.indexOf(key);
  if (idx === -1) throw new Error(`Key not found: ${key}`);
  let start = idx + key.length;
  while (start < decoded.length && decoded[start] !== ':') start++;
  start++;
  while (start < decoded.length && !['{', '['].includes(decoded[start])) start++;
  const openCh = decoded[start];
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false, end = null;
  for (let i = start; i < decoded.length; i++) {
    const ch = decoded[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === null) throw new Error(`Cannot parse JSON for key: ${key}`);
  return JSON.parse(decoded.slice(start, end).replace(/\$undefined/g, 'null').replace(/"\$D([^"]+)"/g, '"$1"'));
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ 主流程
const res = await fetch(SOURCE_URL, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } });
if (!res.ok) {
  console.error(`[FAIL] aihot.today HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();
const decoded = extractNextFMerged(html);
const initialDataMap = extractBalancedJson(decoded, 'initialDataMap');
const dataSources = extractBalancedJson(decoded, 'dataSources');
const srcMap = new Map(dataSources.map((s) => [String(s.id), s.title || String(s.id)]));

const items = [];
let total = 0, noiseDropped = 0, irrelevant = 0;
const seen = new Set();

for (const [sid, arr] of Object.entries(initialDataMap)) {
  if (!Array.isArray(arr)) continue;
  const source = srcMap.get(sid) || sid;
  for (const it of arr) {
    total++;
    const link = cleanText(it.link);
    const titleOrig = cleanText(it.title);
    const titleZh = cleanText(it.title_trans);
    if (!link || (!titleOrig && !titleZh)) continue;

    // 中文摘要就是我们要的"正文"——底座里 92.4% 的条目没有它
    const summary = cleanText(it.des_trans) || cleanText(it.des);

    const hay = `${titleOrig} ${titleZh} ${cleanText(it.des)} ${summary}`.toLowerCase();
    if (NOISE.some((w) => hay.includes(w))) { noiseDropped++; continue; }
    if (!RELEVANT.some((w) => hay.includes(w))) { irrelevant++; continue; }
    if (seen.has(link)) continue;
    seen.add(link);

    items.push({
      title_bilingual: titleZh && titleOrig ? `${titleZh} / ${titleOrig}` : (titleZh || titleOrig),
      url: link,
      source,
      published_at: it.publish_time || null,
      site_name: SITE_NAME,
      summary, // ← 这个字段是本脚本存在的核心理由
    });
  }
}

const payload = {
  generated_at: new Date().toISOString(),
  source_url: SOURCE_URL,
  note: 'GitHub Actions 抓不到本源（机房 IP 被拒，79ms 返回空），此文件由本地 scripts/fetch-aihot.mjs 生成',
  total_raw: total,
  total_kept: items.length,
  noise_dropped: noiseDropped,
  irrelevant_dropped: irrelevant,
  items,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 0), 'utf8');

console.log(`[aihot] 原始 ${total} → 留存 ${items.length}（剔除噪音 ${noiseDropped} / 不相关 ${irrelevant}）`);
console.log(`[aihot] 带中文摘要 ${items.filter((i) => i.summary).length} 条 → ${OUT}`);
