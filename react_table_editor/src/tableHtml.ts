import { createId } from "./ids";
import type { TableCellModel, TableModel, TableRowModel, TableSection } from "./types";

const SECTION_TAGS = new Set(["thead", "tbody", "tfoot"]);
const CELL_TAGS = new Set(["td", "th"]);

export class TableParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableParseError";
  }
}

export function parseInlineStyle(styleText: string | null | undefined): Record<string, string> {
  const style: Record<string, string> = {};
  if (!styleText) return style;

  for (const part of styleText.split(";")) {
    const index = part.indexOf(":");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) style[key] = value;
  }

  return style;
}

export function styleToString(style: Record<string, string>): string {
  return Object.entries(style)
    .filter(([key, value]) => key.trim() && value.trim())
    .map(([key, value]) => `${key.trim()}: ${value.trim()}`)
    .join("; ");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

export function plainTextToCellHtml(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

export function htmlToPlainText(value: string): string {
  if (!value) return "";
  const template = document.createElement("template");
  template.innerHTML = value.replace(/<br\s*\/?>/gi, "\n");
  return template.content.textContent ?? "";
}

function readAttrs(element: Element, skip: Set<string> = new Set()): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name;
    if (skip.has(name.toLowerCase())) continue;
    attrs[name] = attr.value;
  }
  return attrs;
}

function readSpan(element: Element, name: "rowspan" | "colspan"): number {
  const raw = element.getAttribute(name);
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}

function parseRow(rowElement: HTMLTableRowElement, section: TableSection): TableRowModel {
  const cells: TableCellModel[] = [];

  for (const child of Array.from(rowElement.children)) {
    const tag = child.tagName.toLowerCase();
    if (!CELL_TAGS.has(tag)) continue;

    cells.push({
      id: createId("cell"),
      tag: tag as "td" | "th",
      content: child.innerHTML,
      rowSpan: readSpan(child, "rowspan"),
      colSpan: readSpan(child, "colspan"),
      attrs: readAttrs(child, new Set(["rowspan", "colspan", "style"])),
      style: parseInlineStyle(child.getAttribute("style")),
    });
  }

  return {
    id: createId("row"),
    section,
    cells,
  };
}

export function parseTableHtml(html: string): TableModel {
  const source = html.trim();
  if (!source) {
    throw new TableParseError("HTML 为空。");
  }

  const doc = new DOMParser().parseFromString(source, "text/html");
  const table = doc.querySelector("table");
  if (!table) {
    throw new TableParseError("未找到 <table>。");
  }

  const rows: TableRowModel[] = [];
  const directChildren = Array.from(table.children);

  for (const child of directChildren) {
    const tag = child.tagName.toLowerCase();

    if (SECTION_TAGS.has(tag)) {
      const section = tag as TableSection;
      for (const rowElement of Array.from(child.children)) {
        if (rowElement.tagName.toLowerCase() === "tr") {
          rows.push(parseRow(rowElement as HTMLTableRowElement, section));
        }
      }
      continue;
    }

    if (tag === "tr") {
      rows.push(parseRow(child as HTMLTableRowElement, "tbody"));
    }
  }

  if (rows.length === 0) {
    for (const rowElement of Array.from(table.querySelectorAll("tr"))) {
      const parentTag = rowElement.parentElement?.tagName.toLowerCase();
      const section = SECTION_TAGS.has(parentTag ?? "") ? (parentTag as TableSection) : "tbody";
      rows.push(parseRow(rowElement, section));
    }
  }

  return {
    attrs: readAttrs(table),
    rows,
  };
}

function serializeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .filter(([name]) => name.trim() && !name.startsWith("__"))
    .map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
    .join("");
}

function serializeCell(cell: TableCellModel, indent: string): string {
  const attrs: Record<string, string> = { ...cell.attrs };
  if (cell.rowSpan > 1) attrs.rowspan = String(cell.rowSpan);
  if (cell.colSpan > 1) attrs.colspan = String(cell.colSpan);

  const styleText = styleToString(cell.style);
  if (styleText) attrs.style = styleText;

  return `${indent}<${cell.tag}${serializeAttrs(attrs)}>${cell.content}</${cell.tag}>`;
}

function serializeRows(rows: TableRowModel[], section: TableSection, indent: string): string[] {
  if (rows.length === 0) return [];

  const lines = [`${indent}<${section}>`];
  for (const row of rows) {
    lines.push(`${indent}  <tr>`);
    for (const cell of row.cells) {
      lines.push(serializeCell(cell, `${indent}    `));
    }
    lines.push(`${indent}  </tr>`);
  }
  lines.push(`${indent}</${section}>`);
  return lines;
}

export function serializeTableModel(model: TableModel): string {
  const lines = [`<table${serializeAttrs(model.attrs)}>`];
  const thead = model.rows.filter((row) => row.section === "thead");
  const tbody = model.rows.filter((row) => row.section === "tbody");
  const tfoot = model.rows.filter((row) => row.section === "tfoot");

  lines.push(...serializeRows(thead, "thead", "  "));
  lines.push(...serializeRows(tbody, "tbody", "  "));
  lines.push(...serializeRows(tfoot, "tfoot", "  "));

  if (model.rows.length === 0) {
    lines.push("  <tbody>");
    lines.push("  </tbody>");
  }

  lines.push("</table>");
  return lines.join("\n");
}
