// pf1-banana：PF1 中文资料浏览器 + 一键购买 + 快捷出售。
import { MODULE } from "./const.mjs";
import { browserApi } from "./browser.mjs";
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
    hint: "物品按书价、法术做成卷轴 / 药水 / 魔杖购买。在地城里可以先关掉。资料浏览器顶上也有这个开关（GM）。",
    scope: "world", config: true, type: Boolean, default: true, onChange,
  });
  game.settings.register(MODULE, "sellRate", {
    name: "出售比例",
    hint: "普通物品按价格的多少卖出（核心规则是一半）。财宝和贸易品总是全价。",
    scope: "world", config: true, type: Number, default: 0.5, range: { min: 0, max: 1, step: 0.05 },
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
