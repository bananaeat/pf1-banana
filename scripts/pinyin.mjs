// pf1-banana：拼音搜索用的小工具。拼音库 pinyin-pro（MIT）放在 vendor/，不走外网 CDN。
import { MODULE } from "./const.mjs";

const LIB_URL = `modules/${MODULE}/vendor/pinyin-pro.js`;
const CJK = /[㐀-鿿豈-﫿]/;
const cache = new Map(); // 名字 → { full, ini }

export function loadLib() {
  if (globalThis.pinyinPro) return Promise.resolve();
  // pinyin-pro 是 UMD：页面里有 AMD 的 define 时会注册到那边、不挂全局，加载期间先藏起来
  const amd = globalThis.define;
  globalThis.define = undefined;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LIB_URL;
    s.onload = () => (globalThis.pinyinPro ? resolve() : reject(new Error("pinyin-pro 没挂到全局")));
    s.onerror = () => reject(new Error(`读不到 ${LIB_URL}`));
    document.head.append(s);
  }).finally(() => {
    globalThis.define = amd;
  });
}

export function keysOf(name) {
  let k = cache.get(name);
  if (k) return k;
  const han = [...(name ?? "")].filter((c) => CJK.test(c)).join("");
  if (!han) k = { full: "", ini: "" };
  else {
    const { pinyin } = globalThis.pinyinPro;
    k = {
      full: pinyin(han, { toneType: "none", type: "array", v: true }).join("").toLowerCase(),
      ini: pinyin(han, { pattern: "first", toneType: "none", type: "array" }).join("").toLowerCase(),
    };
  }
  cache.set(name, k);
  return k;
}

export function score(k, q) {
  if (!k.full) return 0;
  if (k.ini === q || k.full === q) return 6;
  if (k.ini.startsWith(q)) return 5;
  if (k.full.startsWith(q)) return 4;
  if (k.ini.includes(q)) return 3;
  if (k.full.includes(q)) return 2;
  return 0;
}
