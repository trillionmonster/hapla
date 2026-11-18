# Hapla 品牌标识

Hapla 使用「折跃」几何标识：两片方向相反的开口构件组成六边形轮廓，以宽实线、斜向切口表现连接和协作，适合 16 px 标签页图标。

- 石墨底色：`#101820`
- 银白：`#E5F3FF`
- 冰蓝：`#63DDF2`
- 浅色界面前景：`#101820` / `#007F99`
- 待审批通知：右上角琥珀色标记，保留原有标识。

几何源文件在 `packages/hapla-web/sources/assets/brand/`，统一通过 `node scripts/generate-brand-assets.cjs` 生成应用、深浅主题、favicon 和 touch 图标。网页字标统一为 `Hapla`。

`public/brand/` 中的版本化资源用于未登录系统密码页和应用页面。只公开 nginx 列出的明确品牌资源，不公开账户文件或其他应用资源。

再次调整图标时同步提升品牌资源路径版本，并更新 generator、faviconGenerator、export-web、门禁 HTML 和 nginx 白名单，以避免浏览器沿用旧缓存。
