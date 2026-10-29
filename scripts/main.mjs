// pf1-banana：PF1 中文资料浏览器 + 一键购买 + 快捷出售。
import { MODULE } from "./const.mjs";
import { browserApi } from "./browser.mjs";
import { ContentConfig, DEFAULT_CONTENT } from "./content.mjs";
import { buyItem, buySpell } from "./buy.mjs";
import "./sell.mjs";

Hooks.once("init", () => {
  const onChange = () => browserApi.settingChanged();
  game.settings.register(MODULE, "monsters", {
    name: "玩家可以看怪物 / NPC 页",
    hint: "关着时只有 GM 能看资料浏览器的怪物页，玩家打开 PF1 自带的怪物浏览器也不会换成这个。",
    scope: "world", config: true, type: Boolean, default: false, onChange,
  });
  game.settings.register(MODULE, "shop", {
    name: "资料浏览器里可以购买",
    hint: "物品按书价、法术做成卷轴 / 药水 / 魔杖购买，钱直接从角色身上扣。在地城里可以关掉。",
    scope: "world", config: true, type: Boolean, default: false, onChange,
  });
  game.settings.register(MODULE, "sell", {
    name: "角色卡上可以出售",
    hint: "角色卡物品栏每件物品多一个出售按钮，货币栏下面有「出售物品」批量出售，钱直接加到角色身上。",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => Object.values(ui.windows).filter((w) => w.actor && w.rendered).forEach((w) => w.render()),
  });
  game.settings.register(MODULE, "sellRate", {
    name: "出售比例",
    hint: "普通物品按价格的多少卖出（核心规则是一半）。财宝和贸易品总是全价。",
    scope: "world", config: true, type: Number, default: 0.5, range: { min: 0, max: 1, step: 0.05 },
  });
  game.settings.register(MODULE, "content", {
    scope: "world", config: false, type: Object, default: DEFAULT_CONTENT, onChange: () => browserApi.contentChanged(),
  });
  game.settings.registerMenu(MODULE, "contentMenu", {
    name: "资料浏览器内容",
    label: "合集包与来源书",
    hint: "选每个分页用哪些合集包；限制玩家只能看哪些来源书的条目（比如只开核心规则书）。",
    icon: "fa-solid fa-filter", type: ContentConfig, restricted: true,
  });
  game.settings.register(MODULE, "replacePf1", {
    name: "替换 PF1 自带的浏览器",
    hint: "角色卡上的「浏览」等打开 PF1 法术 / 专长 / 物品 / 怪物浏览器时，改为打开资料浏览器。",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.keybindings.register(MODULE, "toggle", {
    name: "打开 / 关闭资料浏览器",
    editable: [{ key: "KeyB" }],
    onDown: () => {
      browserApi.toggle();
      return true;
    },
  });
  game.modules.get(MODULE).api = { open: browserApi.open, openPage: browserApi.openPage, buyItem, buySpell };
});
