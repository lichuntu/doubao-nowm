#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doubao_parse.py — 豆包分享页无水印原图解析器 (参考实现 / 权威版本)

作用: 给定豆包分享页 HTML，提取全部无水印原图直链（含完整签名）。
用途: ① 验证 QX 脚本替换逻辑  ② 作为独立小工具 / 快捷指令的算法参考

═══ 实测关键事实（2026-09-28，基于 thread/a0a8a0503a12b 三图页）═══
1. 分享页是 React SPA + SSR，HTML 里没有 <img>，图片数据藏在 <script> 内嵌 JSON。
2. URL 在页面里被多层转义，形如:
      https://p26-flow...byteimg.com/...jpeg~tplv-...-image_raw.png?lk3s=8e244e95\\\u0026rcl=...\\\u0026x-signature=xxx
   即  / → (\\)+u002F      & → (\\)+u0026      " → &quot;
   反斜杠层数 1~8 层不等，且可能混有 &quot;。
3. 同一张图在同一份 JSON 里下发多个变体:
      image_preview   ~tplv-*-cgen_lwm3.png     带水印（App 默认显示）
      image_thumb     ~tplv-*-cthumb_lwm3.png   带水印缩略图
      image_ori_raw   ~tplv-*-image_raw.png     无水印原图 ★
      image_ori_raw.url_formats.heic           无水印 HEIC
4. ⚠️ image_raw 与 image_preview 的 **host 不同**（如 p26- vs p3-），
   且 x-signature 按「路径+模板+host」签名 → 绝不能只替换模板名，必须整段取
   image_ori_raw 自带的完整 URL（含它自己的 host 与 signature）。
5. 每张图在页面中出现约 10 次（各变体 × 多语言/多尺寸字段），需按对象去重。

═══ 算法 ═══
  a) 还原转义（多轮）
  b) 用「宽松匹配 + x-signature 锚定」提取完整 URL
  c) 按图片对象路径 (/.../rc_gen_image/<hash>.jpeg) 分组去重
  d) 同组内优选 png，其次 heic
"""
import re, sys, json

# ── 转义还原 ──
def unescape(s: str, rounds: int = 8) -> str:
    for _ in range(rounds):
        prev = s
        s = s.replace('&quot;', '"').replace('&#92;', '\\').replace('&amp;', '&')
        s = re.sub(r'\\+u002[Ff]', '/', s)
        s = re.sub(r'\\+u0026',    '&', s)
        s = re.sub(r'\\+/',        '/', s)
        s = re.sub(r'\\+"',        '"', s)
        s = s.replace('\\\\', '\\')
        if s == prev:
            break
    return s

# ── 宽松匹配：从 https 开头一路吃到 x-signature 的值 ──
#    允许中间出现反斜杠、引号残留、u0026 等，最后统一在 trim() 里清洗
RE_IMAGE = re.compile(
    r'https?://[A-Za-z0-9._-]+\.byteimg\.com/[^\s]*?'
    r'~tplv-[A-Za-z0-9._-]*(image_raw|lwm\d*|cthumb_lwm\d*)[A-Za-z0-9._-]*\.[A-Za-z0-9]+'
    r'(?:[^\s]*?x-signature=[^\s&"\\]{4,120})?',
    re.IGNORECASE
)

def trim(u: str) -> str:
    u = re.sub(r'\\+u0026', '&', u)
    u = re.sub(r'\\+/', '/', u)
    u = u.replace('&amp;', '&').replace('&quot;', '')
    u = u.replace('\\', '')
    # 截到签名结束
    m = re.match(r'^(.*?x-signature=[^&"\'<>\s]*)', u)
    if m:
        u = m.group(1)
    return u.rstrip('"\'&, .')

def obj_path(u: str) -> str:
    m = re.match(r'^https?://[^/]+(/[^~?\s]+)', u)
    return m.group(1) if m else u

def has_sig(u: str) -> bool:
    return 'x-signature=' in u

def parse(html: str):
    """返回 {obj_path: {'png':url, 'heic':url}}"""
    s = unescape(html)
    idx = {}
    for m in RE_IMAGE.finditer(s):
        u = trim(m.group(0))
        if not u.startswith('http'):
            continue
        tpl = m.group(1).lower()
        p = obj_path(u)
        idx.setdefault(p, {})
        if 'image_raw' in tpl and not has_sig(u):
            continue                      # 无签名的残缺链接不要
        kind = 'heic' if u.lower().endswith('.heic') or '.heic?' in u.lower() else 'png'
        if 'image_raw' in tpl:
            idx[p][kind] = idx[p].get(kind) or u
        else:
            idx[p].setdefault('wm_' + kind, u)   # 仅供对照统计
    return idx, s

def main():
    src = open(sys.argv[1], encoding='utf-8', errors='ignore').read() if len(sys.argv) > 1 else sys.stdin.read()
    idx, decoded = parse(src)

    raws = {p: g for p, g in idx.items() if g.get('png') or g.get('heic')}
    wms  = [g for g in idx.values() if g.get('wm_png') or g.get('wm_heic')]

    print(f"带水印变体: {len(wms)} 个")
    print(f"无水印原图: {len(raws)} 张")
    print()
    out = []
    for i, (p, g) in enumerate(raws.items(), 1):
        u = g.get('png') or g.get('heic')
        out.append(u)
        print(f"[{i}] host={u.split('/')[2].split('-')[0]}  sig={'✅' if has_sig(u) else '❌'}")
        print(f"    {u}")
        print()
    print("--- JSON ---")
    print(json.dumps(out, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
