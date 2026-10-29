// pf1-banana：资料浏览器。
// 分页：法术 / 专长 / 特性 / 物品 / 怪物与 NPC（怪物页默认只给 GM）。左边筛选，中间列表，右边详情。
// 数据：开拓者1版中文维基（PFWiki）的离线导出，由 tools/build_data.py 生成到 data/；
//   列表和筛选字段一次读进来，详情按分片用到才读。
// 和合集包对上：按英文名（Babele 的 originalName，没装汉化时就是条目名）匹配 PF1 / pf-content 的合集包，
//   怪物按 pf1-zh-monsters 的 flags["zh-monsters"].page。对上的条目可以拖进角色卡或场景、打开原条目；
//   合集包里有、维基没有的也列出来（标「无维基」，详情用合集包的描述）。
// 筛选：多选项点一下 = 包含（✓），再点 = 排除（✗），再点 = 不管；多值字段（描述符、成分、类型……）可切换「任一 / 全部」。
// 搜索：中文、英文、拼音全拼、拼音首字母。
// 入口：快捷键 B 开 / 关；合集包侧栏顶上的「资料浏览器」按钮；PF1 自己的法术 / 专长 / 物品 / 怪物浏览器（可在设置里关掉替换）；
//   聊天卡片里的维基链接；宏 game.modules.get("pf1-banana").api.open("spells", "火球")。
// GM 开关（窗口顶上，也在模组设置里）：玩家能不能看怪物页（默认不能）、能不能购买（buy.mjs，默认能）。
import { MODULE } from "./const.mjs";
import { loadLib, keysOf, score } from "./pinyin.mjs";
import { buyItem, buySpell } from "./buy.mjs";

const BASE = `modules/${MODULE}/data/`;
const WIKI = "https://pf1.huijiwiki.com/wiki/";
const PAGE = 150;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const norm = (s) => (s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]/g, "");
const zhName = (name) => name.replace(/\s*[（(][^（()）]*[A-Za-z][^（()）]*[)）]\s*$/, "").trim() || name;
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const gp = (v) => (v == null ? "" : v >= 1 ? `${+v.toFixed(2)} gp` : v >= 0.1 ? `${+(v * 10).toFixed(1)} sp` : `${Math.round(v * 100)} cp`);
const crText = (v) => (v == null ? "" : v >= 1 ? String(Math.round(v)) : `1/${Math.round(1 / v)}`);

// ---------- 筛选定义 ----------
// dependsOn：选项只列上级筛选（如「分类」）选中的那些条目里有的值，上级一变就重算
const multi = (key, label, o = {}) => ({ kind: "multi", key, label, get: o.get ?? ((r) => r[key]), many: !!o.many, order: o.order, open: !!o.open, dependsOn: o.dependsOn });
const range = (key, label, o = {}) => ({ kind: "range", key, label, get: o.get ?? ((r) => r[key]), step: o.step ?? 1 });
const check = (key, label, test) => ({ kind: "check", key, label, test });
const text = (key, label, get) => ({ kind: "text", key, label, get });
const linked = check("linked", "只看能拖进角色卡的", (r) => !!r.uuid);
const included = (st) => [...(st ?? new Map())].filter(([, v]) => v === 1).map(([k]) => k);

const SIZES = ["超微型", "微型", "超小型", "小型", "中型", "大型", "超大型", "巨型", "超巨型"];
const LEVELS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

const TABS = {
  spells: {
    label: "法术", icon: "fa-solid fa-wand-sparkles", doc: "Item", packs: () => ["pf1.spells"],
    filters: [
      multi("cl", "职业", { get: (r) => Object.keys(r.cl ?? {}), open: true }),
      // 选了职业就按那些职业的环级，没选就按最低环级
      multi("lv", "环级", { order: LEVELS, open: true, dependsOn: "cl", get: (r, st) => {
        const cls = included(st.cl);
        if (!cls.length) return r.lv != null ? [String(r.lv)] : [];
        return cls.map((c) => r.cl?.[c]).filter((v) => v != null).map(String);
      } }),
      multi("sc", "学派", { open: true }),
      multi("ss", "子学派"),
      multi("t", "描述符", { many: true }),
      multi("a", "施法时间"),
      multi("c", "成分", { many: true }),
      multi("sv", "豁免", { many: true }),
      multi("sr", "法术抗力"),
      multi("dm", "领域", { many: true }),
      multi("src", "来源", { many: true }),
      linked,
    ],
    sorts: { name: "名称", level: "环级", school: "学派" },
    meta: (r, st) => {
      const cls = included(st.cl);
      const lv = cls.length === 1 ? r.cl?.[cls[0]] : r.lv;
      return [r.sc, lv != null ? `${lv} 环` : ""].filter(Boolean).join(" · ");
    },
  },
  feats: {
    label: "专长", icon: "fa-solid fa-medal", doc: "Item", packs: () => ["pf1.feats", "pf-content.pf-feats"],
    filters: [
      multi("k", "类型", { many: true, open: true }),
      check("nopre", "没有先决条件", (r) => !r.pre),
      text("pre", "先决条件包含", (r) => r.pre),
      multi("rf", "先决专长", { many: true }),
      check("pfs", "PFS 合法", (r) => !!r.pfs),
      multi("src", "来源", { many: true }),
      linked,
    ],
    sorts: { name: "名称", type: "类型" },
    meta: (r) => arr(r.k).join("、") || (r.fo ? "" : "通用"),
  },
  traits: {
    label: "特性", icon: "fa-solid fa-feather", doc: "Item", packs: () => ["pf-content.pf-traits"],
    filters: [
      multi("k", "类型", { open: true }),
      check("nopre", "没有先决条件", (r) => !r.pre),
      text("pre", "先决条件包含", (r) => r.pre),
      check("pfs", "PFS 合法", (r) => !!r.pfs),
      multi("src", "来源", { many: true }),
      linked,
    ],
    sorts: { name: "名称", type: "类型" },
    meta: (r) => r.k ?? "",
  },
  items: {
    label: "物品", icon: "fa-solid fa-sack", doc: "Item",
    packs: () => ["pf1.items", "pf1.weapons-and-ammo", "pf1.armors-and-shields", "pf1.technology", "pf-content.pf-items",
      "pf-content.pf-magic-items", "pf-content.pf-wondrous", "pf-content.pf-artifacts", "pf-content.pf-cursed-items", "pf-content.pf-intelligent-items"],
    filters: [
      multi("cat", "分类", { open: true }),
      multi("sub", "子类", { dependsOn: "cat" }),
      multi("slot", "部位"),
      range("pr", "价格（gp）", { step: 1 }),
      range("cl", "施法者等级"),
      multi("au", "灵光学派", { many: true }),
      multi("as", "灵光强度", { order: ["微弱", "中等", "强烈", "压倒性"] }),
      multi("tier", "神器"),
      multi("src", "来源", { many: true }),
      linked,
    ],
    sorts: { name: "名称", price: "价格", cl: "施法者等级" },
    meta: (r) => [r.pr != null ? gp(r.pr) : "", r.slot && r.slot !== "无部位" ? r.slot : r.sub].filter(Boolean).join(" · "),
  },
  monsters: {
    label: "怪物/NPC", icon: "fa-solid fa-dragon", doc: "Actor", gm: true,
    packs: () => game.packs.filter((p) => p.metadata.packageName === "pf1-zh-monsters" && p.documentName === "Actor").map((p) => p.collection),
    filters: [
      multi("kd", "怪物 / NPC", { open: true }),
      range("cr", "CR", { step: 0.125 }),
      multi("ct", "类型", { open: true }),
      multi("cls", "NPC 职业"),
      multi("race", "NPC 种族"),
      multi("st", "子类型", { many: true }),
      multi("sz", "体型", { order: SIZES }),
      multi("al", "阵营"),
      multi("ter", "地形", { many: true }),
      multi("mv", "移动方式", { many: true }),
      range("hp", "HP"),
      range("ac", "AC"),
      multi("src", "来源", { many: true }),
      linked,
    ],
    sorts: { name: "名称", cr: "CR", hp: "HP" },
    meta: (r) => [r.cr != null ? `CR ${crText(r.cr)}` : "", r.kd === "NPC" ? [r.race, r.cls, r.lvl].filter(Boolean).join("") : [r.sz, r.ct].filter(Boolean).join("")]
      .filter(Boolean).join(" · "),
  },
};

const setting = (key) => game.settings.get(MODULE, key);
const allowed = (tab) => !TABS[tab].gm || game.user.isGM || setting("monsters");
const canBuy = (tab) => (tab === "items" || tab === "spells") && setting("shop");

const SORTERS = {
  name: (a, b) => a.n.localeCompare(b.n, "zh"),
  level: (a, b) => (a._lv ?? 99) - (b._lv ?? 99),
  school: (a, b) => (a.sc ?? "").localeCompare(b.sc ?? "", "zh"),
  type: (a, b) => arr(a.k).join().localeCompare(arr(b.k).join(), "zh"),
  price: (a, b) => (a.pr ?? Infinity) - (b.pr ?? Infinity),
  cl: (a, b) => (a.cl ?? 99) - (b.cl ?? 99),
  cr: (a, b) => (a.cr ?? 99) - (b.cr ?? 99),
  hp: (a, b) => (a.hp ?? 1e9) - (b.hp ?? 1e9),
};

// ---------- 数据 ----------
let metaP = null;
const meta = () => (metaP ??= fetch(`${BASE}meta.json`, { cache: "no-cache" }).then((r) => r.json()));
const getJSON = async (path) => {
  const { version } = await meta();
  const res = await fetch(`${BASE}${path}?v=${version}`);
  if (!res.ok) throw new Error(`读不到 ${path}（${res.status}）`);
  return res.json();
};
const shards = new Map();
const shard = (tab, n) => {
  const key = `${tab}-${n}`;
  if (!shards.has(key)) shards.set(key, getJSON(`d/${key}.json`).catch((err) => (shards.delete(key), Promise.reject(err))));
  return shards.get(key);
};
let pagesP = null;
const pageTabs = () => (pagesP ??= getJSON("pages.json"));

// 合集包英文名去掉变体后缀后的候选：「Ring of Protection +2」「Talisman of Freedom, Lesser」「Signature Skill (Disguise)」
// 「Kit, Psychic's」（逗号倒装）……依次退到维基页的名字
function baseKeys(en) {
  const out = [];
  const push = (x) => {
    const k = norm(x);
    if (k && !out.includes(k)) out.push(k);
  };
  let s = en.trim();
  for (let i = 0; i < 4; i++) {
    const swap = s.match(/^([^,]+),\s*([^,]+)$/);
    if (swap) push(`${swap[2]} ${swap[1]}`);
    const next = s.replace(/\s*\([^()]*\)\s*$/, "").replace(/\s*[+-]\d+\s*$/, "").replace(/\s*\d+(st|nd|rd|th)[- ]level$/i, "")
      .replace(/,\s*(lesser|greater|minor|major|mass|improved|communal|true|medium|small|large)$/i, "").trim();
    if (!next || next === s) break;
    s = next;
    push(s);
  }
  return out;
}

// 中文名：Babele 的「中文 (English)」去掉英文；去掉后和本体同名的，补上英文括号里的变体（标志性技能（Disguise））
function variantName(e, en, base) {
  let n = e.name.replace(` (${en})`, "").trim();
  if (n === e.name) n = zhName(e.name);
  if (base && n === base.n) {
    const tail = en.match(/\(([^()]*)\)\s*$/)?.[1] ?? en.match(/([+-]\d+)\s*$/)?.[1] ?? en.match(/,\s*([^,]+)$/)?.[1];
    if (tail) n = `${n}（${tail}）`;
  }
  return n;
}

// 维基上没有的合集包物品，按 PF1 的物品类型归到和维基一样的分类
const LOOT_CAT = {
  ammo: ["武器", "弹药"], tradeGoods: ["冒险装备", "其他"], treasure: ["冒险装备", "其他"], food: ["冒险装备", "饮食与住宿"],
  tool: ["冒险装备", "工具与套装"], entertainment: ["冒险装备", "其他"], animal: ["坐骑与交通", "坐骑与宠物"],
  animalGear: ["坐骑与交通", "动物装备"], vehicle: ["坐骑与交通", "交通工具"], reagent: ["炼金物品", "炼金工具"],
  remedy: ["炼金物品", "炼金药剂"], herb: ["炼金物品", "草药与酊剂"],
};
function foundryItemCat(e) {
  const s = e.system?.subType;
  const pair = (() => {
    switch (e.type) {
      case "weapon": return ["武器", { simple: "简易武器", martial: "军用武器", exotic: "异种武器", siege: "攻城兵器" }[s] ?? "异种武器"];
      case "equipment":
        if (s === "armor" || s === "shield") return ["防具", s === "shield" ? "盾牌" : ""];
        if (s === "wondrous") return ["奇物", ""];
        if (s === "clothing") return ["冒险装备", "衣物"];
        return e.system?.cl > 0 ? ["其他魔法物品", "其他"] : ["冒险装备", "其他"];
      case "consumable":
        return { potion: ["其他魔法物品", "药水"], scroll: ["其他魔法物品", "卷轴"], wand: ["其他魔法物品", "魔杖"], staff: ["法杖", ""] }[s] ?? ["炼金物品", "炼金药剂"];
      case "loot": return LOOT_CAT[s] ?? ["冒险装备", "冒险装备"];
      case "container": return ["冒险装备", "冒险装备"];
      default: return ["其他魔法物品", "其他"];
    }
  })();
  return pair[1] ? { cat: pair[0], sub: pair[1] } : { cat: pair[0] };
}

// 读维基列表，再和合集包索引对上
async function loadTab(tab) {
  const def = TABS[tab];
  const rows = await getJSON(`${tab}.json`);
  const packs = def.packs().map((id) => game.packs.get(id)).filter(Boolean);
  const fields = tab === "monsters" ? ["flags.zh-monsters.page", "system.details.cr.base"] : tab === "items" ? ["system.price", "system.subType", "system.cl"] : [];
  const indexes = await Promise.all(packs.map((p) => p.getIndex({ fields })));
  if (tab === "monsters") {
    const byPage = new Map(rows.map((r) => [r.p, r]));
    for (const idx of indexes) for (const e of idx) {
      const page = e.flags?.["zh-monsters"]?.page;
      const row = page && byPage.get(page);
      if (row) {
        row.uuid ??= e.uuid;
        continue;
      }
      const en = e.name.match(/\(([^()]*)\)\s*$/)?.[1] ?? "";
      rows.push({ n: variantName(e, en), e: en, cr: e.system?.details?.cr?.base, uuid: e.uuid, fo: true, img: e.img });
    }
    return rows;
  }
  const byEn = new Map();
  for (const r of rows) if (r.e) {
    const k = norm(r.e);
    if (!byEn.has(k)) byEn.set(k, []);
    byEn.get(k).push(r);
  }
  // 专长和物品的变体（+2 戒指、各技能的标志性技能）各自是不同的条目，单列一行，筛选字段和详情跟本体；
  // 法术和特性的「变体」是同一条的重复收录（Fool's Gold (VC) / (AA)），本体没对上才用
  const variants = tab === "feats" || tab === "items";
  const extra = [];
  for (const idx of indexes) for (const e of idx) {
    const en = e.originalName ?? e.name; // 没翻译的条目 name 就是英文
    const exact = byEn.get(norm(en));
    if (exact) {
      for (const r of exact) if (!r.uuid) { r.uuid = e.uuid; r.img = e.img; }
      continue;
    }
    const key = baseKeys(en).find((k) => byEn.has(k));
    const base = key && byEn.get(key);
    if (base && !variants) {
      const free = base.find((r) => !r.uuid);
      if (free) Object.assign(free, { uuid: e.uuid, img: e.img });
      continue;
    }
    const row = base ? { ...base[0], n: variantName(e, en, base[0]), e: en, uuid: e.uuid, img: e.img, _py: undefined }
      : { n: variantName(e, en), e: en, uuid: e.uuid, img: e.img, fo: true, ...(tab === "items" ? foundryItemCat(e) : {}) };
    if (tab === "items" && e.system?.price) row.pr = e.system.price;
    extra.push(row);
  }
  return rows.concat(extra);
}

// ---------- 窗口 ----------
class DDBrowser extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pb-browser",
    classes: ["pb-browser"],
    window: { title: "资料浏览器", icon: "fa-solid fa-book-open", resizable: true },
    position: { width: 1180, height: 760 },
  };

  tab = "spells";
  data = {};    // tab → rows（Promise 或数组）
  tabStates = {};   // tab → { q, sort, filters: {key: Map|{min,max}|bool|string}, sel }
  shown = [];
  #els = {};

  tabState(tab = this.tab) {
    return (this.tabStates[tab] ??= { q: "", sort: "name", filters: {}, sel: null });
  }

  async _renderHTML() {
    return null;
  }

  _replaceHTML(result, content, options) {
    if (!options.isFirstRender) return;
    content.innerHTML = `<div class="pb-br">
      <div class="pb-br-top">
        <div class="pb-br-tabs"></div>
        <input type="search" placeholder="搜索：中文 / 英文 / 拼音（huoqiu、hqs）">
        <select class="pb-sort"></select>
        <button type="button" class="pb-reset" style="width:auto"><i class="fa-solid fa-filter-circle-xmark"></i> 重置筛选</button>
        <span class="pb-br-count"></span>
        ${game.user.isGM ? `<label class="pb-gmopt" data-tooltip="关着时只有 GM 能看怪物/NPC 页"><input type="checkbox" data-setting="monsters" ${setting("monsters") ? "checked" : ""}> 玩家可看怪物</label>
          <label class="pb-gmopt" data-tooltip="关掉后谁都不能在这里买东西（比如在地城里）"><input type="checkbox" data-setting="shop" ${setting("shop") ? "checked" : ""}> 可以购买</label>` : ""}
      </div>
      <div class="pb-br-body">
        <div class="pb-br-filters"></div>
        <div class="pb-br-list"><ol></ol></div>
        <div class="pb-br-detail"><div class="pb-br-empty">点左边的条目看详情</div></div>
      </div></div>`;
    const q = (s) => content.querySelector(s);
    this.#els = { tabs: q(".pb-br-tabs"), search: q("input[type=search]"), sort: q(".pb-sort"), count: q(".pb-br-count"),
      filters: q(".pb-br-filters"), list: q(".pb-br-list"), ol: q(".pb-br-list ol"), detail: q(".pb-br-detail") };
    const e = this.#els;
    this.renderTabs();
    for (const box of content.querySelectorAll("input[data-setting]")) {
      box.addEventListener("change", () => game.settings.set(MODULE, box.dataset.setting, box.checked));
    }
    e.tabs.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-tab]");
      if (b) this.switchTab(b.dataset.tab);
    });
    e.search.addEventListener("input", foundry.utils.debounce(() => {
      this.tabState().q = e.search.value.trim();
      this.refresh();
    }, 200));
    e.sort.addEventListener("change", () => {
      this.tabState().sort = e.sort.value;
      this.refresh();
    });
    q(".pb-reset").addEventListener("click", () => {
      this.tabState().filters = {};
      this.buildFilters();
      this.refresh();
    });
    e.list.addEventListener("scroll", () => {
      if (e.list.scrollTop + e.list.clientHeight > e.list.scrollHeight - 200) this.renderMore();
    });
    e.ol.addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-i]");
      if (!li) return;
      const r = this.shown[+li.dataset.i];
      if (ev.target.closest(".pb-buy")) return this.buy(r);
      this.select(r);
    });
    e.ol.addEventListener("dragstart", (ev) => {
      const li = ev.target.closest("li[data-i]");
      const r = li && this.shown[+li.dataset.i];
      if (!r?.uuid) return ev.preventDefault();
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: TABS[this.tab].doc, uuid: r.uuid }));
    });
    e.detail.addEventListener("click", (ev) => this.#onDetailClick(ev));
    this.switchTab(this.tab);
  }

  renderTabs() {
    this.#els.tabs.innerHTML = Object.entries(TABS).filter(([k]) => allowed(k))
      .map(([k, d]) => `<button type="button" data-tab="${k}" class="${k === this.tab ? "active" : ""}"><i class="${d.icon}"></i> ${d.label}</button>`).join("");
  }

  // GM 改了开关：分页和购买按钮跟着变
  onSettingChange() {
    if (!this.#els.tabs) return;
    for (const box of this.element.querySelectorAll("input[data-setting]")) box.checked = setting(box.dataset.setting);
    this.renderTabs();
    if (!allowed(this.tab)) return this.switchTab("spells");
    this.refresh();
    const sel = this.tabState().sel;
    if (sel) this.showDetail(sel);
  }

  buy(r) {
    if (!r?.uuid || !canBuy(this.tab)) return;
    return this.tab === "spells" ? buySpell(r) : buyItem(r);
  }

  async rows(tab) {
    const d = this.data[tab];
    if (Array.isArray(d)) return d;
    this.data[tab] = d ?? loadTab(tab).then((rows) => {
      this.data[tab] = rows;
      // 拼音在空闲时算好，第一次拼音搜索不用等
      loadLib().then(() => { for (const r of rows) r._py = keysOf(r.n); if (this.tab === tab && /^[a-z]+$/i.test(this.tabState().q)) this.refresh(); })
        .catch((err) => console.warn("pb-browser | 拼音库", err));
      return rows;
    }).catch((err) => {
      delete this.data[tab];
      throw err;
    });
    return this.data[tab];
  }

  async switchTab(tab, { keepSel = false } = {}) {
    if (!allowed(tab)) tab = "spells";
    this.tab = tab;
    const e = this.#els;
    for (const b of e.tabs.querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
    const st = this.tabState();
    e.search.value = st.q;
    e.sort.innerHTML = Object.entries(TABS[tab].sorts).map(([k, l]) => `<option value="${k}" ${k === st.sort ? "selected" : ""}>按${l}</option>`).join("");
    e.filters.innerHTML = '<div class="pb-br-empty">读取中…</div>';
    e.ol.innerHTML = "";
    e.count.textContent = "";
    try {
      await this.rows(tab);
    } catch (err) {
      console.error("pb-browser |", err);
      e.filters.innerHTML = `<div class="pb-br-empty">读取失败：${esc(err.message)}</div>`;
      return;
    }
    if (this.tab !== tab) return;
    this.buildFilters();
    this.refresh();
    if (!keepSel) {
      const sel = st.sel && this.data[tab].find((r) => r === st.sel);
      if (sel) this.showDetail(sel);
      else e.detail.innerHTML = '<div class="pb-br-empty">点列表里的条目看详情</div>';
    }
  }

  // 每个多选项的取值和条数（按全部数据算，不随别的筛选变）
  optionsOf(f, rows) {
    const counts = new Map();
    const st = this.tabState().filters;
    if (f.dependsOn) {
      const parent = TABS[this.tab].filters.find((x) => x.key === f.dependsOn);
      const inc = included(st[f.dependsOn]);
      if (inc.length) rows = rows.filter((r) => arr(parent.get(r, st)).some((v) => inc.includes(String(v))));
    }
    for (const r of rows) for (const v of new Set(arr(f.get(r, st)))) if (v !== "" && v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
    const list = [...counts];
    if (f.order) list.sort((a, b) => f.order.indexOf(String(a[0])) - f.order.indexOf(String(b[0])));
    else list.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh"));
    return list;
  }

  buildFilters() {
    const def = TABS[this.tab];
    const rows = this.data[this.tab];
    const fs = this.tabState().filters;
    const box = this.#els.filters;
    box.innerHTML = "";
    for (const f of def.filters) {
      const el = document.createElement(f.kind === "check" ? "div" : "details");
      el.dataset.key = f.key;
      if (f.kind === "check") {
        el.innerHTML = `<label class="pb-opt"><input type="checkbox" ${fs[f.key] ? "checked" : ""}> ${f.label}</label>`;
        el.querySelector("input").addEventListener("change", (ev) => { fs[f.key] = ev.target.checked; this.refresh(); });
      } else if (f.kind === "text") {
        el.open = !!fs[f.key];
        el.innerHTML = `<summary>${f.label}</summary><input type="text" value="${esc(fs[f.key] ?? "")}">`;
        el.querySelector("input").addEventListener("input", foundry.utils.debounce((ev) => { fs[f.key] = ev.target.value.trim(); this.refresh(); }, 250));
      } else if (f.kind === "range") {
        const v = fs[f.key] ?? {};
        el.open = v.min != null || v.max != null;
        el.innerHTML = `<summary>${f.label}</summary><div class="pb-range">
          <input type="number" step="${f.step}" placeholder="最小" value="${v.min ?? ""}"> – <input type="number" step="${f.step}" placeholder="最大" value="${v.max ?? ""}"></div>`;
        const [lo, hi] = el.querySelectorAll("input");
        const upd = foundry.utils.debounce(() => {
          const n = (i) => (i.value === "" ? null : Number(i.value));
          fs[f.key] = { min: n(lo), max: n(hi) };
          this.refresh();
        }, 250);
        lo.addEventListener("input", upd);
        hi.addEventListener("input", upd);
      } else {
        this.#buildMulti(el, f, rows, fs);
      }
      box.append(el);
    }
    box.insertAdjacentHTML("beforeend", '<div class="pb-br-credit">点一下＝包含，再点＝排除。数据：开拓者1版中文维基（CC BY-SA 4.0），社区译者整理。</div>');
  }

  #buildMulti(el, f, rows, fs) {
    const opts = this.optionsOf(f, rows);
    const sel = (fs[f.key] ??= new Map());
    // 上级筛选变了以后，已经不在选项里的选择作废
    for (const v of [...sel.keys()]) if (!opts.some(([o]) => String(o) === v)) sel.delete(v);
    el.hidden = !opts.length;
    if (f.many && fs[`${f.key}:all`] == null) fs[`${f.key}:all`] = false;
    el.open = f.open || sel.size > 0;
    const summary = () => {
      const n = sel.size;
      return `${f.label}${n ? ` <span class="pb-n">(${n})</span>` : ""}${f.many ? `<a class="pb-mode" data-tooltip="勾了好几个时：任一＝满足其中一个就行；全部＝都要有">${fs[`${f.key}:all`] ? "全部" : "任一"}</a>` : ""}${n ? '<a class="pb-x" data-tooltip="清空">✕</a>' : ""}`;
    };
    el.innerHTML = `<summary>${summary()}</summary>${opts.length > 12 ? '<input type="text" class="pb-optq" placeholder="筛选选项…">' : ""}
      <div class="pb-br-opts">${opts.map(([v, c]) => `<div class="pb-opt ${sel.get(String(v)) === 1 ? "inc" : sel.get(String(v)) === -1 ? "exc" : ""}" data-v="${esc(v)}">
        <span class="pb-s"></span><span class="pb-l">${esc(f.key === "lv" ? `${v} 环` : v)}</span><span class="pb-c">${c}</span></div>`).join("")}</div>`;
    const sum = el.querySelector("summary");
    sum.addEventListener("click", (ev) => {
      if (ev.target.closest(".pb-x")) {
        ev.preventDefault();
        sel.clear();
        for (const o of el.querySelectorAll(".pb-opt")) o.classList.remove("inc", "exc");
      } else if (ev.target.closest(".pb-mode")) {
        ev.preventDefault();
        fs[`${f.key}:all`] = !fs[`${f.key}:all`];
      } else return;
      sum.innerHTML = summary();
      this.refresh();
    });
    el.querySelector(".pb-br-opts").addEventListener("click", (ev) => {
      const o = ev.target.closest(".pb-opt");
      if (!o) return;
      const v = o.dataset.v;
      const next = sel.get(v) === 1 ? -1 : sel.get(v) === -1 ? 0 : 1;
      if (next) sel.set(v, next);
      else sel.delete(v);
      o.classList.toggle("inc", next === 1);
      o.classList.toggle("exc", next === -1);
      sum.innerHTML = summary();
      // 环级跟着职业算，职业变了要重算环级的条数
      for (const dep of TABS[this.tab].filters.filter((x) => x.dependsOn === f.key)) {
        const depEl = this.#els.filters.querySelector(`[data-key="${dep.key}"]`);
        if (depEl) this.#buildMulti(depEl, dep, rows, fs);
      }
      this.refresh();
    });
    el.querySelector(".pb-optq")?.addEventListener("input", (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      for (const o of el.querySelectorAll(".pb-opt")) o.hidden = q && !o.dataset.v.toLowerCase().includes(q);
    });
  }

  match(r, def, fs) {
    for (const f of def.filters) {
      const v = fs[f.key];
      if (f.kind === "check") {
        if (v && !f.test(r)) return false;
      } else if (f.kind === "text") {
        if (v && !(f.get(r) ?? "").includes(v)) return false;
      } else if (f.kind === "range") {
        if (!v || (v.min == null && v.max == null)) continue;
        const x = f.get(r);
        if (x == null || (v.min != null && x < v.min) || (v.max != null && x > v.max)) return false;
      } else if (v?.size) {
        const vals = arr(f.get(r, fs)).map(String);
        let inc = 0, hit = 0;
        for (const [k, s] of v) {
          if (s === -1 && vals.includes(k)) return false;
          if (s === 1) { inc++; if (vals.includes(k)) hit++; }
        }
        if (inc && (fs[`${f.key}:all`] ? hit < inc : !hit)) return false;
      }
    }
    return true;
  }

  refresh() {
    const rows = this.data[this.tab];
    if (!Array.isArray(rows)) return;
    const def = TABS[this.tab];
    const st = this.tabState();
    const fs = st.filters;
    const q = st.q.toLowerCase();
    const py = /^[a-z]+$/.test(q.replace(/\s+/g, "")) && q.length >= 2 ? q.replace(/\s+/g, "") : null;
    let out = [];
    for (const r of rows) {
      if (!this.match(r, def, fs)) continue;
      if (q) {
        let s = 0;
        if (r.n.toLowerCase().includes(q)) s = r.n.toLowerCase() === q ? 10 : r.n.toLowerCase().startsWith(q) ? 9 : 8;
        else if (r.e?.toLowerCase().includes(q)) s = r.e.toLowerCase().startsWith(q) ? 7 : 6;
        else if (py && r._py) s = score(r._py, py);
        if (!s) continue;
        r._s = s;
      }
      out.push(r);
    }
    if (this.tab === "spells") {
      const cls = included(fs.cl);
      for (const r of out) r._lv = cls.length ? Math.min(...cls.map((c) => r.cl?.[c] ?? 99)) : r.lv;
    }
    const sorter = SORTERS[st.sort] ?? SORTERS.name;
    out.sort((a, b) => (q ? (b._s ?? 0) - (a._s ?? 0) : 0) || sorter(a, b) || SORTERS.name(a, b));
    this.shown = out;
    this.#els.count.textContent = `${out.length} / ${rows.length} 条`;
    this.#els.ol.innerHTML = "";
    this.#els.list.scrollTop = 0;
    this.listed = 0;
    this.renderMore();
  }

  renderMore() {
    if (this.listed >= this.shown.length) return;
    const def = TABS[this.tab];
    const st = this.tabState();
    const buy = canBuy(this.tab);
    const html = this.shown.slice(this.listed, this.listed + PAGE).map((r, k) => {
      const i = this.listed + k;
      const tags = `${r.fo ? '<span class="pb-tag" data-tooltip="维基上没有这条，详情用合集包的描述">无维基</span>' : ""}${
        !r.uuid ? '<span class="pb-tag" data-tooltip="合集包里没有对应条目，不能拖进角色卡">仅维基</span>' : ""}${
        r.zh === false ? '<span class="pb-tag">未翻译</span>' : ""}`;
      return `<li class="pb-row ${st.sel === r ? "sel" : ""}" data-i="${i}" draggable="${r.uuid ? "true" : "false"}">
        ${r.img ? `<img src="${esc(r.img)}" loading="lazy" alt="">` : ""}
        <div class="pb-nm"><b>${esc(r.n)}</b>${tags}<span class="pb-en">${esc(r.e ?? "")}</span></div>
        <div class="pb-mt">${esc(def.meta(r, st.filters))}</div>${buy && r.uuid ? '<a class="pb-buy" data-tooltip="购买"><i class="fa-solid fa-cart-shopping"></i></a>' : ""}</li>`;
    }).join("");
    this.#els.ol.insertAdjacentHTML("beforeend", html);
    this.listed = Math.min(this.listed + PAGE, this.shown.length);
    if (!this.shown.length) this.#els.ol.innerHTML = '<div class="pb-br-empty">没有符合条件的条目</div>';
  }

  select(r) {
    if (!r) return;
    this.tabState().sel = r;
    for (const li of this.#els.ol.querySelectorAll("li.sel")) li.classList.remove("sel");
    const i = this.shown.indexOf(r);
    this.#els.ol.querySelector(`li[data-i="${i}"]`)?.classList.add("sel");
    this.showDetail(r);
  }

  async showDetail(r) {
    const el = this.#els.detail;
    const tab = this.tab;
    el.innerHTML = `<h2>${esc(r.n)}</h2><div class="pb-sub">${esc(r.e ?? "")}</div>
      <div class="pb-acts">
        ${r.uuid && canBuy(tab) ? `<button type="button" data-act="buy"><i class="fa-solid fa-cart-shopping"></i> ${tab === "spells" ? "购买卷轴/药水/魔杖" : "购买"}</button>` : ""}
        ${r.uuid ? `<button type="button" data-act="open"><i class="fa-solid fa-up-right-from-square"></i> 打开条目</button>` : ""}
        <button type="button" data-act="chat"><i class="fa-solid fa-comment"></i> 发到聊天</button>
        ${r.p ? `<button type="button" data-act="wiki"><i class="fa-solid fa-globe"></i> 维基页面</button>` : ""}
        ${r.uuid ? `<span style="opacity:.6;align-self:center">可拖进角色卡${tab === "monsters" ? "或场景" : ""}</span>` : ""}
      </div><div class="pb-body"><div class="pb-br-empty">读取中…</div></div>`;
    el.scrollTop = 0;
    let body;
    try {
      body = await this.detailHTML(r, tab);
    } catch (err) {
      body = `<div class="pb-br-empty">读取失败：${esc(err.message)}</div>`;
    }
    if (this.tabState(tab).sel !== r && this.tab === tab) return;
    el.querySelector(".pb-body").innerHTML = body;
  }

  async detailHTML(r, tab = this.tab) {
    if (r.p && r.d != null) {
      const html = (await shard(tab, r.d))[r.p];
      if (html) return html;
    }
    if (!r.uuid) return '<div class="pb-br-empty">没有详情</div>';
    const doc = await fromUuid(r.uuid);
    const desc = doc?.system?.description?.value ?? doc?.system?.details?.notes?.value ?? "";
    const TE = foundry.applications.ux.TextEditor.implementation;
    return desc ? await TE.enrichHTML(desc, { async: true, relativeTo: doc }) : '<div class="pb-br-empty">合集包条目没有描述</div>';
  }

  async #onDetailClick(ev) {
    const wl = ev.target.closest(".pb-wl");
    if (wl) {
      ev.preventDefault();
      return openPage(wl.dataset.p);
    }
    const act = ev.target.closest("button[data-act]")?.dataset.act;
    const r = this.tabState().sel;
    if (!act || !r) return;
    if (act === "buy") this.buy(r);
    else if (act === "open") (await fromUuid(r.uuid))?.sheet.render(true);
    else if (act === "wiki") window.open(WIKI + encodeURIComponent(r.p), "_blank");
    else if (act === "chat") {
      const body = await this.detailHTML(r);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker(),
        content: `<div class="pb-browser-card"><h3>${esc(r.n)}${r.e ? ` <small>${esc(r.e)}</small>` : ""}</h3>${body}${r.uuid ? `<p>@UUID[${r.uuid}]{打开条目}</p>` : ""}</div>`,
      });
    }
  }

  // 跳到某个分页的某一页（不清筛选：先在筛选结果里找，找不到再清掉搜索和筛选）
  async goto(tab, page) {
    if (this.tab !== tab) await this.switchTab(tab, { keepSel: true });
    const rows = await this.rows(tab);
    const r = rows.find((x) => x.p === page);
    if (!r) return false;
    if (!this.shown.includes(r)) {
      const st = this.tabState();
      st.q = "";
      st.filters = {};
      this.#els.search.value = "";
      this.buildFilters();
      this.refresh();
    }
    const i = this.shown.indexOf(r);
    while (this.listed <= i) this.renderMore();
    this.select(r);
    this.#els.ol.querySelector(`li[data-i="${i}"]`)?.scrollIntoView({ block: "center" });
    return true;
  }

  setQuery(q) {
    this.tabState().q = q;
    if (this.#els.search) {
      this.#els.search.value = q;
      this.refresh();
    }
  }
}

let app = null;
const browser = () => (app ??= new DDBrowser());

async function open(tab = null, query = null) {
  const b = browser();
  if (tab && TABS[tab]) b.tab = tab;
  if (query != null) b.tabState(b.tab).q = query;
  if (b.rendered && b.element) {
    b.bringToFront?.();
    if (tab) await b.switchTab(b.tab);
    if (query != null) b.setQuery(query);
  } else await b.render({ force: true, position: { width: Math.min(1180, window.innerWidth - 40), height: Math.min(760, window.innerHeight - 40) } });
  return b;
}

async function openPage(page) {
  const tab = (await pageTabs())[page];
  if (tab && allowed(tab)) {
    const b = await open();
    if (await b.goto(tab, page)) return;
  }
  window.open(WIKI + encodeURIComponent(page), "_blank");
}

// 设置、快捷键在 main.mjs 里注册（onChange 要用到这里的 app）
export const browserApi = { open, openPage, settingChanged: () => app?.onSettingChange(), toggle: () => (app?.rendered ? app.close() : open()) };

// 合集包侧栏顶上加按钮
Hooks.on("renderCompendiumDirectory", (dir, html) => {
  const root = html instanceof HTMLElement ? html : html[0];
  const actions = root?.querySelector(".header-actions");
  if (!actions || actions.querySelector(".pb-browser-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pb-browser-open";
  btn.innerHTML = '<i class="fa-solid fa-book-open"></i><span>资料浏览器</span>';
  btn.addEventListener("click", () => open());
  actions.after(btn);
});

// 聊天卡里的维基链接
Hooks.on("renderChatMessageHTML", (msg, html) => {
  for (const a of html.querySelectorAll(".pb-wl")) a.addEventListener("click", (ev) => { ev.preventDefault(); openPage(a.dataset.p); });
});

// PF1 自己的浏览器（角色卡上的「浏览」等）换成这个。实例是用到时才建的，所以改类的 render；
// 怪物页不让玩家看时，玩家打开的还是 PF1 原来的
Hooks.once("ready", () => {
  const map = { SpellBrowser: "spells", FeatBrowser: "feats", ItemBrowser: "items", CreatureBrowser: "monsters" };
  for (const [cls, tab] of Object.entries(map)) {
    const C = pf1.applications.compendiumBrowser?.[cls];
    if (!C) continue;
    const original = C.prototype.render;
    C.prototype.render = function (...args) {
      if (!setting("replacePf1") || !allowed(tab)) return original.apply(this, args);
      open(tab);
      return this;
    };
  }
});
