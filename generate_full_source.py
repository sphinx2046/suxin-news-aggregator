#!/usr/bin/env python3
"""
generate_full_source.py —— 生成每日情报的「全量信息源」文件

合并两个来源：
  1. data/latest-24h.json     —— GitHub Actions 每 2 小时抓的底座（750 条左右）
  2. data/aihot-latest.json   —— AI今日热榜本地补抓（CI 抓不到，见 scripts/fetch-aihot.mjs）
                                 带中文摘要，是底座里唯一有"中文正文"的来源

2026-10-16 改版（修了两个隐患）：
  - **日期自动取当天**，不再硬编码。此前脚本里日期是写死的，忘了改就会用昨天的数据
    覆盖昨天的文件（10/16 早晨发生过一次，丢了 10-15 的原快照）。
  - 带摘要的条目会输出一行「📎 摘要」，情报生成时可先看摘要判断相关性，
    只对真正要引用的做 WebFetch —— 这是省积分的正确姿势（该省的是无目的的抓）。

用法：python generate_full_source.py [YYYY-MM-DD]
"""
import datetime
import json
import os
import sys
from collections import defaultdict

REPO = os.path.dirname(os.path.abspath(__file__))
LATEST = os.path.join(REPO, 'data', 'latest-24h.json')
AIHOT = os.path.join(REPO, 'data', 'aihot-latest.json')
OUT_DIR = r'E:\obsidian仓库\00 - 灵感库\每日情报'
SUMMARY_CHARS = 80


def load_today(day):
    """返回 (items, generated_at, base_stats, aihot_meta)"""
    items, generated_at = [], ''
    base_stats = {}
    if os.path.exists(LATEST):
        with open(LATEST, encoding='utf-8') as f:
            data = json.load(f)
        items = data.get('items', [])
        generated_at = data.get('generated_at', '')
        base_stats = {
            'total_raw': data.get('total_items_raw', 0),
            'total': data.get('total_items', len(items)),
            'site_count': data.get('site_count', 0),
            'source_count': data.get('source_count', 0),
            'site_stats': data.get('site_stats', []),
        }

    aihot_meta = None
    if os.path.exists(AIHOT):
        with open(AIHOT, encoding='utf-8') as f:
            a = json.load(f)
        aihot_meta = {
            'generated_at': a.get('generated_at', ''),
            'total_raw': a.get('total_raw', 0),
            'total_kept': a.get('total_kept', 0),
        }
        items = list(items) + list(a.get('items', []))
    return items, generated_at, base_stats, aihot_meta


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat()
    out_path = os.path.join(OUT_DIR, f'{day}_全量信息源.md')
    os.makedirs(OUT_DIR, exist_ok=True)

    items, generated_at, base, aihot_meta = load_today(day)
    if not items:
        print(f'[FAIL] 没有可用条目：{LATEST} 不存在或为空。先跑 git pull。')
        sys.exit(1)

    by_site = defaultdict(list)
    for it in items:
        by_site[it.get('site_name', '其他')].append(it)

    total_all = len(items)
    raw_all = base.get('total_raw', 0) + (aihot_meta['total_raw'] if aihot_meta else 0)
    site_count = len(by_site)
    source_count = len({it.get('source', '') for it in items if it.get('source')})

    md = []
    md.append(f'# 刘夏说 · 数据底座全量信息源 · {day}\n')
    md.append(f'> 原始抓取：{raw_all} 条 → 筛选后：{total_all} 条')
    md.append(f'> 聚合时间：{generated_at or "(未标注)"}')
    md.append(f'> 覆盖站点：{site_count} 个 | 信息源：{source_count} 个')
    if aihot_meta:
        md.append(f'> 补充：AI今日热榜本地补抓 {aihot_meta["total_kept"]} 条（带中文摘要，'
                  f'CI 抓不到该源）')
    md.append('\n---\n')

    md.append('## 📊 站点统计\n')
    md.append('| 站点 | 筛选后条目数 | 备注 |')
    md.append('|------|------------|------|')
    rows = []
    for s in base.get('site_stats', []):
        rows.append((s.get('count', 0), s.get('site_name', ''),
                     f"原始 {s.get('raw_count', 0)} 条"))
    extra = [(len(v), k, '**本地补抓 · 带中文摘要**')
             for k, v in by_site.items()
             if k not in {r[1] for r in rows}]
    for cnt, site, note in sorted(rows + extra, key=lambda x: -x[0]):
        md.append(f'| {site} | {cnt} | {note} |')

    md.append('\n---\n')
    md.append('## 📋 全部条目（按站点分组）\n')
    md.append('> 有「📎 摘要」的行说明该条**带中文正文**，判断相关性时可先看摘要，'
              '不必直接 WebFetch。\n')

    for site_name, arr in sorted(by_site.items(), key=lambda x: -len(x[1])):
        md.append(f'### {site_name}（{len(arr)}条）\n')
        for idx, item in enumerate(arr, 1):
            title = (item.get('title_bilingual') or item.get('title_zh')
                     or item.get('title_original') or item.get('title') or '(无标题)')
            title = title.replace('|', '｜')
            url = item.get('url', '')
            source = item.get('source', '')
            pub = (item.get('published_at') or '')[:10] or '未知'
            md.append(f'{idx}. [{title}]({url})')
            md.append(f'   - 来源：{source} | 发布：{pub}')
            summary = (item.get('summary') or '').strip()
            if summary:
                short = summary[:SUMMARY_CHARS] + ('…' if len(summary) > SUMMARY_CHARS else '')
                md.append(f'   - 📎 摘要：{short}')

    md.append('\n---\n')
    md.append(f'> 由 suxin-news-aggregator 自动生成 | 聚合时间：{generated_at or "-"}')

    content = '\n'.join(md)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(content)

    with_summary = sum(1 for it in items if (it.get('summary') or '').strip())
    print(f'Written: {out_path}')
    print(f'总条目 {total_all}（底座 {len(items) - (aihot_meta["total_kept"] if aihot_meta else 0)}'
          f' + aihot 补抓 {aihot_meta["total_kept"] if aihot_meta else 0}）')
    print(f'带摘要 {with_summary} 条 | 站点 {site_count} 个 | 信息源 {source_count} 个')
    print(f'字符数 {len(content)}')


if __name__ == '__main__':
    main()
