/*
 * doubao-nowm.js — 豆包分享页 · 无水印原图重写
 * ===============================================================
 * 目标站点 : https://www.doubao.com/thread/*
 * 作用     : 把 SSR 数据里所有「带水印(lwm3)」图片链接，
 *            整段替换为同图「无水印(image_raw)」链接。
 *            浏览器打开分享页时，正文图片即为无水印原图，
 *            长按/右键保存得到的就是原图。
 *
 * QuantumultX 用法见同目录 quantumultx.conf
 * ===============================================================
 *
 * 【原理 & 实测事实】(2026-09-28 基于 thread/a0a8a0503a12b 三图页)
 *
 * 1. 分享页是 React SPA + SSR，HTML 里没有 <img>，
 *    图片数据全藏在 <script> 内嵌的 SSR JSON 里。
 *
 * 2. 页面里 URL 被多层转义，形如：
 *      https://p26-flow...byteimg.com/...jpeg~tplv-...-image_raw.png?lk3s=8e244e95\\\\u0026rcl=...\\\\u0026x-signature=xxx
 *    转义规则： /  ->  (\\)+u002F      &  ->  (\\)+u0026      "  ->  &quot;
 *    反斜杠层数不定(1~8层)，且可能混有 &quot;。
 *
 * 3. 同一张图在同一份 JSON 里下发多个变体：
 *      image_preview     ~tplv-*-cgen_lwm3.png      带水印(页面默认显示此张)
 *      image_thumb       ~tplv-*-cthumb_lwm3.png    带水印缩略图
 *      image_preview_resize 同上
 *      image_ori_raw     ~tplv-*-image_raw.png      无水印原图 ★
 *      image_ori_raw.url_formats.heic               无水印 HEIC
 *
 * 4. ⚠️ 关键约束 —— 不能只替换模板名：
 *    - 同一张图的 image_raw 与 lwm3 **host 不同**(如 p26- vs p3-)
 *    - x-signature 是按「host+路径+模板」签名的
 *    所以 cgen_lwm3 -> image_raw 的简单字符串替换会导致签名失配 → 403。
 *    ✅ 正确做法：用同组 image_ori_raw 里自带 host+签名的完整 URL 整段覆盖。
 *
 * 5. 分组依据：图片对象路径 /.../rc_gen_image/<hash>.jpeg
 *    同一对象的所有变体共享该路径，仅 ~tplv- 之后不同。
 *
 * ===============================================================
 * 更新记录
 *   2026-09-28 v1
 *     - 首版，基于三图页实测编写
 *     - 修复 v0 缺陷：v0 把反斜杠排除在字符类外，导致 query 在
 *       第一个参数后截断、签名丢失 → 403。改为 x-signature 锚定截取。
 */

/* ------------------------------------------------------------------
 * 调试开关
 * ------------------------------------------------------------------
 * 设为 true 后，脚本会把关键信息打到 QX 日志（搜索 "[db-nwm]" 即可看到）。
 * 平时保持 false，避免污染日志。
 */
const DEBUG = false;

function dlog(...args) {
  if (DEBUG) {
    try { console.log('[db-nwm]', args.join(' ')); } catch (e) {}
  }
}

/* ------------------------------------------------------------------
 * 常量
 * ------------------------------------------------------------------ */

// 图片对象路径（用于同图分组）
const RE_OBJ = /^https?:\/\/[^/]+(\/[^~?\s]+)/;

// ── URL 匹配 ──
// ⚠️ 教训：用 `[^\s]*?` 做宽松匹配会「越界」——
//    它可能从一条链接一路吞到下一条链接的开头，导致后一条的签名被吃掉。
//    实测：image_ori_raw 的贪婪匹配吞掉了后面 image_ori 的开头，
//    替换后 image_ori 变成无签名残缺链接 → 页面渲染可能出错。
//
// ✅ 修正：query 部分必须「显式」以 u0026 / & 作为参数分隔符，
//    且不允许跨过 `"` `&quot;` `}` 等结构边界。
//
//    结构:  https://host/path~tplv-<kind>.<ext>?k=v(\+u0026k=v)*
const RE_URL = new RegExp(
  // 协议头：兼容三种写法
  //   1) https://          正常
  //   2) https:\u002F\u002F  单层转义
  //   3) https:\\u002F\\u002F 双层转义（新版页面实际使用）
  'https?:' +
  '(?:\\/{2}|(?:\\\\+u002F){2}|(?:\\\\+/){2})' +
  '[A-Za-z0-9._-]+\\.byteimg\\.com' +                    // 域名
  '(?:\\/|\\\\+u002F)' +                                 // 路径分隔符(可能转义)
  '[^\\s"\'<>{}]*?~tplv-[A-Za-z0-9._-]*?' +              // 路径 + 模板前缀
  // 【模板类型】不写死具体名字，因为豆包会改名：
  //   lwm3 / cthumb_lwm3  → 旧版(light watermark)
  //   wm0   / cthumb_wm0  → 新版(watermark)
  //   private / preview / image / icon / avatar ... → 其他变体
  '([A-Za-z0-9_]+)' +                                     // 模板名末段(捕获)
  '\\.' +                                                 // 扩展名分隔
  '[A-Za-z0-9]+' +                                        // 扩展名
  '(?:' +                                                 // query(可选)
    '\\?' +
    '[^\\s"\'<>{}]*?' +                                   // 第一个参数(直到 x-signature 或边界)
    'x-signature=[^&"\'<>\\s\\\\]{4,200}' +               // 【必须】以签名结束
  ')?',
  'gi'
);

// 哪些模板名算「原图」——可直接使用
const KIND_RAW = /^image_raw$/i;

/* ------------------------------------------------------------------
 * 文本清洗：转义还原 / 还原后的反向处理
 * ------------------------------------------------------------------ */

/** 把页面里的转义形态还原成可读 URL */
function unescapeText(t) {
  let prev;
  for (let i = 0; i < 8; i++) {
    prev = t;
    t = t.replace(/&quot;/g, '"')
         .replace(/&#92;/g, '\\')
         .replace(/&amp;/g, '&');
    t = t.replace(/\\+u002F/gi, '/');
    t = t.replace(/\\+u0026/g, '&');
    t = t.replace(/\\+\//g, '/');
    t = t.replace(/\\+"/g, '"');
    t = t.replace(/\\\\/g, '\\');
    if (t === prev) break;
  }
  return t;
}

/** 清洗单条 URL：归一化分隔符 + 截断到签名结束 */
function trimUrl(u) {
  u = u.replace(/\\+u0026/g, '&')
       .replace(/\\+\//g, '/')
       .replace(/\\+u002F/gi, '/')
       .replace(/&amp;/g, '&')
       .replace(/&quot;/g, '')
       .replace(/\\/g, '');
  const m = u.match(/^(.*?x-signature=[^&"'<>\s]*)/);
  if (m) u = m[1];
  return u.replace(/["'&,\s.]+$/, '');
}

function objPathOf(u) {
  const m = u.match(RE_OBJ);
  return m ? m[1] : u;
}

/* ------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------ */

dlog('=== 命中分享页重写 ===');
dlog('body 类型:', typeof $response.body);

let rawBody = $response.body;

// ── 类型兼容 ──
// QX 的 $response.body 通常是字符串，但：
//   ① 响应被 gzip/br 压缩且未自动解压时，可能是 Uint8Array / 乱码字符串
//   ② 少数版本会给出对象
// 这里统一做一次「尽力还原成字符串」处理。
let body = '';
if (typeof rawBody === 'string') {
  body = rawBody;
} else if (rawBody && typeof rawBody === 'object') {
  // Uint8Array / ArrayBuffer 等
  try {
    const u8 = rawBody instanceof Uint8Array
      ? rawBody
      : (typeof ArrayBuffer !== 'undefined' && rawBody instanceof ArrayBuffer)
        ? new Uint8Array(rawBody)
        : null;
    if (u8) {
      // 若是 gzip (1f 8b) / brotli 特征则无法用纯 JS 还原，直接放行交给 QX
      if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
        $done({ body: rawBody });
      }
      let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      // 尝试按 UTF-8 解码
      body = decodeURIComponent(escape(s));
    } else {
      $done({});
    }
  } catch (e) {
    $done({});
  }
} else {
  $done({});
}

if (!body) $done({});

// 只处理含图片数据的页面
if (body.indexOf('byteimg') === -1) {
  dlog('未发现 byteimg，放行。body 前200字符:', body.slice(0, 200));
  $done({ body });
}
dlog('body 长度:', body.length, '| byteimg 出现次数:', (body.match(/byteimg/g) || []).length);

const decoded = unescapeText(body);

/* ── 第 1 步：建立「无水印原图」索引，按图片对象分组 ── */
const rawIndex = {};          // { objPath: { png, heic } }

RE_URL.lastIndex = 0;
let m;
while ((m = RE_URL.exec(decoded)) !== null) {
  const kind = (m[1] || '').toLowerCase();
  if (kind !== 'image_raw') continue;      // 只要无水印版

  const url = trimUrl(m[0]);
  if (!/x-signature=/.test(url)) continue; // 无签名的残缺链接丢弃

  const key = objPathOf(url);
  const isHeic = /\.heic(\?|$)/i.test(url);
  rawIndex[key] = rawIndex[key] || {};
  const slot = isHeic ? 'heic' : 'png';
  if (!rawIndex[key][slot]) rawIndex[key][slot] = url;
}

const objCount = Object.keys(rawIndex).length;
dlog('无水印原图对象数:', objCount);
if (objCount === 0) {
  dlog('本页无可用原图，放行');
  $done({ body });               // 本页无原图可换
}

/* ── 第 2 步：在【原始未解码文本】上做替换 ──
 *  说明：直接在原始 body 上替换，保持页面原有的转义风格，
 *       避免引入编码不一致导致 React 解析失败。
 *       但原始文本里 URL 被转义，无法直接比对……
 *       因此改为：在解码文本上替换，再把结果按原风格回写会不现实。
 *
 *  ✅ 实际策略：QX 的 $response.body 在 script-response-body 中
 *     已经是「解密后的原始响应文本」，我们直接在它上面做替换：
 *     先用解码版建立索引，再对原始文本逐条定位并替换。
 *     由于转义只影响 "/" 和 "&"，我们在原始文本里用「同样宽松」的
 *     正则匹配 lwm 链接，取它的 objPath（解码后比对），替换为
 *     raw 链接的【对应转义形态】。
 */

/** 把干净 URL 转回页面里的转义形态 */
function toEscapedStyle(cleanUrl, sampleEscaped) {
  // 探测样本里使用的转义风格
  const ampMatch = sampleEscaped.match(/(\\+)u0026/);
  const slashMatch = sampleEscaped.match(/(\\+)u002F/i);
  const ampEsc = ampMatch ? ampMatch[1] + 'u0026' : '&';
  const slashEsc = slashMatch ? slashMatch[1] + 'u002F' : '/';
  return cleanUrl.replace(/&/g, ampEsc).replace(/\//g, slashEsc);
}

let replaced = 0;
let skipped = 0;

body = body.replace(RE_URL, function (hit) {
  // 模板名末段：image_raw / cthumb_wm0 / private / image / ...
  const kind = (hit.match(/~tplv-[A-Za-z0-9._-]*?([A-Za-z0-9_]+)\.[A-Za-z0-9]+(?:[?\\]|$)/) || [])[1] || '';
  if (KIND_RAW.test(kind)) return hit;               // 本身已是原图，跳过

  const clean = trimUrl(unescapeText(hit));
  const key = objPathOf(clean);
  const grp = rawIndex[key];

  if (!grp) { skipped++; return hit; }               // 无对应原图，保持原样

  // 优先保持扩展名一致（heic 原图→heic，否则退回 png）
  const isHeic = /\.heic(\?|$)/i.test(clean);
  const target = (isHeic && grp.heic) ? grp.heic : (grp.png || grp.heic);
  if (!target) { skipped++; return hit; }

  replaced++;
  return toEscapedStyle(target, hit);                // 按原转义风格回写
});

dlog('替换完成 | 已替换:', replaced, '| 跳过:', skipped);
$done({ body });
