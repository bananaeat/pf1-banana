"""pf1-banana 资料浏览器的数据：从 PFWiki 离线导出（pf1-zh-wiki-data）生成列表文件和详情分片。

用法：python tools/build_data.py [pf1-zh-wiki-data 目录]（也可用环境变量 PFWIKI_DATA）
输出 data/：
  meta.json            版本号 + 各分页的分片数（页面用版本号做缓存键）
  <tab>.json           列表（筛选字段），每行带 d = 详情分片号
  d/<tab>-<n>.json     详情 HTML：{页名: html}
  pages.json           全部页名 → 分页（详情里的链接跳转用；重定向已解析）
数据来源：开拓者1版中文维基 https://pf1.huijiwiki.com（CC BY-SA 4.0），社区译者整理。
"""
import html
import json
import os
import re
import sys
import time
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PFWIKI_DATA", "E:/PF/PFWiki/release/pf1-zh-wiki-data"))
OUT = Path(__file__).resolve().parent.parent / "data"
SHARD_BYTES = 350_000

def tables(name):
    # 表里有的页名带 HTML 实体（「&#14751;泽郎」），先还原
    rows = json.loads((SRC / "data/tables" / f"{name}.json").read_text("utf-8"))
    return [{k: html.unescape(v) if isinstance(v, str) else v for k, v in r.items()} for r in rows]



entries = lambda name: json.loads((SRC / "data/entries" / f"{name}.json").read_text("utf-8"))
redirects = json.loads((SRC / "wikitext/redirects.json").read_text("utf-8"))


def split(s, seps="、;；,，|"):
    return [x.strip() for x in re.split(f"[{re.escape(seps)}]", s or "") if x.strip()]


# ---------- 维基标记 → HTML ----------
def resolve(page):
    seen = set()
    while page in redirects and page not in seen:
        seen.add(page)
        page = redirects[page].split("|")[0].split("#")[0].strip()
    return page


def link(m):
    target, _, label = m.group(1).partition("|")
    target = target.strip()
    if re.match(r"^(文件|File|分类|Category|图像|Image):", target, re.I):
        return ""
    page = resolve(target.split("#")[0])
    return f'<a class="dd-wl" data-p="{html.escape(page, quote=True)}">{label or target}</a>'


def wiki(raw, text):
    """raw 能转就转（保留链接），有模板/表格就用 text（纯文本）。"""
    raw = raw or ""
    if not raw.strip() and not (text or "").strip():
        return ""
    if "{{" in raw or "{|" in raw or "<ref" in raw or not raw.strip():
        s = html.escape(text or "")
    else:
        s = html.escape(raw, quote=False)
        s = re.sub(r"&lt;br\s*/?&gt;", "\n", s)
        s = re.sub(r"\[\[([^\[\]]+)\]\]", link, s)
        s = re.sub(r"'''(.+?)'''", r"<b>\1</b>", s)
        s = re.sub(r"''(.+?)''", r"<i>\1</i>", s)
        s = re.sub(r"^\*+\s*", "• ", s, flags=re.M)
        s = re.sub(r"^=+\s*(.+?)\s*=+\s*$", r"<b>\1</b>", s, flags=re.M)
    paras = [p.strip() for p in re.split(r"\n\s*\n", s) if p.strip()]
    return "".join(f"<p>{p.replace(chr(10), '<br>')}</p>" for p in paras)


def fields(entry, spec):
    """spec: [(字段, 标签)]，有值的拼成「标签 值」行。"""
    raw, text = entry.get("raw", {}), entry.get("text", {})
    out = []
    for key, label in spec:
        v = text.get(key)
        if not v or v in ("—", "-"):
            continue
        r = raw.get(key, "")
        body = wiki(r, v)
        body = body[3:-4] if body.startswith("<p>") and body.count("<p>") == 1 else body
        out.append(f"<div class=\"dd-f\"><b>{label}</b> {body}</div>")
    return "".join(out)


def section(entry, key, label=None):
    raw, text = entry.get("raw", {}), entry.get("text", {})
    body = wiki(raw.get(key, ""), text.get(key, ""))
    if not body:
        return ""
    return (f"<h4>{label}</h4>" if label else "") + body


def by_title(*names):
    d = {}
    for n in names:
        for e in entries(n):
            d.setdefault(e["title"], e)
    return d


# ---------- 数值解析 ----------
def price_gp(s):
    s = (s or "").replace(",", "").replace("，", "")
    m = re.search(r"(\d+(?:\.\d+)?)\s*(gp|GP|金币|sp|SP|银币|cp|CP|铜币|pp|PP)", s)
    if not m:
        return None
    v, u = float(m.group(1)), m.group(2).lower()
    return v * {"gp": 1, "金币": 1, "sp": 0.1, "银币": 0.1, "cp": 0.01, "铜币": 0.01, "pp": 10}[u]


def to_int(s):
    m = re.search(r"\d+", s or "")
    return int(m.group()) if m else None


def action_cat(a):
    for k, v in (("标准动作", "标准动作"), ("迅捷动作", "迅捷动作"), ("直觉动作", "直觉动作"), ("整轮动作", "整轮动作"), ("移动动作", "移动动作")):
        if a.startswith(k):
            return v
    if re.match(r"^\d+\s*轮", a):
        return "1轮以上"
    if "分钟" in a:
        return "分钟级"
    if "小时" in a:
        return "小时级"
    return "其他" if a else ""


COMPONENTS = {"语言": "语言", "姿势": "姿势", "材料": "材料", "器材": "器材", "神圣器材": "神圣器材", "思想": "思想", "情绪": "情绪"}


def components(c):
    out = set()
    for part in split(c, ";；,，"):
        head = re.split(r"[（(/]", part)[0].strip()
        if head in COMPONENTS:
            out.add(COMPONENTS[head])
        if head == "材料" and re.search(r"\d[\d,]*\s*(gp|金币)", part, re.I):
            out.add("昂贵材料")
        if "神圣器材" in part:
            out.add("神圣器材")
    return sorted(out)


def save_cat(s):
    out = [k for k in ("强韧", "反射", "意志") if k in s]
    if not out and (s.startswith("无") or not s):
        out = ["无"] if s.startswith("无") else []
    if "无害" in s:
        out.append("无害")
    return out


def sr_cat(s):
    return "是" if s.startswith("是") else "否" if s.startswith("否") else ("其他" if s else "")


def books(s):
    return split(s, "、;；,，")


AURA_SCHOOLS = ["防护", "咒法", "预言", "惑控", "塑能", "幻术", "死灵", "变化", "通用"]


# ---------- 各分页 ----------
def build_spells():
    ent = by_title("spells")
    rows, det = [], {}
    for r in tables("Spells"):
        cl = {}
        for part in split(r["classlv"], "、;；"):
            m = re.match(r"^(.+?)\s*(\d)$", part)
            if m:
                cl[m.group(1)] = int(m.group(2))
        doms = [re.sub(r"\s*\d$", "", d) for d in split(r["domlv"], "、;；")]
        rows.append({
            "p": r["page"], "n": r["name"], "e": r["en"], "sc": r["school"], "ss": r["sub"],
            "t": split(r["tags"], "、;；,，"), "cl": cl, "lv": r["lvmin"],
            "a": action_cat(r["action"]), "c": components(r["comps"]), "sv": save_cat(r["save"]),
            "sr": sr_cat(r["sr"]), "dm": doms, "src": books(r["source"]), "zh": r["zh"],
        })
        e = ent.get(r["page"])
        head = (f"<div class=\"dd-f\"><b>学派</b> {html.escape(r['school'])}"
                f"{'（' + html.escape(r['sub']) + '）' if r['sub'] else ''}"
                f"{'［' + html.escape(r['tags']) + '］' if r['tags'] else ''}</div>"
                f"<div class=\"dd-f\"><b>等级</b> {html.escape(r['classlv'])}</div>")
        if r["domlv"]:
            head += f"<div class=\"dd-f\"><b>领域</b> {html.escape(r['domlv'])}</div>"
        if e:
            det[r["page"]] = head + fields(e, [("action", "施法时间"), ("components", "成分"), ("range", "距离"), ("target", "目标"),
                                              ("effect", "效果"), ("area", "区域"), ("duration", "持续时间"), ("save", "豁免"),
                                              ("sr", "法术抗力"), ("source", "来源")]) + "<hr>" + section(e, "description")
        else:
            det[r["page"]] = head
    return rows, det


def build_feats():
    ent = by_title("feats")
    rows, det = [], {}
    for r in tables("Feats"):
        rows.append({
            "p": r["page"], "n": r["name"], "e": r["en"], "k": split(r["cats"], "、"), "pre": r["prereq"],
            "rf": [x.split("~")[0] for x in split(r["reqf"], "|")], "src": books(r["book"]), "pfs": r["pfs"], "zh": r["zh"],
        })
        e = ent.get(r["page"])
        if e:
            det[r["page"]] = (fields(e, [("categories", "类型"), ("prerequisites", "先决条件"), ("source_name", "来源")]) + "<hr>"
                              + section(e, "description") + section(e, "benefit", "专长效果") + section(e, "normal", "通常")
                              + section(e, "special", "特殊") + section(e, "goal", "目标") + section(e, "completion_benefit", "完成奖励")
                              + section(e, "stamina", "耐力") + section(e, "notes", "注释"))
        else:
            det[r["page"]] = f"<p>{html.escape(r['desc'])}</p>"
    return rows, det


def build_traits():
    ent = by_title("traits")
    rows, det = [], {}
    for r in tables("Traits"):
        rows.append({"p": r["page"], "n": r["name"], "e": r["en"], "k": r["type"], "pre": r["prereq"],
                     "src": books(r["book"]), "pfs": r["pfs"], "ai": r.get("ai", False), "zh": r["zh"]})
        e = ent.get(r["page"])
        if e:
            det[r["page"]] = (fields(e, [("type", "类型"), ("prerequisites", "先决条件"), ("regions", "地区"), ("source_name", "来源")])
                              + "<hr>" + section(e, "description") + section(e, "benefit", "效果") + section(e, "notes", "注释"))
        else:
            det[r["page"]] = f"<p>{html.escape(r['desc'])}</p>"
    return rows, det


ITEM_FIELDS = [
    ("cat", "分类"), ("category", "分类"), ("acat", "分类"), ("wcat", "分类"), ("kind", "分类"), ("sub", "子类"),
    ("aura", "灵光"), ("cl", "施法者等级"), ("slot", "部位"), ("price", "价格"), ("weight", "重量"),
    ("prof", "熟练"), ("dmg_s", "伤害（小）"), ("dmg_m", "伤害（中）"), ("dmg", "伤害"), ("crit", "重击"), ("range", "射程"),
    ("type", "类型"), ("dmg_type", "伤害类型"), ("groups", "武器组"), ("special", "特殊"), ("misfire", "哑火"), ("capacity", "容量"),
    ("ac", "护甲加值"), ("maxdex", "最大敏捷"), ("acp", "防具检定减值"), ("asf", "奥术失败率"), ("speed", "速度"),
    ("base", "基础物品"), ("enh", "增强"), ("tier", "神器等级"), ("intel", "智能物品"), ("source", "来源"), ("source_name", "来源"),
]
CONSTRUCTION = [("req", "需求"), ("requirements", "需求"), ("construction", "需求"), ("cost", "成本"), ("craft_dc", "制作 DC"),
                ("recipe", "配方"), ("destruction", "毁灭方式")]


def build_items():
    ent = by_title("magic_items", "equipment", "weapons", "armor", "technology", "items_misc")
    rows, det = [], {}
    for r in tables("Items"):
        if r["cat"] in ("危害", "毒药"):
            continue
        aura = r["aura"]
        rows.append({
            "p": r["page"], "n": r["name"], "e": r["en"], "cat": r["cat"] or "其他", "sub": r["sub"], "ch": r["chapter"],
            "slot": r["slot"] if r["slot"] not in ("", "无", "无位置") else ("无部位" if r["slot"] else ""),
            "pr": price_gp(r["price"]), "cl": to_int(r["cl"]),
            "au": [s for s in AURA_SCHOOLS if s in aura], "as": next((s for s in ("微弱", "中等", "强烈", "压倒性") if s in aura), ""),
            "src": books(r["source"]), "tier": r["tier"], "zh": r["zh"],
        })
        e = ent.get(r["page"])
        if e:
            text = e.get("text", {})
            seen, spec = set(), []
            for k, label in ITEM_FIELDS:  # 同义字段只取第一个
                if text.get(k) and label not in seen:
                    seen.add(label)
                    spec.append((k, label))
            cons = fields(e, CONSTRUCTION)
            det[r["page"]] = fields(e, spec) + "<hr>" + section(e, "description") + (f"<h4>制造</h4>{cons}" if cons else "")
        else:
            det[r["page"]] = "".join(f"<div class=\"dd-f\"><b>{l}</b> {html.escape(r[k])}</div>" for k, l in
                                     (("cat", "分类"), ("sub", "子类"), ("price", "价格"), ("weight", "重量"), ("slot", "部位"),
                                      ("aura", "灵光"), ("cl", "施法者等级"), ("req", "需求"), ("cost", "成本"), ("source", "来源")) if r.get(k))
    return rows, det


def build_monsters():
    rows, det = [], {}
    pages = set()
    for r in tables("Monsters"):
        pages.add(r["page"])
        rows.append({
            "p": r["page"], "n": r["name"], "e": r["en"], "kd": "怪物", "cr": r["crn"] / 24 if r["crn"] is not None else None, "crs": r["cr"],
            "ct": r["ctype"], "st": split(r["st"], "|、"), "sz": r["size"], "al": r["align"], "ter": split(r["ter"], "|"),
            "mv": split(r["mv"], "|"), "src": books(r["src"]), "hp": r["hp"], "ac": r["ac"], "xp": r["xp"], "zh": r["zh"],
        })
        sub = f"（{html.escape(r['st'].replace('|', '、'))}）" if r["st"] else ""
        det[r["page"]] = (f"<div class=\"dd-f\"><b>CR</b> {html.escape(str(r['cr']))}　<b>XP</b> {r['xp'] or '—'}</div>"
                          f"<div class=\"dd-f\">{html.escape(r['align'])} {html.escape(r['size'])}{html.escape(r['ctype'])}{sub}</div>"
                          f"<div class=\"dd-f\"><b>AC</b> {r['ac']}　<b>HP</b> {r['hp']}</div>"
                          f"<div class=\"dd-f\"><b>环境</b> {html.escape(r['env'] or '—')}</div>"
                          f"<div class=\"dd-f\"><b>来源</b> {html.escape(r['src'])}</div><hr><p>{html.escape(r['desc'] or '')}</p>")
    for r in tables("NPCs"):
        if r["page"] in pages:
            continue
        rows.append({
            "p": r["page"], "n": r["name"], "e": r["en"], "kd": "NPC", "cr": r["crn"] / 24 if r["crn"] is not None else None, "crs": r["cr"],
            "ct": r["ctype"], "al": r["align"], "race": r["race"], "cls": r["clss"] or r["cls_name"], "lvl": r["lvl"],
            "src": books(r["src"]), "hp": r["hp"], "ac": r["ac"], "xp": r["xp"], "zh": r["zh"],
        })
        det[r["page"]] = (f"<div class=\"dd-f\"><b>CR</b> {html.escape(str(r['cr']))}　<b>XP</b> {r['xp'] or '—'}</div>"
                          f"<div class=\"dd-f\">{html.escape(r['align'])} {html.escape(r['cls'] or '')}（{html.escape(r['ctype'])}）</div>"
                          f"<div class=\"dd-f\"><b>AC</b> {r['ac']}　<b>HP</b> {r['hp']}</div>"
                          f"<div class=\"dd-f\"><b>分组</b> {html.escape(r['fam'] or '—')}</div>"
                          f"<div class=\"dd-f\"><b>来源</b> {html.escape(r['src'])}</div><hr><p>{html.escape(r['desc'] or '')}</p>")
    return rows, det


TABS = {"spells": build_spells, "feats": build_feats, "traits": build_traits, "items": build_items, "monsters": build_monsters}


def main():
    (OUT / "d").mkdir(parents=True, exist_ok=True)
    for old in (OUT / "d").glob("*.json"):
        old.unlink()
    meta = {"version": time.strftime("%Y%m%d%H%M"), "tabs": {}}
    pages = {}
    for tab, fn in TABS.items():
        rows, det = fn()
        rows.sort(key=lambda r: r["n"])
        # 去掉空值，文件小一点
        rows = [{k: v for k, v in r.items() if v not in ("", None, [], {}, False)} for r in rows]
        shard, size, buf = 0, 0, {}
        for r in rows:
            h = det.get(r["p"], "")
            if size + len(h.encode()) > SHARD_BYTES and buf:
                (OUT / "d" / f"{tab}-{shard}.json").write_text(json.dumps(buf, ensure_ascii=False), "utf-8")
                shard, size, buf = shard + 1, 0, {}
            buf[r["p"]] = h
            size += len(h.encode())
            r["d"] = shard
            pages.setdefault(r["p"], tab)
        if buf:
            (OUT / "d" / f"{tab}-{shard}.json").write_text(json.dumps(buf, ensure_ascii=False), "utf-8")
        (OUT / f"{tab}.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")), "utf-8")
        meta["tabs"][tab] = {"rows": len(rows), "shards": shard + 1}
        print(tab, len(rows), "行", shard + 1, "片", (OUT / f"{tab}.json").stat().st_size // 1024, "KB")
    (OUT / "pages.json").write_text(json.dumps(pages, ensure_ascii=False, separators=(",", ":")), "utf-8")
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
    print("pages", len(pages), "版本", meta["version"])


if __name__ == "__main__":
    main()
