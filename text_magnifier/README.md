# Text Magnifier

这是一个可直接加载的 Chrome / Edge 浏览器扩展，同时保留 React + TypeScript Web 组件版本。

## 作为浏览器扩展使用

下载整个 `text_magnifier` 文件夹后：

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `text_magnifier` 文件夹

浏览器扩展入口文件：

```text
manifest.json
content.js
content.css
```

交互设计：

- 点击浏览器工具栏里的 Text Magnifier 扩展图标，可在当前页面注入并开启放大镜。
- 页面右下角显示 `MAG` 开关按钮。
- 点击 `MAG` 开启，再次点击关闭。
- 也可以按 `Alt + M` 开关。
- 开启后，鼠标悬停文本框、普通网页文本、表格单元格时显示放大镜。
- 用户手动选中文本时，镜片优先显示选区内容。
- 默认镜片为 260px x 120px 的圆角矩形，蓝色边框，跟随鼠标移动。
- 默认放大倍数为 2x。
- 按 `Esc` 关闭放大镜。

注意：

- 扩展刚加载后，已打开的页面可能需要刷新；也可以直接点击浏览器工具栏里的扩展图标注入当前页。
- Chrome/Edge 内置页面无法注入，例如 `chrome://extensions`、`chrome://newtab`、扩展商店页面。
- 本地 `file://` 页面需要在扩展详情里开启“允许访问文件网址”。

## 作为 React 组件使用

React 组件入口文件：

```text
TextMagnifier.tsx
TextMagnifier.css
```

示例：

```tsx
import { TextMagnifier } from "../text_magnifier/TextMagnifier";

<TextMagnifier enabled={magnifierEnabled} />
```
