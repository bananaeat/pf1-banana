// pf1-banana：资料浏览器里一键购买。
// 物品：合集包条目按书价（PF1 的 item.getValue，带次数的按满次数），买来先不穿戴。
// 法术：用 PF1 自己的 toConsumable 现做卷轴 / 药水 / 魔杖，价格也是它算的（环级 × 施法者等级 × 25 / 50 / 750，加昂贵材料）；
//   环级按选的职业，施法者等级可以往上调；药水限 3 环以下、魔杖限 4 环以下（核心规则；「药水只能做指定生物的法术」没检查）。
// 都要在对话框里选买家、数量，点「确认购买」才扣钱。钱从普通货币里扣，小面额不够就拆大面额找零；结果密语给 GM 和买家。
// GM 可以在资料浏览器顶上（或模组设置里）关掉购买，比如在地城里。
import { fmt } from "./sell.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const DIVINE = new Set(["牧师", "德鲁伊", "圣武士", "反圣武士", "游侠", "先知", "审判者", "战斗祭司", "萨满", "猎人"]);
const PSYCHIC = new Set(["异能者", "秘学士", "唤魂师", "通灵者", "催眠师"]);
const KINDS = { scroll: { label: "卷轴", max: 9 }, potion: { label: "药水", max: 3 }, wand: { label: "魔杖", max: 4 } };
const busy = new Set();
// 做卷轴 / 药水的最低施法者等级 = 这个职业能施放该环级的最低等级
const EVEN = new Set(["术士", "先知", "奥能师", "异能者"]);
const SIX = new Set(["吟游诗人", "歌者", "魔战士", "审判者", "炼金术师", "调查员", "召唤师", "召唤师（掉链）", "战斗祭司", "猎人", "催眠师", "唤魂师", "秘学士", "红螳螂杀手", "通灵者"]);
const FOUR = new Set(["圣武士", "反圣武士", "游侠", "血脉狂怒者"]);
const minCasterLevel = (cls, lv) => (FOUR.has(cls) ? 3 * lv + 1 : SIX.has(cls) ? 3 * lv - 2 : EVEN.has(cls) ? 2 * lv : 2 * lv - 1);

const buyers = () => game.actors.filter((a) => a.type === "character" && (game.user.isGM ? a.hasPlayerOwner : a.isOwner));
const defaultBuyer = () => {
  const list = buyers();
  const pick = [game.user.character, ...canvas.tokens?.controlled.map((t) => t.actor) ?? []].find((a) => a && list.includes(a));
  return pick ?? list[0];
};
const walletCp = (a) => {
  const c = a.system.currency;
  return (c.pp || 0) * 1000 + (c.gp || 0) * 100 + (c.sp || 0) * 10 + (c.cp || 0);
};
const toCp = (gp) => Math.round(gp * 100);

// 从小面额往大面额扣，多扣的按 gp / sp / cp 找回
function afterPaying(cur, cost) {
  const c = { pp: cur.pp || 0, gp: cur.gp || 0, sp: cur.sp || 0, cp: cur.cp || 0 };
  let need = cost;
  for (const [k, v] of [["cp", 1], ["sp", 10], ["gp", 100], ["pp", 1000]]) {
    if (need <= 0) break;
    const use = Math.min(c[k], Math.ceil(need / v));
    c[k] -= use;
    need -= use * v;
  }
  if (need > 0) return null;
  let change = -need;
  c.gp += Math.floor(change / 100);
  change %= 100;
  c.sp += Math.floor(change / 10);
  c.cp += change % 10;
  return c;
}

async function complete(actor, itemData, n, unitGp, label) {
  if (busy.has(actor.id)) return;
  busy.add(actor.id);
  try {
    const cost = toCp(unitGp) * n;
    const paid = afterPaying(actor.system.currency, cost);
    if (!paid) return ui.notifications.warn(`${actor.name} 的钱不够（要 ${fmt(cost / 100)}）`);
    await actor.update(Object.fromEntries(Object.entries(paid).map(([k, v]) => [`system.currency.${k}`, v])));
    await actor.createEmbeddedDocuments("Item", [itemData]);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [...new Set([...ChatMessage.getWhisperRecipients("GM").map((u) => u.id), game.user.id])],
      content: `<h3>购买物品</h3><p>${esc(label)}${n > 1 ? ` ×${n}` : ""}：<b>${fmt(cost / 100)}</b></p>`,
    });
    ui.notifications.info(`${actor.name} 买了 ${label}${n > 1 ? ` ×${n}` : ""}，花了 ${fmt(cost / 100)}`);
  } finally {
    busy.delete(actor.id);
  }
}

// 通用对话框：extra 是额外的表单行，price(form) 返回 { unit, ok, note }
async function dialog({ title, name, extra = "", qty = true, price }) {
  const list = buyers();
  if (!list.length) {
    ui.notifications.warn("你没有可以买东西的角色");
    return null;
  }
  const def = defaultBuyer();
  const content = `<p><b>${esc(name)}</b></p>
    <div class="form-group"><label>买家</label><select name="buyer">${list.map((a) => `<option value="${a.id}" ${a === def ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div>
    ${extra}
    ${qty ? '<div class="form-group"><label>数量</label><input type="number" name="n" value="1" min="1" step="1"></div>' : ""}
    <p class="pb-buy-sum"></p>`;
  const read = (form) => {
    const actor = game.actors.get(form.elements.buyer.value);
    const n = qty ? Math.max(1, Math.floor(Number(form.elements.n.value) || 1)) : 1;
    const p = price(form);
    const total = toCp(p.unit) * n;
    return { actor, n, ...p, total, enough: walletCp(actor) >= total };
  };
  return foundry.applications.api.DialogV2.wait({
    window: { title },
    position: { width: 420 },
    content,
    render: (event, dlg) => {
      const root = dlg?.element ?? event.target.element;
      const form = root.querySelector("form") ?? root;
      const btn = root.querySelector('button[data-action="buy"]');
      const upd = () => {
        const r = read(form);
        root.querySelector(".pb-buy-sum").innerHTML = r.ok
          ? `单价 ${fmt(r.unit)}，合计 <b>${fmt(r.total / 100)}</b>；${esc(r.actor.name)} 有 ${fmt(walletCp(r.actor) / 100)}${r.enough ? "" : ' <b style="color:#c03030">钱不够</b>'}`
          : `<b style="color:#c03030">${esc(r.note)}</b>`;
        btn.disabled = !r.ok || !r.enough;
      };
      form.addEventListener("input", upd);
      form.addEventListener("change", upd);
      upd();
    },
    buttons: [
      { action: "buy", label: "确认购买", icon: "fa-solid fa-cart-shopping", default: true, callback: (event, button) => read(button.form) },
      { action: "cancel", label: "取消" },
    ],
    rejectClose: false,
  });
}

export async function buyItem(row) {
  const doc = await fromUuid(row.uuid);
  if (!doc) return ui.notifications.warn("读不到合集包条目");
  const unit = doc.getValue({ sellValue: 1, single: true, maximized: true });
  if (!(unit > 0)) return ui.notifications.warn(`${doc.name} 没有标价，买不了`);
  const r = await dialog({ title: "购买物品", name: doc.name, price: () => ({ unit, ok: true }) });
  if (!r?.actor || !r.ok) return;
  const data = doc.toObject();
  delete data._id;
  foundry.utils.setProperty(data, "system.quantity", r.n);
  foundry.utils.setProperty(data, "system.identified", true);
  if (foundry.utils.hasProperty(data, "system.equipped")) data.system.equipped = false; // 合集包里很多是默认穿戴的，买来先放包里
  await complete(r.actor, data, r.n, unit, doc.name);
}

export async function buySpell(row) {
  const spell = await fromUuid(row.uuid);
  if (!spell) return ui.notifications.warn("读不到合集包里的法术");
  const S = CONFIG.Item.documentClasses.spell;
  const [minSl] = S.getMinimumCasterLevelBySpellData(spell.toObject());
  // 环级选项：维基上的职业环级（同一环级的职业合在一起），没有就用 PF1 算的最低环级
  const byLevel = new Map();
  for (const [cls, lv] of Object.entries(row.cl ?? {})) {
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(cls);
  }
  if (!byLevel.size) byLevel.set(minSl ?? spell.system.level ?? 1, []);
  const levels = [...byLevel].sort((a, b) => a[0] - b[0]);
  const typeOf = (classes) => (classes.some((c) => DIVINE.has(c)) && !classes.some((c) => !DIVINE.has(c) && !PSYCHIC.has(c)) ? "divine"
    : classes.length && classes.every((c) => PSYCHIC.has(c)) ? "psychic" : "arcane");
  const options = levels.flatMap(([lv, classes]) => {
    const groups = classes.length ? [["arcane", classes.filter((c) => !DIVINE.has(c) && !PSYCHIC.has(c))], ["divine", classes.filter((c) => DIVINE.has(c))],
      ["psychic", classes.filter((c) => PSYCHIC.has(c))]].filter(([, cs]) => cs.length) : [[typeOf(classes), classes]];
    return groups.map(([type, cs]) => ({ lv, type, cls: cs, label: `${lv} 环${cs.length ? `（${cs.slice(0, 4).join("、")}${cs.length > 4 ? "…" : ""}）` : ""}` }));
  });
  const clFor = (o) => (o.lv <= 0 ? 1 : Math.min(...(o.cls.length ? o.cls : ["法师"]).map((c) => minCasterLevel(c, o.lv))));
  const TYPES = { arcane: "奥术", divine: "神术", psychic: "异能" };
  const extra = `
    <div class="form-group"><label>种类</label><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></div>
    <div class="form-group"><label>环级</label><select name="opt">${options.map((o, i) => `<option value="${i}">${esc(o.label)} · ${TYPES[o.type]}</option>`).join("")}</select></div>
    <div class="form-group"><label>施法者等级</label><input type="number" name="cl" value="${clFor(options[0])}" min="1" max="20" step="1"></div>`;
  const cache = new Map();
  const make = async (kind, o, cl) => {
    const key = `${kind}|${o.lv}|${o.type}|${cl}`;
    if (!cache.has(key)) cache.set(key, await S.toConsumable({ ...spell.toObject(), sl: o.lv, cl }, kind, { spellType: o.type }));
    return cache.get(key);
  };
  const unitOf = (data) => new Item.implementation(data).getValue({ sellValue: 1, single: true, maximized: true });
  // toConsumable 是异步的：没算过的组合先显示「计算价格…」，算完再触发一次刷新
  const r = await dialog({
    title: "购买卷轴 / 药水 / 魔杖", name: spell.name, extra,
    price: (form) => {
      const o = options[Number(form.elements.opt.value)];
      const kind = form.elements.kind.value;
      // 施法者等级不能低于这个环级的最低值（换到更高环级时自动抬上去）
      const minimum = clFor(o);
      if (!(Number(form.elements.cl.value) >= minimum)) form.elements.cl.value = minimum;
      const cl = Math.clamp(Number(form.elements.cl.value), minimum, 20);
      form.elements.n.disabled = kind === "wand";
      if (kind === "wand") form.elements.n.value = 1;
      if (o.lv > KINDS[kind].max) return { ok: false, note: `${o.lv} 环法术不能做成${KINDS[kind].label}（最高 ${KINDS[kind].max} 环）` };
      const key = `${kind}|${o.lv}|${o.type}|${cl}`;
      const data = cache.get(key);
      if (!data) {
        make(kind, o, cl).then(() => form.dispatchEvent(new Event("change")));
        return { ok: false, note: "计算价格…" };
      }
      return { ok: true, unit: unitOf(data), kind, o, cl };
    },
  });
  if (!r?.actor || !r.ok) return;
  const data = foundry.utils.deepClone(await make(r.kind, r.o, r.cl));
  const n = r.kind === "wand" ? 1 : r.n;
  data.system.quantity = n;
  await complete(r.actor, data, n, r.unit, data.name);
}
