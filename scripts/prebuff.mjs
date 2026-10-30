// pf1-banana：战前准备（pre-buff 管理）。
// 每个角色存一份「战前方案」（actor flag pf1-banana.prebuff），每行是一个来源 + 目标 + 勾选：
//   - spell：按英文名记，施放时找一份还有环位 / 准备次数的同名法术；
//   - item：卷轴 / 药水 / 魔杖 / 职业能力等，按物品 id 记，用掉就没了；
//   - buff：角色卡上现成的增益，直接打开，不消耗。
// 一键施放：每行走 PF1 正常的「使用」（item.use，跳过对话框），系统自己扣环位 / 次数 / 数量并发施法卡；
//   法术和法术消耗品再给目标挂上同名增益（按英文名先找目标卡上现有的，再找增益合集包），等级 = 施法者等级、开始时间 = 现在。
//   Nevela 自动化已经挂上的不重复挂。给别的玩家的角色挂增益要 GM 在线（走 CONFIG.queries，由主 GM 执行）。
// 状态：全队生效中的增益和剩余时间（增益的追踪效果 duration.remaining），快到期的标出来。
// 打开：快捷键 P、角色 token HUD 的盾牌按钮、api.prebuff()；GM 建遭遇（加入战斗、还没开始）时，在场 PC 的玩家自动弹出；
//   GM 在窗口里可以让所有在线玩家打开。玩家自己勾、自己点确认，不走 GM 结算卡。
import { MODULE } from "./const.mjs";

const FLAG = "prebuff";
const BUFF_PACKS = ["pf1.buffs", "pf-content.pf-buffs", "nevelas-automation-suite.Buffs"];
const LONG_UNITS = new Set(["minute", "hour", "day", "perm", "spec"]);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const norm = (s) => (s ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]/g, "");
const setting = (key) => game.settings.get(MODULE, key);

// ---------- 英文名与增益 ----------
function englishOf(item) {
  const raw = item.flags?.babele?.originalName ?? item.name.match(/\(([^()]*[A-Za-z][^()]*)\)/)?.[1] ?? item.name;
  return raw.replace(/^(scroll|potion|wand|oil|staff) of /i, "").replace(/\s*\((cl|CL) ?\d+\)\s*$/, "").trim();
}

let buffIndexP = null;
function buffIndex() {
  buffIndexP ??= (async () => {
    const map = new Map();
    const extra = game.modules.get("nevelas-automation-suite")?.active ? game.settings.get("nevelas-automation-suite", "customBuffCompendia") ?? [] : [];
    for (const id of new Set([...BUFF_PACKS, ...extra])) {
      const pack = game.packs.get(id);
      if (!pack) continue;
      for (const e of await pack.getIndex()) {
        const k = canon(norm(e.originalName ?? e.name.match(/\(([^()]*)\)\s*$/)?.[1] ?? e.name));
        if (k && !map.has(k)) map.set(k, e.uuid);
      }
    }
    return map;
  })();
  return buffIndexP;
}

// 共用 / 群体版本用本体的增益（合集包里只有本体，比如共用防护邪恶 → 防护邪恶）
const canon = (k) => k.replace(/(communal|mass)$/, "").replace(/^(communal|mass)/, "");
// spellKey 认是哪个法术（共用版和本体是两行）；buffKey 认挂哪个增益（共用版挂本体的）
const spellKey = (item) => norm(englishOf(item));
const buffKey = (item) => canon(spellKey(item));
const ownBuff = (actor, key) => actor.items.find((i) => i.type === "buff" && buffKey(i) === canon(key));
// 剩余秒数；没有计时的（「直到放出」「持续」之类）当作一直有效
const remaining = (buff) => {
  if (!buff?.system.active) return null;
  const d = buff.effect?.duration;
  return d?.seconds ? d.remaining : Infinity;
};

function fmtTime(sec) {
  if (sec == null) return "";
  if (!Number.isFinite(sec)) return "持续";
  if (sec < 60) return `${Math.max(0, Math.ceil(sec / 6))} 轮`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

// 给角色挂增益（在有权限的客户端执行）：已有就改等级、重设开始时间并打开，没有就从合集包建
async function applyBuffHere(actor, key, level) {
  const now = game.time.worldTime;
  const existing = ownBuff(actor, key);
  if (existing) {
    await existing.update({ "system.level": level, "system.duration.start": now, "system.active": true });
    return existing.name;
  }
  const uuid = (await buffIndex()).get(canon(key));
  if (!uuid) return null;
  const data = (await fromUuid(uuid)).toObject();
  delete data._id;
  foundry.utils.mergeObject(data, { system: { level, active: true, duration: { start: now } } });
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created?.name ?? null;
}

async function applyBuff(actor, key, level) {
  if (actor.isOwner) return applyBuffHere(actor, key, level);
  const gm = game.users.activeGM;
  if (!gm) throw new Error("GM 不在线，挂不了别人的增益");
  return gm.query(`${MODULE}.applyBuff`, { actorUuid: actor.uuid, key, level }, { timeout: 20000 });
}

// ---------- 方案 ----------
const party = () => game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
const plan = (actor) => foundry.utils.deepClone(actor.getFlag(MODULE, FLAG)?.rows ?? []);
const savePlan = (actor, rows) => actor.setFlag(MODULE, FLAG, { rows });

const isSelfOnly = (item) => item.system.actions?.[0]?.range?.units === "personal";
// 一次施放就能覆盖多个目标的（有范围或目标写着「多个 / 所有 / 盟友」，比如祝福术、共用防护邪恶）；
// 其他的一个目标施放一次，选了几个人就消耗几次
function isGroup(item) {
  const a = item.system.actions?.[0];
  if (!a) return false;
  if (a.area || a.measureTemplate?.type) return true;
  return /多个|所有|盟友|每|最多|communal|creatures/i.test(a.target?.value ?? "") || /communal/i.test(englishOf(item));
}
const durationUnits = (item) => item.system.actions?.[0]?.duration?.units;

// 一行对应到角色身上现在能用的物品
function resolve(actor, row) {
  if (row.kind === "spell") {
    const all = actor.items.filter((i) => i.type === "spell" && spellKey(i) === row.key);
    const usable = all.filter((i) => i.canUse && (i.charges > 0 || !i.isCharged || i.getDefaultChargeCost?.() === 0));
    const left = usable.reduce((s, i) => s + (i.getDefaultChargeCost?.() === 0 ? Infinity : i.charges), 0);
    return { item: usable[0] ?? all[0] ?? null, ok: !!usable.length, left };
  }
  const item = actor.items.get(row.id);
  if (!item) return { item: null, ok: false, left: 0 };
  if (row.kind === "buff") return { item, ok: true, left: Infinity };
  const left = item.type === "consumable" ? (item.subType === "wand" ? item.system.uses?.value ?? 0 : item.system.quantity ?? 0)
    : item.system.uses?.per ? item.system.uses.value ?? 0 : Infinity;
  return { item, ok: item.canUse !== false && left > 0, left };
}

function costLabel(row, r) {
  if (!r.item) return "没有了";
  if (row.kind === "buff") return "不消耗";
  if (!Number.isFinite(r.left)) return "戏法";
  const it = r.item;
  if (row.kind === "spell") return `${it.system.level} 环，剩 ${r.left}`;
  if (it.type === "consumable" && it.subType === "wand") return `魔杖剩 ${it.system.uses?.value ?? r.left} 发`;
  if (it.type === "consumable") return `剩 ${r.left} 个`;
  return it.system.uses?.per ? `剩 ${it.system.uses.value ?? 0} 次` : "";
}

// 候选：有对应增益的法术、法术消耗品、角色卡上的临时 / 物品增益
async function candidates(actor, rows) {
  const idx = await buffIndex();
  const have = new Set(rows.map((r) => (r.kind === "spell" ? `spell:${r.key}` : r.id)));
  const out = [];
  const seen = new Set();
  for (const i of actor.items) {
    if (i.type === "spell") {
      const key = spellKey(i);
      if (seen.has(key) || have.has(`spell:${key}`) || !(idx.has(canon(key)) || ownBuff(actor, key)) || !LONG_UNITS.has(durationUnits(i))) continue;
      if (!(i.maxCharges > 0 || i.getDefaultChargeCost?.() === 0)) continue;
      seen.add(key);
      out.push({ kind: "spell", key, name: i.name, img: i.img, self: isSelfOnly(i) });
    } else if (i.type === "consumable" && ["potion", "scroll", "wand"].includes(i.subType)) {
      const key = buffKey(i);
      if (have.has(i.id) || !(idx.has(key) || ownBuff(actor, key))) continue;
      out.push({ kind: "item", id: i.id, key, name: i.name, img: i.img, self: i.subType === "potion" });
    } else if (i.type === "buff" && ["temp", "item"].includes(i.subType) && !have.has(i.id)) {
      // 法术类增益（别人施放挂上来的祝福术之类）不能当免费开关，只列临时 / 物品增益
      out.push({ kind: "buff", id: i.id, key: buffKey(i), name: i.name, img: i.img, self: true });
    }
  }
  return out;
}

// ---------- 施放 ----------
const busy = new Set();

async function withTargets(tokens, fn) {
  const before = [...game.user.targets].map((t) => t.id);
  canvas.tokens?.placeables.forEach((t) => t.targeted.has(game.user) && t.setTarget(false, { releaseOthers: false, groupSelection: true }));
  tokens.forEach((t, k) => t.setTarget(true, { releaseOthers: k === 0, groupSelection: true }));
  try {
    return await fn();
  } finally {
    canvas.tokens?.placeables.forEach((t) => t.setTarget(before.includes(t.id), { releaseOthers: false, groupSelection: true }));
  }
}

const targetActors = (actor, row, self) => (self || !row.targets?.length || row.targets.includes("self") ? [actor] : [])
  .concat(self ? [] : (row.targets ?? []).filter((t) => t !== "self").map((id) => game.actors.get(id)).filter(Boolean))
  .filter((a, k, arr) => arr.indexOf(a) === k);

async function castRow(actor, row) {
  const first = resolve(actor, row);
  if (!first.ok) return [`✘ ${row.name}：${first.item ? "用完了" : "找不到"}`];
  if (row.kind === "buff") {
    await first.item.update({ "system.duration.start": game.time.worldTime, "system.active": true });
    return [`✔ ${first.item.name}`];
  }
  const self = row.kind === "spell" ? isSelfOnly(first.item) : first.item.subType === "potion";
  const targets = targetActors(actor, row, self);
  // 群体法术施放一次，单体法术每个目标一次
  const casts = self || isGroup(first.item) ? [targets] : targets.map((t) => [t]);
  const out = [];
  for (const group of casts) {
    const r = resolve(actor, row);
    if (!r.ok) {
      out.push(`✘ ${row.name} → ${group.map((t) => t.name).join("、")}：用完了`);
      continue;
    }
    out.push(await castOnce(actor, row, r.item, group));
  }
  return out;
}

async function castOnce(actor, row, item, targets) {
  const tokens = targets.map((a) => a.getActiveTokens(false, true)[0]?.object ?? a.getActiveTokens()[0]).filter(Boolean);
  const token = actor.getActiveTokens(false, true)[0];
  const level = row.kind === "spell" ? (item.casterLevel ?? item.system.cl ?? 1) : (item.system.cl || 1);
  // 战前施放不放测量模板（祝福术之类有范围的会停在「请放置模板」上等人点地图），目标已经选好了
  const hookId = Hooks.on("pf1CreateActionUse", (au) => {
    if (au.item === item) au.shared.useMeasureTemplate = false;
  });
  let use;
  try {
    use = await withTargets(tokens, () => item.use({ skipDialog: true, token, chatMessage: true }));
  } finally {
    Hooks.off("pf1CreateActionUse", hookId);
  }
  if (use?.err || use === undefined) return `✘ ${item.name}：没有用出去`;
  if (row.kind === "item" && !["potion", "scroll", "wand"].includes(item.subType)) return `✔ ${item.name}`;
  const key = row.key ?? buffKey(item);
  // Nevela 自动化可能已经在挂了，等一下再看
  await new Promise((res) => setTimeout(res, 1200));
  const got = [];
  for (const t of targets) {
    const b = ownBuff(t, key);
    if (b?.system.active && b.system.duration?.start === game.time.worldTime) {
      got.push(t.name);
      continue;
    }
    try {
      const name = await applyBuff(t, key, level);
      got.push(name ? t.name : `${t.name}（没找到增益）`);
    } catch (err) {
      got.push(`${t.name}（${err.message}）`);
    }
  }
  return `✔ ${item.name} → ${got.join("、")}`;
}

async function castAll(actor, rows) {
  if (busy.has(actor.id)) return;
  busy.add(actor.id);
  const lines = [];
  try {
    for (const row of rows) {
      try {
        lines.push(...(await castRow(actor, row)));
      } catch (err) {
        console.error(`${MODULE} | 战前准备`, err);
        lines.push(`✘ ${row.name}：${err.message}`);
      }
    }
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      whisper: [...new Set([...ChatMessage.getWhisperRecipients("GM").map((u) => u.id), game.user.id])],
      content: `<h3>战前准备</h3><p>${lines.map(esc).join("<br>")}</p>`,
    });
  } finally {
    busy.delete(actor.id);
  }
  return lines;
}

// ---------- 窗口 ----------
class PrebuffApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "pb-prebuff",
    classes: ["pb-prebuff"],
    window: { title: "战前准备", icon: "fa-solid fa-shield-halved", resizable: true },
    position: { width: 640, height: 720 },
  };

  actor = null;
  note = "";

  async _renderHTML() {
    const actor = this.actor;
    const div = document.createElement("div");
    div.className = "pb-pre";
    if (!actor) {
      div.innerHTML = '<p class="pb-pre-empty">你没有能用的角色。</p>';
      return div;
    }
    const mine = party().filter((a) => a.isOwner);
    const rows = plan(actor);
    const cands = await candidates(actor, rows);
    const allies = party();
    const status = allies.map((a) => {
      const bs = a.items.filter((i) => i.type === "buff" && i.system.active && i.subType !== "perm")
        .map((b) => ({ b, t: remaining(b) })).sort((x, y) => (x.t ?? Infinity) - (y.t ?? Infinity));
      return { a, bs };
    }).filter((s) => s.bs.length);
    const targetLabel = (row) => {
      const ts = row.targets?.length ? row.targets : ["self"];
      if (allies.length > 2 && allies.every((a) => ts.includes(a === actor ? "self" : a.id))) return "全队";
      return ts.map((t) => (t === "self" ? "自己" : game.actors.get(t)?.name ?? "?")).join("、");
    };
    const rowHtml = rows.map((row, k) => {
      const r = resolve(actor, row);
      const self = row.kind === "buff" || (r.item && (row.kind === "spell" ? isSelfOnly(r.item) : r.item.subType === "potion"));
      const on = targetActors(actor, row, self).every((t) => remaining(ownBuff(t, row.key)) > 0);
      return `<li class="pb-pre-row ${r.ok ? "" : "pb-off"}" data-k="${k}">
        <input type="checkbox" class="pb-pick" ${row.on && r.ok ? "checked" : ""} ${r.ok ? "" : "disabled"}>
        <img src="${esc(r.item?.img ?? row.img ?? "icons/svg/mystery-man.svg")}" alt="">
        <span class="pb-pre-name">${esc(row.name)}${on ? ' <span class="pb-tag pb-tag-on">生效中</span>' : ""}</span>
        <span class="pb-pre-cost">${esc(costLabel(row, r))}</span>
        ${self ? '<span class="pb-pre-tgt pb-fixed">自己</span>'
          : `<details class="pb-pre-tgt"><summary>${esc(targetLabel(row))}</summary><div>
              ${allies.map((a) => `<label><input type="checkbox" data-t="${a === actor ? "self" : a.id}" ${(row.targets?.length ? row.targets : ["self"]).includes(a === actor ? "self" : a.id) ? "checked" : ""}> ${esc(a.name)}</label>`).join("")}
            </div></details>`}
        <a class="pb-pre-del" data-tooltip="从方案里去掉"><i class="fa-solid fa-xmark"></i></a></li>`;
    }).join("");
    div.innerHTML = `
      <div class="pb-pre-head">
        ${mine.length > 1 ? `<select class="pb-pre-actor">${mine.map((a) => `<option value="${a.id}" ${a === actor ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select>` : `<b>${esc(actor.name)}</b>`}
        ${game.combat?.started ? '<span class="pb-pre-warn">战斗已开始：每个法术照常要花动作</span>' : ""}
        ${game.user.isGM ? '<button type="button" class="pb-pre-all"><i class="fa-solid fa-bullhorn"></i> 让所有玩家打开</button>' : ""}
      </div>
      <h4>生效中的增益</h4>
      ${status.length ? `<ul class="pb-pre-status">${status.map(({ a, bs }) => `<li><b>${esc(a.name)}</b>：${bs.map(({ b, t }) =>
        `<span class="pb-tag ${t != null && t < 60 ? "pb-tag-warn" : ""}">${esc(b.name)} ${esc(fmtTime(t))}</span>`).join(" ")}</li>`).join("")}</ul>` : '<p class="pb-pre-empty">没有</p>'}
      <h4>我的方案 <span class="pb-pre-hint">从角色卡把法术、卷轴、药水、能力拖进来也行</span></h4>
      <ol class="pb-pre-plan">${rowHtml || '<p class="pb-pre-empty">还没有，从下面加</p>'}</ol>
      <h4>可以加入</h4>
      <ul class="pb-pre-cands">${cands.map((c, k) => `<li data-c="${k}"><a class="pb-pre-add"><i class="fa-solid fa-plus"></i></a>
        <img src="${esc(c.img)}" alt=""> ${esc(c.name)} <span class="pb-pre-kind">${c.kind === "spell" ? "法术" : c.kind === "buff" ? "增益" : "物品"}</span></li>`).join("") || '<p class="pb-pre-empty">没有别的了</p>'}</ul>
      <footer class="pb-pre-foot">${this.note ? `<div class="pb-pre-note">${this.note}</div>` : ""}
        <button type="button" class="pb-pre-go"><i class="fa-solid fa-wand-magic-sparkles"></i> 施放勾选的</button></footer>`;
    this._cands = cands;
    return div;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    const actor = this.actor;
    if (!actor) return;
    const rows = () => plan(actor);
    const save = async (fn) => {
      const rs = rows();
      fn(rs);
      await savePlan(actor, rs);
      this.render();
    };
    result.querySelector(".pb-pre-actor")?.addEventListener("change", (ev) => {
      this.actor = game.actors.get(ev.target.value);
      this.render();
    });
    result.querySelector(".pb-pre-all")?.addEventListener("click", () => openForPlayers());
    result.querySelector(".pb-pre-cands").addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-c]");
      if (!li || !ev.target.closest(".pb-pre-add")) return;
      const c = this._cands[+li.dataset.c];
      const item = c.kind === "spell" ? actor.items.find((i) => i.type === "spell" && spellKey(i) === c.key) : actor.items.get(c.id);
      const targets = !c.self && item && isGroup(item) ? party().map((a) => (a === actor ? "self" : a.id)) : ["self"];
      save((rs) => rs.push({ kind: c.kind, key: c.key, id: c.id, name: c.name, img: c.img, targets, on: true }));
    });
    const plan$ = result.querySelector(".pb-pre-plan");
    plan$.addEventListener("click", (ev) => {
      const li = ev.target.closest("li[data-k]");
      if (li && ev.target.closest(".pb-pre-del")) save((rs) => rs.splice(+li.dataset.k, 1));
    });
    plan$.addEventListener("change", (ev) => {
      const li = ev.target.closest("li[data-k]");
      if (!li) return;
      const k = +li.dataset.k;
      if (ev.target.classList.contains("pb-pick")) return save((rs) => (rs[k].on = ev.target.checked));
      if (ev.target.dataset.t) {
        const ts = [...li.querySelectorAll("input[data-t]:checked")].map((i) => i.dataset.t);
        return save((rs) => (rs[k].targets = ts.length ? ts : ["self"]));
      }
    });
    // 从角色卡拖物品进来
    result.addEventListener("dragover", (ev) => ev.preventDefault());
    result.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
      const item = data?.uuid ? await fromUuid(data.uuid) : null;
      if (!(item instanceof Item) || item.parent !== actor) return ui.notifications.warn("只能拖这个角色自己身上的东西");
      const kind = item.type === "spell" ? "spell" : item.type === "buff" ? "buff" : "item";
      save((rs) => rs.push({ kind, key: kind === "spell" ? spellKey(item) : buffKey(item), id: kind === "spell" ? undefined : item.id, name: item.name, img: item.img, targets: ["self"], on: true }));
    });
    result.querySelector(".pb-pre-go").addEventListener("click", () => this.#go());
  }

  async #go() {
    const actor = this.actor;
    const picked = plan(actor).filter((row) => row.on && resolve(actor, row).ok);
    if (!picked.length) return ui.notifications.warn("没有勾选能施放的");
    const list = picked.map((row) => {
      const r = resolve(actor, row);
      const self = row.kind === "buff" || (row.kind === "spell" ? isSelfOnly(r.item) : r.item.subType === "potion");
      const n = self || isGroup(r.item) ? 1 : targetActors(actor, row, false).length;
      const unit = row.kind === "spell" ? `个 ${r.item.system.level} 环` : r.item.subType === "wand" ? " 发" : r.item.type === "consumable" ? " 个" : " 次";
      const cost = row.kind === "buff" ? "不消耗" : !Number.isFinite(r.left) ? "戏法，不消耗" : `${n}${unit}${n > r.left ? `（只剩 ${r.left}，不够的跳过）` : ""}`;
      return `<li>${esc(row.name)}：${esc(cost)}</li>`;
    }).join("");
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "战前准备" },
      content: `<p>要施放 ${picked.length} 项，会消耗：</p><ul>${list}</ul>`,
      yes: { label: "确认施放", icon: "fa-solid fa-wand-magic-sparkles" },
      no: { label: "取消" },
    });
    if (!ok) return;
    const lines = await castAll(actor, picked);
    if (lines) this.note = lines.map(esc).join("<br>");
    this.render();
  }
}

let app = null;

export async function openPrebuff(actor = null) {
  if (!setting("prebuff")) return;
  const mine = party().filter((a) => a.isOwner);
  actor ??= [game.user.character, ...(canvas.tokens?.controlled.map((t) => t.actor) ?? [])].find((a) => a && mine.includes(a)) ?? mine[0] ?? null;
  app ??= new PrebuffApp();
  app.actor = actor;
  app.note = "";
  await app.render({ force: true });
  return app;
}

async function openForPlayers() {
  const users = game.users.filter((u) => u.active && !u.isGM);
  await Promise.allSettled(users.map((u) => u.query(`${MODULE}.openPrebuff`, {}, { timeout: 10000 })));
  ui.notifications.info(`已让 ${users.length} 名在线玩家打开战前准备`);
}

export function registerPrebuff() {
  CONFIG.queries[`${MODULE}.openPrebuff`] = () => {
    openPrebuff();
    return true;
  };
  // 只给玩家角色挂增益，增益只能是合集包里的或目标卡上已有的（applyBuffHere 本身就只认这两种）
  CONFIG.queries[`${MODULE}.applyBuff`] = async ({ actorUuid, key, level }) => {
    if (!game.user.isActiveGM) return null;
    const actor = await fromUuid(actorUuid);
    if (!(actor instanceof Actor) || actor.type !== "character" || !actor.hasPlayerOwner) throw new Error("只能给玩家角色挂");
    return applyBuffHere(actor, String(key), Math.max(1, Number(level) || 1));
  };

  // 角色卡变了（用掉环位、增益开关）就刷新窗口
  for (const hook of ["updateItem", "createItem", "deleteItem", "updateActor"]) {
    Hooks.on(hook, (doc) => {
      if (!app?.rendered) return;
      const actor = doc instanceof Actor ? doc : doc.parent;
      if (actor instanceof Actor && party().includes(actor)) app.render();
    });
  }
  Hooks.on("updateWorldTime", () => app?.rendered && app.render());

  // GM 建遭遇时（加入战斗、还没开始），在场 PC 的玩家自动弹出；每场战斗只弹一次
  const shown = new Set();
  Hooks.on("createCombatant", (combatant) => {
    if (!setting("prebuff") || !setting("prebuffAuto") || game.user.isGM) return;
    const combat = combatant.parent;
    const actor = combatant.actor;
    if (!combat || combat.started || shown.has(combat.id) || !actor?.isOwner || actor.type !== "character") return;
    shown.add(combat.id);
    openPrebuff(actor);
  });

  // 角色 token HUD 上的盾牌按钮
  Hooks.on("renderTokenHUD", (hud, html) => {
    const actor = hud.object?.actor;
    if (!setting("prebuff") || actor?.type !== "character" || !actor.isOwner) return;
    const root = html instanceof HTMLElement ? html : html[0];
    const col = root.querySelector(".col.right");
    if (!col || col.querySelector(".pb-prebuff-hud")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "control-icon pb-prebuff-hud";
    btn.dataset.tooltip = "战前准备";
    btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i>';
    btn.addEventListener("click", () => openPrebuff(actor));
    col.append(btn);
  });
}
