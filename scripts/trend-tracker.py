# -*- coding: utf-8 -*-
"""
议题频次纵向追踪 · trend-tracker.py

用途：把每日「全量信息源」的标题层数据用起来，对比前后两天，输出议题频次变化、
      信息源量变、源的新增与消失。只读本地文件，不发起任何网络请求，不消耗模型调用。

数据来源优先级：
  1) data/snapshots/YYYY-MM-DD.json（由 --archive 生成的当日结构化快照，最可靠）
  2) Obsidian「每日情报」目录下 YYYY-MM-DD_全量信息源.md（回填用，解析表格条目）

用法：
  # 归档今天快照（每天情报生成前跑一次）
  python scripts/trend-tracker.py --archive

  # 对比今天 vs 昨天（默认）
  python scripts/trend-tracker.py

  # 指定日期
  python scripts/trend-tracker.py --today 2026-10-16 --prev 2026-10-15
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP_DIR = os.path.join(REPO, "data", "snapshots")
LATEST = os.path.join(REPO, "data", "latest-24h.json")
INTEL_DIR = r"E:\obsidian仓库\00 - 灵感库\每日情报"

# ---------------------------------------------------------------- 议题簇关键词
# 每个簇的关键词用 | 分隔，大小写不敏感。宁可少也不要错配——错配会让整张表失真。
CLUSTERS = {
    "A 模型与能力": r"大模型|LLM|GPT|Claude|Gemini|DeepSeek|Qwen|豆包|Kimi|Llama|多模态|推理模型|参数量|benchmark|跑分|模型",
    "B Agent与自动化": r"Agent|智能体|自动化|工作流|agentic|MCP|工具调用|编排|自主",
    "C 就业与能力": r"就业|取代|替代|岗位|失业|裁员|能力|技能|学习|认知|记忆|思考|判断力|思维|认知",
    "D 内容与创作": r"内容|创作|写作|视频|文案|slop|AI味|幻觉|真实性|版权|原创|博主|自媒体",
    "E 陪伴与情感": r"陪伴|情感|孤独|心理|抑郁|焦虑|亲密|关系|家庭|母亲|父亲|孩子|青少年|女性",
    "F 变现与商业": r"变现|收入|付费|订阅|会员|定价|商业|创业|副业|自由职业|产品|用户|增长|融资|亏损|破产|成本",
    "G 开源与生态": r"开源|GitHub|仓库|star|许可证|闭源|开发者|生态|代码",
    "H 监管与风险": r"监管|政策|法律|诉讼|起诉|合规|隐私|安全|风险|伦理|法案|治理",
    "I 乡村与在地": r"乡村|农村|县城|农民|返乡|宅基地|三农|乡镇|小城|家乡",
    "J 工具与应用": r"工具|应用|插件|上线|发布|版本|更新|内测|公测|APP|应用",
}

ITEM_RE = re.compile(r"^\d+\.\s*\[(?P<title>.+?)\]\((?P<url>[^)]+)\)\s*$")
SRC_RE = re.compile(r"-\s*来源：(?P<src>.+?)\s*\|")
# 「### 微信公众号（150条）」这类分组标题，用来还原 site（源口径校验要用）
SITE_RE = re.compile(r"^###\s+(?P<site>[^（(]+?)\s*(?:（|\()")


# ---------------------------------------------------------------- 数据装载
def load_from_json(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    items = data if isinstance(data, list) else (data.get("items") or [])
    out = []
    for it in items:
        title = (it.get("title") or "").strip()
        if not title:
            continue
        out.append({"title": title, "source": (it.get("source") or "").strip(),
                    "site": (it.get("site_name") or "").strip()})
    return out


def load_from_md(path):
    """从「YYYY-MM-DD_全量信息源.md」解析条目，回填历史用。"""
    if not os.path.exists(path):
        return []
    out = []
    pending_src = ""
    cur_site = ""
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            stripped = line.strip()
            m_site = SITE_RE.match(stripped)
            if m_site:
                cur_site = m_site.group("site").strip()
                continue
            m = ITEM_RE.match(stripped)
            if m:
                out.append({"title": m.group("title").strip(),
                            "source": pending_src, "site": cur_site})
                pending_src = ""
                continue
            m2 = SRC_RE.search(stripped)
            if m2 and out:
                out[-1]["source"] = m2.group("src").strip()
    return out


def load_day(day, prefer_json=True):
    """day 形如 2026-10-16。优先结构化快照，回落到情报 md。"""
    if prefer_json:
        items = load_from_json(os.path.join(SNAP_DIR, f"{day}.json"))
        if items:
            return items, "json 快照"
    md = os.path.join(INTEL_DIR, f"{day}_全量信息源.md")
    items = load_from_md(md)
    if items:
        return items, "情报 md 回填"
    return [], "无数据"


def archive(day):
    items = load_from_json(LATEST)
    if not items:
        print(f"[skip] {LATEST} 读不到条目，未归档", file=sys.stderr)
        return
    os.makedirs(SNAP_DIR, exist_ok=True)
    dest = os.path.join(SNAP_DIR, f"{day}.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False)
    print(f"[archive] {day} → {dest}（{len(items)} 条）")


# ---------------------------------------------------------------- 统计
def count_clusters(items):
    hits = defaultdict(int)
    for name, pat in CLUSTERS.items():
        rx = re.compile(pat, re.I)
        for it in items:
            if rx.search(it["title"]):
                hits[name] += 1
    return hits


def shift(cur, prev):
    """给变化幅度定档，避免只看绝对值。"""
    if prev == 0:
        return "🆕 新出现" if cur > 0 else "—"
    delta = cur - prev
    ratio = delta / prev
    if ratio >= 0.5:
        return "🔥 强升"
    if ratio >= 0.2:
        return "↑ 升"
    if ratio > -0.2:
        return "— 持平"
    if ratio > -0.5:
        return "↓ 降"
    return "🧊 强降"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--today")
    ap.add_argument("--prev")
    ap.add_argument("--archive", action="store_true", help="把 latest-24h.json 存成当日快照")
    args = ap.parse_args()

    today = args.today
    if not today:
        with open(LATEST, encoding="utf-8") as f:
            d = json.load(f)
        items_now = d if isinstance(d, list) else (d.get("items") or [])
        today = (items_now[0].get("first_seen_at", "")[:10] if items_now else "")
    if args.archive:
        archive(today)

    dt = today
    dp = args.prev
    if not dp:
        import datetime
        dp = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()

    cur, cur_origin = load_day(dt)
    prev, prev_origin = load_day(dp)

    print(f"# 议题频次纵向追踪 · {dt} vs {dp}")
    print(f"\n- 当日条目：**{len(cur)}**（来源：{cur_origin}）")
    print(f"- 前日条目：**{len(prev)}**（来源：{prev_origin}）")
    if not cur or not prev:
        print("\n⚠️ 任一侧无数据，无法对比。")
        return

    # ---- 校验位：站点数/源数不一致时，频次对比会失真，必须提示
    cur_sites = len({i["site"] for i in cur if i["site"]})
    prev_sites = len({i["site"] for i in prev if i["site"]})
    cur_srcs = len({i["source"] for i in cur if i["source"]})
    prev_srcs = len({i["source"] for i in prev if i["source"]})
    warn = []
    if cur_sites and prev_sites and cur_sites != prev_sites:
        warn.append(f"站点数变化（{prev_sites} → {cur_sites}）")
    if cur_srcs and prev_srcs and cur_srcs != prev_srcs:
        warn.append(f"信息源数变化（{prev_srcs} → {cur_srcs}）")
    if warn:
        print(f"\n⚠️ **源口径校验：{'；'.join(warn)}——下表变化可能来自源增减，不完全是话题冷热。**")
    else:
        print(f"\n✅ 源口径校验：站点 {cur_sites}/{prev_sites}、信息源 {cur_srcs}/{prev_srcs}，口径一致，频次可比。")

    # ---- 表1 议题簇
    ch, ph = count_clusters(cur), count_clusters(prev)
    print("\n## 📊 议题簇频次变化")
    print("\n| 议题簇 | 前日 | 当日 | 变化 | 占比（前→当） |")
    print("|---|---:|---:|---|---|")
    rows = []
    for name in CLUSTERS:
        c, p = ch.get(name, 0), ph.get(name, 0)
        rows.append((c - p, name, p, c, p * 100 // max(len(prev), 1), c * 100 // max(len(cur), 1)))
    for delta, name, p, c, pp, cc in sorted(rows, reverse=True):
        print(f"| {name} | {p} | {c} | {shift(c, p)} | {pp}% → {cc}% |")

    # ---- 表2 source 量变
    cs = Counter(i["source"] for i in cur if i["source"])
    ps = Counter(i["source"] for i in prev if i["source"])
    print("\n## 📡 信息源量变（当日增量 Top 12）")
    print("\n| 信息源 | 前日 | 当日 | 变化 |")
    print("|---|---:|---:|---|")
    deltas = sorted(((cs[k] - ps.get(k, 0), k, ps.get(k, 0), cs[k]) for k in cs), reverse=True)
    for delta, k, p, c in deltas[:12]:
        if delta <= 0:
            break
        print(f"| {k} | {p} | {c} | ↑{delta} |")

    print("\n## 🧊 信息源量减（当日降幅 Top 8）")
    print("\n> ⚠️ **量减不等于信号**。公众号/新闻号本来就按天波动（今天发 1 条、明天发 37 条是常态）。")
    print("> 只有「降幅 > 60% 且绝对减少 ≥ 15 条」才可能是停更或抓取故障，其余按正常波动看待。")
    print("\n| 信息源 | 前日 | 当日 | 变化 | 判读 |")
    print("|---|---:|---:|---|---|")
    downs = sorted(((ps[k] - cs.get(k, 0), k, ps[k], cs.get(k, 0)) for k in ps), reverse=True)
    shown = 0
    for delta, k, p, c in downs:
        if delta <= 0 or shown >= 8:
            break
        ratio = delta / p if p else 0
        verdict = "⚠️ **疑似停更/故障**" if (ratio > 0.6 and delta >= 15) else "正常波动"
        print(f"| {k} | {p} | {c} | ↓{delta} | {verdict} |")
        shown += 1

    # ---- 表3 源的新增与消失
    new_srcs = [k for k in cs if k not in ps]
    gone_srcs = [k for k in ps if k not in cs]
    print(f"\n## 🔄 源的新增与消失")
    print(f"\n- **新增源 {len(new_srcs)} 个**：{'、'.join(new_srcs[:15]) if new_srcs else '无'}")
    print(f"- **消失源 {len(gone_srcs)} 个**：{'、'.join(gone_srcs[:15]) if gone_srcs else '无'}")
    if gone_srcs:
        print(f"\n⚠️ 消失 {len(gone_srcs)} 个源值得看一眼——**话题消失比新话题出现信息量大**（记得判断是停更还是退潮）。")

    print(f"\n---\n生成：trend-tracker.py · {dt}")


if __name__ == "__main__":
    main()
