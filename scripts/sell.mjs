// pf1-banana：快捷出售。
// 角色卡物品栏：每行操作栏多一个金币按钮（卖这一件，可选数量）；货币栏下面「出售物品」按钮打开批量出售
//   （勾选、全选、只选没装备的、只选财宝），两种都要在对话框里点「确认出售」才卖。
// 价格用 PF1 自己的 item.getValue({ sellValue })：普通物品按设置的比例（默认半价），财宝/贸易品全价，带次数的按剩余次数算，
//   损坏、陈旧按系统倍率；玩家看不到真名的未鉴定物品按未鉴定价卖（规则如此，GM 自己卖才按真价）。
// 钱加进普通货币（system.currency，Item Piles 商店只认这个），结果密语给 GM 和卖家。不能卖：没价钱的、装着东西的容器。
// 模组设置「角色卡上可以出售」打开才有这些按钮（默认关）。
// 钱币不计重量（pf1.coinWeight = 0）时，「货币无重量」那一行多余，里面没钱就藏起来。
import { MODULE } from "./const.mjs";

const busy = new Set();

const rate = () => game.settings.get(MODULE, "sellRate");
const sellable = (item) => item.isPhysical && !(item.type === "container" && item.items?.size) && item.getValue({ sellValue: rate() }) > 0;
const unitValue = (item) => item.getValue({ sellValue: rate(), single: true });
const valueOf = (item, n) => (n >= (item.system.quantity || 1) ? item.getValue({ sellValue: rate() }) : unitValue(item) * n);

const toCp = (gp) => Math.floor(gp * 100 + 1e-6);
export function fmt(gp) {
  const cp = toCp(gp);
  const parts = [[Math.floor(cp / 100), "gp"], [Math.floor((cp % 100) / 10), "sp"], [cp % 10, "cp"]].filter(([v]) => v);
  return parts.length ? parts.map(([v, u]) => `${v} ${u}`).join(" ") : "0";
}

async function sell(actor, lines) {
  if (busy.has(actor.id)) return;
  busy.add(actor.id);
  try {
    lines = lines.filter(({ item, n }) => n > 0 && actor.items.has(item.id));
    if (!lines.length) return;
    let total = 0;
    const del = [], upd = [];
    for (const l of lines) {
      l.gp = valueOf(l.item, l.n);
      total += l.gp;
      const q = l.item.system.quantity || 1;
      if (l.n >= q) del.push(l.item.id);
      else upd.push({ _id: l.item.id, "system.quantity": q - l.n });
    }
    const cp = toCp(total);
    const cur = actor.system.currency;
    await actor.update({
      "system.currency.gp": (cur.gp || 0) + Math.floor(cp / 100),
      "system.currency.sp": (cur.sp || 0) + Math.floor((cp % 100) / 10),
      "system.currency.cp": (cur.cp || 0) + (cp % 10),
    });
    if (upd.length) await actor.updateEmbeddedDocuments("Item", upd);
    if (del.length) await actor.deleteEmbeddedDocuments("Item", del);
    const rows = lines.map((l) => `<tr><td>${l.item.name}${l.n > 1 ? ` ×${l.n}` : ""}</td><td style="text-align:right">${fmt(l.gp)}</td></tr>`).join("");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [...new Set([...ChatMessage.getWhisperRecipients("GM").map((u) => u.id), game.user.id])],
      content: `<h3>出售物品</h3><table><tbody>${rows}</tbody><tfoot><tr><th>合计</th><th style="text-align:right">${fmt(total)}</th></tr></tfoot></table>`,
    });
    ui.notifications.info(`${actor.name} 卖出 ${lines.length} 件，得 ${fmt(total)}`);
  } finally {
    busy.delete(actor.id);
  }
}

const esc = (s) => foundry.utils.escapeHTML(String(s));

async function sellOne(actor, item) {
  const q = item.system.quantity || 1;
  const content = `<p><b>${esc(item.name)}</b>${item.system.equipped ? "（已装备）" : ""}</p>
    ${q > 1 ? `<div class="form-group"><label>数量（共 ${q}）</label><input type="number" name="n" value="${q}" min="1" max="${q}" step="1"></div>` : ""}
    <p>卖价：<b class="pb-sell-total">${fmt(valueOf(item, q))}</b></p>`;
  const n = await foundry.applications.api.DialogV2.wait({
    window: { title: "出售物品" },
    content,
    render: (event, dialog) => {
      const root = dialog?.element ?? event.target.element;
      const input = root.querySelector("input[name=n]");
      input?.addEventListener("input", () => {
        const v = Math.clamp(Math.floor(Number(input.value) || 0), 0, q);
        root.querySelector(".pb-sell-total").textContent = fmt(valueOf(item, v));
      });
    },
    buttons: [
      { action: "sell", label: "确认出售", icon: "fa-solid fa-coins", default: true,
        callback: (event, button) => Math.clamp(Math.floor(Number(button.form.elements.n?.value ?? q) || 0), 0, q) },
      { action: "cancel", label: "取消" },
    ],
    rejectClose: false,
  });
  if (typeof n === "number" && n > 0) await sell(actor, [{ item, n }]);
}

async function sellMany(actor) {
  const items = actor.items.filter(sellable).sort((a, b) => a.sort - b.sort);
  if (!items.length) return ui.notifications.warn("没有能卖的物品");
  const row = (i) => {
    const q = i.system.quantity || 1;
    return `<tr data-id="${i.id}">
      <td><input type="checkbox" name="pick"></td>
      <td>${esc(i.name)}${i.system.equipped ? ' <span class="pb-eq">已装备</span>' : ""}</td>
      <td>${q > 1 ? `<input type="number" name="n" value="${q}" min="1" max="${q}" step="1" style="width:4em">` : "1"}</td>
      <td class="pb-sub" style="text-align:right">${fmt(valueOf(i, q))}</td></tr>`;
  };
  const content = `<div class="pb-sell-picks" style="display:flex;gap:4px;margin-bottom:4px">
      <button type="button" data-pick="all">全选</button><button type="button" data-pick="none">全不选</button>
      <button type="button" data-pick="unequipped">只选没装备的</button><button type="button" data-pick="treasure">只选财宝/贸易品</button></div>
    <div style="max-height:420px;overflow-y:auto"><table class="pb-sell-table"><thead><tr><th></th><th>物品</th><th>数量</th><th>卖价</th></tr></thead>
    <tbody>${items.map(row).join("")}</tbody></table></div>
    <p style="text-align:right">已选 <b class="pb-sell-count">0</b> 件，合计 <b class="pb-sell-total">0</b></p>`;
  const picked = (root) => [...root.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector("input[name=pick]").checked).map((tr) => {
    const item = actor.items.get(tr.dataset.id);
    const q = item.system.quantity || 1;
    const input = tr.querySelector("input[name=n]");
    return { item, n: input ? Math.clamp(Math.floor(Number(input.value) || 0), 0, q) : 1 };
  });
  const lines = await foundry.applications.api.DialogV2.wait({
    window: { title: `出售物品：${actor.name}` },
    position: { width: 560 },
    content,
    render: (event, dialog) => {
      const root = dialog?.element ?? event.target.element;
      const sellBtn = root.querySelector('button[data-action="sell"]');
      const refresh = () => {
        for (const tr of root.querySelectorAll("tbody tr")) {
          const item = actor.items.get(tr.dataset.id);
          const input = tr.querySelector("input[name=n]");
          tr.querySelector(".pb-sub").textContent = fmt(valueOf(item, input ? Math.floor(Number(input.value) || 0) : 1));
        }
        const p = picked(root).filter((l) => l.n > 0);
        root.querySelector(".pb-sell-count").textContent = p.length;
        root.querySelector(".pb-sell-total").textContent = fmt(p.reduce((s, l) => s + valueOf(l.item, l.n), 0));
        sellBtn.disabled = !p.length;
      };
      const rule = {
        all: () => true, none: () => false,
        unequipped: (i) => !i.system.equipped,
        treasure: (i) => i.type === "loot" && ["treasure", "tradeGoods"].includes(i.subType),
      };
      root.querySelector(".pb-sell-picks").addEventListener("click", (ev) => {
        const f = rule[ev.target.dataset.pick];
        if (!f) return;
        for (const tr of root.querySelectorAll("tbody tr")) tr.querySelector("input[name=pick]").checked = f(actor.items.get(tr.dataset.id));
        refresh();
      });
      root.querySelector("tbody").addEventListener("input", refresh);
      refresh();
    },
    buttons: [
      { action: "sell", label: "确认出售", icon: "fa-solid fa-coins", callback: (event, button) => picked(button.form) },
      { action: "cancel", label: "取消" },
    ],
    rejectClose: false,
  });
  if (Array.isArray(lines)) await sell(actor, lines);
}

Hooks.on("renderActorSheetPF", (app, html) => {
  const actor = app.actor;
  if (actor?.type !== "character" || !actor.isOwner || !game.settings.get(MODULE, "sell")) return;
  const root = html[0] ?? html;
  const inv = root.querySelector('.tab[data-tab="inventory"]');
  if (!inv) return;
  // PF1 的操作栏固定 120px，正好放 7 个图标，多了出售按钮就把删除挤掉一半：整列（含表头）加宽一格
  inv.classList.add("pb-sell-on");
  const currencies = inv.querySelector("header .currencies");
  if (game.settings.get("pf1", "coinWeight") === 0 && !Object.values(actor.system.altCurrency ?? {}).some((v) => v)) {
    currencies?.querySelector("ol.currency.weightless")?.remove();
  }
  if (currencies && !inv.querySelector(".pb-sell-batch")) {
    const btn = document.createElement("a");
    btn.className = "pb-sell-batch";
    btn.innerHTML = '<i class="fa-solid fa-coins"></i> 出售物品';
    btn.style.cssText = "display:inline-block;margin:2px 0 4px;padding:1px 8px;border:1px solid var(--color-border-dark-4, #999);border-radius:3px";
    btn.addEventListener("click", (ev) => { ev.preventDefault(); sellMany(actor); });
    currencies.after(btn);
  }
  for (const li of inv.querySelectorAll("li.item[data-item-id]")) {
    const item = actor.items.get(li.dataset.itemId);
    const controls = li.querySelector(".item-controls");
    if (!item || !controls || controls.querySelector(".pb-sell") || !sellable(item)) continue;
    const a = document.createElement("a");
    a.className = "item-control pb-sell";
    a.dataset.tooltip = `出售（${fmt(item.getValue({ sellValue: rate() }))}）`;
    a.innerHTML = '<i class="fa-solid fa-coins" inert></i>';
    a.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); sellOne(actor, item); });
    const del = controls.querySelector(".item-delete");
    if (del) del.before(a);
    else controls.append(a);
  }
});
