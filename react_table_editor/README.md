# React Table Editor

一个极简、高速、类 Excel 的本地 HTML `<table>` 编辑工具。

默认界面只保留薄工具栏和可编辑 table。HTML 源码面板默认隐藏，点击 `HTML` 或 `导入HTML` 打开。

## 启动

一键启动：

- macOS：双击 `setup.command`
- Windows：双击 `setup.bat`

脚本会先检查 Node.js / npm，再自动安装依赖、启动本地服务，并打开 `http://127.0.0.1:5173/`。

前提：电脑已安装 Node.js LTS。未安装时脚本会提示并打开 Node.js 下载页。

手动启动：

```bash
npm install
npm run dev
```

## GitHub 使用

上传到 GitHub 后有两种用法：

- 本地使用：下载 ZIP 或 `git clone` 后双击 `setup.command` / `setup.bat`
- 在线使用：仓库启用 GitHub Pages，`.github/workflows/pages.yml` 会自动构建并发布 `dist`

GitHub Pages 首次启用：

1. 打开仓库 `Settings`
2. 进入 `Pages`
3. `Source` 选择 `GitHub Actions`
4. 推送到 `main` 后等待 Actions 完成

构建：

```bash
npm run build
```

## 技术栈

- React + TypeScript
- esbuild
- 无后端
- 不把 DOM 当唯一数据源
- 所有编辑先修改 `TableModel`，再序列化为标准 HTML table

## 核心文件

```text
src/
├── App.tsx          # 表格 UI、选区、键盘、粘贴、右键菜单
├── clipboard.ts    # TSV 复制 / 粘贴解析
├── grid.ts         # rowspan / colspan 二维 grid 构建
├── ids.ts          # 内部 id 生成
├── operations.ts   # TableModel 编辑操作
├── tableHtml.ts    # parseTableHtml / serializeTableModel
├── types.ts        # TableModel 类型
└── styles.css      # 极简 Excel 风格网格样式
scripts/
├── build.mjs        # esbuild 生产打包
└── dev.mjs          # esbuild watch + 极简静态服务
```

## 已实现能力

- `parseTableHtml(html)`：解析 table / thead / tbody / tfoot / tr / th / td
- `serializeTableModel(model)`：格式化输出标准 HTML table
- `buildGrid(model)`：基于 rowspan / colspan 生成二维 grid，记录真实格和覆盖格
- 单元格内容编辑
- 单元格编辑失焦自动提交，点击其他单元格或工具区不会卡在编辑态
- 公式栏编辑当前单元格，适合多行文本
- 多行内容导入和展示会保留换行，并去掉 HTML 源码缩进带来的假空白
- `td` / `th` 互转
- 插入行；按选区范围批量删除行
- 插入列；按选区范围批量删除列
- 矩形选区合并
- 拆分合并单元格
- TSV 矩阵粘贴，行列不足时自动扩展
- 批量查找替换
- 批量去除选中单元格内容首尾空白
- 批量清空选区
- 左 / 中 / 右对齐
- 顶部 / 垂直居中 / 底部对齐
- 清除 style
- 清除 class
- 撤销 / 重做
- HTML 面板默认是只读实时展示；需要导入时进入独立编辑模式，避免源码输入和实时输出互相覆盖
- 表格支持工具栏缩放，范围 60% 到 180%
- 支持 A/B/C 列标题、行号、整行/整列选择、拖拽调整列宽和行高
- 选区变化复用当前 grid，不会额外重建 rowspan / colspan grid
- 单元格事件处理器通过 ref 读取最新状态，减少选区变化和内容编辑时的无意义 Cell 重渲染

## 快捷键

- 单击：选中单元格
- 双击：编辑单元格
- `Enter`：进入编辑；编辑中确认并跳到下一行
- `Tab`：跳到右侧单元格，最后一列跳到下一行
- `Shift + Tab`：跳到左侧单元格
- 方向键：移动选区
- `Shift + 方向键`：扩展选区
- `Delete / Backspace`：清空选区
- `Cmd/Ctrl + C`：复制选区为 TSV
- `Cmd/Ctrl + V`：粘贴 Excel / Google Sheets / Numbers TSV
- `Cmd/Ctrl + Z`：撤销
- `Cmd/Ctrl + Shift + Z` / `Cmd/Ctrl + Y`：重做

## 数据模型

```ts
interface TableCellModel {
  id: string;
  tag: "td" | "th";
  content: string;
  rowSpan: number;
  colSpan: number;
  attrs: Record<string, string>;
  style: Record<string, string>;
}

interface TableRowModel {
  id: string;
  section: "thead" | "tbody" | "tfoot";
  cells: TableCellModel[];
}

interface TableModel {
  attrs: Record<string, string>;
  rows: TableRowModel[];
}
```

`id` 是编辑器内部字段，序列化 HTML 时不会输出。导入的 HTML `id` 属性会保存在 `attrs.id`，不会和内部 id 混用。

## 属性保留

解析时会保留：

- `rowspan`
- `colspan`
- `class`
- `style`
- `id`
- `title`
- `data-*`
- 其他未知属性

单元格的 `style` 会解析到 `Record<string, string>`；导出时重新写回标准 `style="..."`。

## 内容说明

单元格 `content` 保存为安全的 HTML 片段。普通编辑和 TSV 粘贴会把文本安全转义，并把换行输出为 `<br>`。导入已有 table 时只读取单元格文本和 `<br>` 换行，去掉源码缩进带来的假空白；项目只支持 table 相关标签，不做富文本保留。
