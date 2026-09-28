# doubao-nowm

豆包（Doubao）分享页 **无水印原图** 重写脚本 —— 基于 QuantumultX。
打开任意豆包分享链接，页面里的图片直接是无水印原图，长按即可保存。

---

## 效果

```
改前：分享页显示的图片 → ~tplv-...-cgen_lwm3.png      （带水印）
改后：分享页显示的图片 → ~tplv-...-image_raw.png      （无水印原图，2048×2048）
```

验证样例：<https://www.doubao.com/thread/a0a8a0503a12b>（三张纯色图，红/黑/绿）

---

## 安装

### 1. 装好 QX 证书（**最容易漏的一步**）

- QX → 设置 → 证书管理 → 生成证书 → 安装
- iOS「设置 → 通用 → VPN与设备管理」→ 安装描述文件
- iOS「设置 → 通用 → 关于本机 → **证书信任设置**」→ 打开 QX 证书的 **完全信任**

> ⚠️ 只安装不信任 = 无效。80% 的「脚本没生效」都出在这里。

### 2. 加入配置

把 [`quantumultx.conf`](./quantumultx.conf) 里的 `[rewrite_local]` 与 `[mitm]` 两段合并进你的 QX 配置：

```ini
[rewrite_local]
^https?:\/\/www\.doubao\.com\/thread\/ url script-response-body https://raw.githubusercontent.com/lichuntu/doubao-nowm/main/doubao-nowm.js

[mitm]
hostname = www.doubao.com
```

> ⚠️ **不要**把 `byteimg.com` 加进 MITM —— 图片 CDN 是二进制流，解密只会拖慢加载。

### 3. 打开开关

QX 主界面打开「重写」+「MITM」，然后启动 QX。

### 4. 测试

浏览器打开分享链接 → 图片应直接是无水印原图。

---

## 原理

分享页是 React SPA + SSR，HTML 里没有 `<img>`，图片数据藏在 `<script>` 内嵌的 SSR JSON 里。

**同一张图会下发多个变体：**

| 字段 | 模板 | 说明 |
|---|---|---|
| `image_preview` | `~tplv-*-cgen_lwm3.png` | 带水印，页面默认显示这张 |
| `image_thumb` | `~tplv-*-cthumb_lwm3.png` | 带水印缩略图 |
| **`image_ori_raw`** | **`~tplv-*-image_raw.png`** | **无水印原图 ★** |
| `image_ori_raw.url_formats.heic` | `~tplv-*-image_raw.heic` | 无水印 HEIC |

`lwm` = **l**ight **w**ater**m**ark。

**脚本做的事**：把 JSON 里所有 `lwm3` 链接，整段替换为同图 `image_raw` 链接。

### ⚠️ 为什么不能简单替换模板名

```diff
- .../xxxx.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=...&x-signature=AAA
+ .../xxxx.jpeg~tplv-a9rns2rl98-image_raw.png?lk3s=...&x-signature=BBB
```

两个坑：

1. **host 不同** —— 同一张图，水印版在 `p11-`，原图可能在 `p26-`
2. **签名不同** —— `x-signature` 按「host + 路径 + 模板」签名，改模板名就失配 → **403**

所以必须取 `image_ori_raw` 字段里那份**自带的完整 URL**（含它自己的 host 与签名）。

### 分组依据

图片对象路径：`/tos-cn-i-a9rns2rl98/rc_gen_image/<hash>.jpeg`

同一张图的所有变体共享这段路径，只有 `~tplv-` 之后不同 —— 脚本据此把「原图」和「水印版」配对。

---

## 技术难点记录（踩过的坑）

<details>
<summary>展开查看</summary>

**坑 1：URL 被多层转义**

页面里的 URL 长这样：

```
https://p26-...byteimg.com/...jpeg~tplv-...-image_raw.png?lk3s=8e244e95\\\\u0026rcl=...\\\\u0026x-signature=xxx
```

转义规则：

| 原文 | 页面里 |
|---|---|
| `/` | `(\\)+u002F` |
| `&` | `(\\)+u0026` |
| `"` | `&quot;` |

反斜杠层数 **1~8 层不等**，还会混 `&quot;`。脚本用 8 轮迭代还原。

**坑 2：宽松正则「越界」吞掉下一条链接**

最初用 `[^\s]*?` 做 query 匹配，结果 `image_ori_raw` 的匹配从一条链接一路吞到**下一条链接的开头**，导致后面 `image_ori` 字段的签名被吃掉 → 替换后页面里的链接变成无签名残缺 URL。

**修正**：query 部分必须**显式以 `x-signature=` 结尾**，且不允许跨过 `"`、`&quot;`、`}` 等结构边界。

**坑 3：同图多 host**

三张图的 host 分别是 `p26-` / `p11-` / `p3-`，完全不固定 → 印证不能替换模板名。

</details>

---

## 测试结果

基于三图分享页（红/黑/绿）的完整回归测试：

| 检查项 | 结果 |
|---|---|
| 水印链接替换 | 120 处 → **0 残留** |
| HTML 结构完整性 | script 标签数、`&quot;` 数、反斜杠数 **全部不变** |
| 替换后解析 | 3 张原图，hash/host 一一对应，**无串图** |
| 实际下载 | 3 张全部 HTTP 200，2048×2048，**无可见水印** |

---

## 配套工具

- [`doubao_parse.py`](./doubao_parse.py) — Python 参考实现，可直接解析分享页提取无水印直链
  （可用于验证脚本替换逻辑，或作为独立小工具 / 快捷指令的算法参考）

```bash
curl -sL -A "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" \
  https://www.doubao.com/thread/xxxxx | python3 doubao_parse.py
```

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 图片仍带水印 | ① 证书是否「完全信任」② MITM 是否开启 ③ hostname 是否含 `www.doubao.com` ④ 清 Safari 缓存 |
| 页面白屏 / 图全裂 | 脚本匹配越界改坏了 JSON → 提 Issue，附上响应体 |
| 分享页 URL 变了 | 若变成 `/share/xxx` 之类，需同步改 `quantumultx.conf` 里的正则 |

---

## 免责声明

- 本项目仅供**个人学习与自用**（保存自己生成的图片）。
- AI 生成内容依《人工智能生成合成内容标识办法》（2025-09-01 施行）应保有标识。
- 请勿用于去除他人作品标识、二次分发或任何商业用途。
- 「豆包」为字节跳动注册商标，本项目与字节跳动无关。

## License

MIT
