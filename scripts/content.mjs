// pf1-banana：资料浏览器的内容设置（模组设置里的「资料浏览器内容」按钮）。
// - 合集包：每个分页从哪些合集包取条目（能拖进角色卡、能买的就是这些）。没勾的合集包，维基条目照样能看，只是对不上合集包。
//   玩家另外还受 Foundry 自己的合集包权限限制：玩家看不到的合集包，对玩家来说等于没勾。
// - 来源书限制：只给玩家看指定来源书的条目（比如只开核心规则书），可选应用到哪些分页、维基上没有的合集包条目给不给看、GM 是否也受限。
import { MODULE } from "./const.mjs";

export const TAB_LABELS = { spells: "法术", feats: "专长", traits: "特性", items: "物品", monsters: "怪物/NPC" };

// 默认用的合集包（没装的模组自动跳过）
const DEFAULT_PACKS = {
  spells: ["pf1.spells"],
  feats: ["pf1.feats", "pf-content.pf-feats"],
  traits: ["pf-content.pf-traits"],
  items: ["pf1.items", "pf1.weapons-and-ammo", "pf1.armors-and-shields", "pf1.technology", "pf-content.pf-items", "pf-content.pf-magic-items",
    "pf-content.pf-wondrous", "pf-content.pf-artifacts", "pf-content.pf-cursed-items", "pf-content.pf-intelligent-items"],
  monsters: null, // pf1-zh-monsters 的全部角色合集包
};
const defaultPacks = (tab) => DEFAULT_PACKS[tab]
  ?? game.packs.filter((p) => p.metadata.packageName === "pf1-zh-monsters" && p.documentName === "Actor").map((p) => p.collection);
const candidates = (tab) => game.packs.filter((p) => p.documentName === (tab === "monsters" ? "Actor" : "Item"));

export const DEFAULT_CONTENT = { packs: {}, limit: false, books: ["核心规则书"], limitTabs: ["spells", "feats", "traits", "items", "monsters"], unknown: false, gm: false };
export const content = () => foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_CONTENT), game.settings.get(MODULE, "content") ?? {}, { inplace: false });

// 当前用户在这个分页能用的合集包
export function packsFor(tab) {
  const ids = content().packs[tab] ?? defaultPacks(tab);
  return ids.map((id) => game.packs.get(id)).filter((p) => p && (game.user.isGM || p.testUserPermission(game.user, "OBSERVER")));
}

// 来源书限制：返回过滤函数，不限制时返回 null
export function sourceFilter(tab) {
  const c = content();
  if (!c.limit || (game.user.isGM && !c.gm) || !c.limitTabs.includes(tab)) return null;
  const books = new Set(c.books);
  return (r) => (r.src?.length ? r.src.some((b) => books.has(b)) : c.unknown);
}

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const playerCanSee = (p) => (CONST.DOCUMENT_OWNERSHIP_LEVELS[p.ownership?.PLAYER] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;

export class ContentConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pb-content-config",
    tag: "form",
    window: { title: "资料浏览器内容", icon: "fa-solid fa-filter", resizable: true },
    position: { width: 640, height: 720 },
    form: { handler: ContentConfig.#save, closeOnSubmit: true },
  };

  async _renderHTML() {
    const c = content();
    const res = await fetch(`modules/${MODULE}/data/meta.json`, { cache: "no-cache" });
    const meta = await res.json();
    // 每本书在各分页的条数合计，按条数排
    const total = new Map();
    for (const t of Object.values(meta.tabs)) for (const [b, n] of Object.entries(t.books ?? {})) total.set(b, (total.get(b) ?? 0) + n);
    const books = [...total].sort((a, b) => b[1] - a[1]);
    const chosen = new Set(c.books);
    const div = document.createElement("div");
    div.className = "pb-content";
    div.innerHTML = `
      <fieldset><legend>来源书限制</legend>
        <label class="pb-c-row"><input type="checkbox" name="limit" ${c.limit ? "checked" : ""}> 只给玩家看下面勾选的来源书里的条目</label>
        <div class="pb-c-row">应用到：${Object.entries(TAB_LABELS).map(([k, l]) => `<label><input type="checkbox" name="limitTabs" value="${k}" ${c.limitTabs.includes(k) ? "checked" : ""}> ${l}</label>`).join(" ")}</div>
        <label class="pb-c-row"><input type="checkbox" name="unknown" ${c.unknown ? "checked" : ""}> 维基上没有、来源不明的合集包条目也给看</label>
        <label class="pb-c-row"><input type="checkbox" name="gm" ${c.gm ? "checked" : ""}> GM 也按这个限制</label>
        <div class="pb-c-row pb-c-tools">
          <button type="button" data-books="core">只要核心规则书</button><button type="button" data-books="none">全不选</button>
          <input type="search" class="pb-c-q" placeholder="找书…"> <span class="pb-c-n"></span>
        </div>
        <div class="pb-c-books">${books.map(([b, n]) => `<label data-b="${esc(b)}"><input type="checkbox" name="books" value="${esc(b)}" ${chosen.has(b) ? "checked" : ""}> ${esc(b)} <span>${n}</span></label>`).join("")}</div>
      </fieldset>
      <fieldset><legend>合集包</legend>
        <p class="hint">每个分页从哪些合集包取条目（能拖进角色卡、能购买的就是这些）。没勾的合集包里的条目，维基资料照样能看，只是不能拖。
          标「玩家看不到」的合集包，玩家那边当作没勾（在 Foundry 的合集包权限里改）。</p>
        ${Object.entries(TAB_LABELS).map(([tab, label]) => {
          const on = new Set(c.packs[tab] ?? defaultPacks(tab));
          const list = candidates(tab).sort((a, b) => Number(on.has(b.collection)) - Number(on.has(a.collection)) || a.title.localeCompare(b.title, "zh"));
          return `<details><summary>${label}（已勾 ${list.filter((p) => on.has(p.collection)).length} 个）</summary><div class="pb-c-packs">
            ${list.map((p) => `<label><input type="checkbox" name="packs.${tab}" value="${p.collection}" ${on.has(p.collection) ? "checked" : ""}>
              ${esc(p.title)} <span>${p.collection}</span>${playerCanSee(p) ? "" : ' <em>玩家看不到</em>'}</label>`).join("")}
            </div></details>`;
        }).join("")}
      </fieldset>
      <footer class="form-footer"><button type="submit"><i class="fa-solid fa-floppy-disk"></i> 保存</button></footer>`;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const box = result.querySelector(".pb-c-books");
    const count = () => (result.querySelector(".pb-c-n").textContent = `已选 ${box.querySelectorAll("input:checked").length} 本`);
    box.addEventListener("change", count);
    count();
    result.querySelector(".pb-c-q").addEventListener("input", (ev) => {
      const q = ev.target.value.trim();
      for (const l of box.children) l.hidden = q && !l.dataset.b.includes(q);
    });
    result.querySelector(".pb-c-tools").addEventListener("click", (ev) => {
      const mode = ev.target.dataset.books;
      if (!mode) return;
      for (const i of box.querySelectorAll("input")) i.checked = mode === "core" && i.value === "核心规则书";
      count();
    });
  }

  static async #save(event, form) {
    const all = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
    const packs = {};
    for (const tab of Object.keys(TAB_LABELS)) packs[tab] = all(`packs.${tab}`);
    await game.settings.set(MODULE, "content", {
      packs, limit: form.elements.limit.checked, books: all("books"), limitTabs: all("limitTabs"),
      unknown: form.elements.unknown.checked, gm: form.elements.gm.checked,
    });
  }
}
