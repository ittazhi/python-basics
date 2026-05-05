import type { CellSelection, TableGrid, TableModel } from "./types";
import { htmlToPlainText } from "./tableHtml";
import { normalizeSelection } from "./grid";

function escapeTsvCell(value: string): string {
  if (!/[\t\r\n"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function selectionToTsv(model: TableModel, grid: TableGrid, selection: CellSelection): string {
  const rect = normalizeSelection(selection);
  const rows: string[][] = [];

  for (let r = rect.startRow; r <= rect.endRow; r += 1) {
    const line: string[] = [];
    for (let c = rect.startCol; c <= rect.endCol; c += 1) {
      const slot = grid.cells[r]?.[c];
      const origin = slot?.masterCellId ? grid.origins.get(slot.masterCellId) : null;
      if (!slot?.masterCellId || !origin || origin.rowIndex !== r || origin.colIndex !== c) {
        line.push("");
        continue;
      }

      const cell = grid.cellMap.get(slot.masterCellId);
      line.push(htmlToPlainText(cell?.content ?? ""));
    }
    rows.push(line);
  }

  return rows.map((row) => row.map(escapeTsvCell).join("\t")).join("\n");
}

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === "\t") {
      row.push(value);
      value = "";
      continue;
    }

    if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    if (char === "\r") {
      if (next === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  row.push(value);
  rows.push(row);

  if (rows.length > 1 && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "") {
    rows.pop();
  }

  return rows;
}
