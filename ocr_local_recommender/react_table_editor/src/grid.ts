import type { GridOrigin, GridSlot, TableGrid, TableModel, TableSection } from "./types";

function emptySlot(rowIndex: number, colIndex: number, rowId: string | null, section: TableSection): GridSlot {
  return {
    rowIndex,
    colIndex,
    rowId,
    section,
    cellId: null,
    masterCellId: null,
    isOrigin: false,
    isCovered: false,
    originRowIndex: null,
    originColIndex: null,
    rowSpan: 1,
    colSpan: 1,
  };
}

function ensureRow(grid: (GridSlot | undefined)[][], rowIndex: number): void {
  while (grid.length <= rowIndex) grid.push([]);
}

export function buildGrid(model: TableModel): TableGrid {
  const rawGrid: (GridSlot | undefined)[][] = Array.from({ length: model.rows.length }, () => []);
  const origins = new Map<string, GridOrigin>();
  const cellMap = new Map(model.rows.flatMap((row) => row.cells.map((cell) => [cell.id, cell] as const)));

  model.rows.forEach((row, rowIndex) => {
    ensureRow(rawGrid, rowIndex);
    let colIndex = 0;

    for (const cell of row.cells) {
      while (rawGrid[rowIndex][colIndex]) colIndex += 1;

      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const colSpan = Math.max(1, cell.colSpan || 1);
      origins.set(cell.id, {
        cellId: cell.id,
        rowIndex,
        colIndex,
        rowSpan,
        colSpan,
        rowId: row.id,
        section: row.section,
      });

      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        ensureRow(rawGrid, r);
        for (let c = colIndex; c < colIndex + colSpan; c += 1) {
          rawGrid[r][c] = {
            rowIndex: r,
            colIndex: c,
            rowId: model.rows[r]?.id ?? null,
            section: model.rows[r]?.section ?? row.section,
            cellId: r === rowIndex && c === colIndex ? cell.id : null,
            masterCellId: cell.id,
            isOrigin: r === rowIndex && c === colIndex,
            isCovered: !(r === rowIndex && c === colIndex),
            originRowIndex: rowIndex,
            originColIndex: colIndex,
            rowSpan,
            colSpan,
          };
        }
      }

      colIndex += colSpan;
    }
  });

  const rowCount = Math.max(model.rows.length, rawGrid.length);
  const colCount = rawGrid.reduce((max, row) => Math.max(max, row.length), 0);
  const cells: GridSlot[][] = [];

  for (let r = 0; r < rowCount; r += 1) {
    const row = model.rows[r];
    const section = row?.section ?? "tbody";
    const rowId = row?.id ?? null;
    cells[r] = [];
    for (let c = 0; c < colCount; c += 1) {
      cells[r][c] = rawGrid[r]?.[c] ?? emptySlot(r, c, rowId, section);
    }
  }

  return {
    cells,
    rowCount,
    colCount,
    origins,
    cellMap,
  };
}

export function normalizeSelection(selection: { startRow: number; startCol: number; endRow: number; endCol: number }) {
  return {
    startRow: Math.min(selection.startRow, selection.endRow),
    startCol: Math.min(selection.startCol, selection.endCol),
    endRow: Math.max(selection.startRow, selection.endRow),
    endCol: Math.max(selection.startCol, selection.endCol),
  };
}

export function getCellIdsInGridSelection(grid: TableGrid, selection: { startRow: number; startCol: number; endRow: number; endCol: number }): Set<string> {
  const rect = normalizeSelection(selection);
  const ids = new Set<string>();

  for (let r = rect.startRow; r <= rect.endRow; r += 1) {
    for (let c = rect.startCol; c <= rect.endCol; c += 1) {
      const id = grid.cells[r]?.[c]?.masterCellId;
      if (id) ids.add(id);
    }
  }

  return ids;
}

export function getCellIdsInSelection(model: TableModel, selection: { startRow: number; startCol: number; endRow: number; endCol: number }): Set<string> {
  return getCellIdsInGridSelection(buildGrid(model), selection);
}

export function expandSelectionToWholeCells(model: TableModel, selection: { startRow: number; startCol: number; endRow: number; endCol: number }) {
  const grid = buildGrid(model);
  let rect = normalizeSelection(selection);
  let changed = true;

  while (changed) {
    changed = false;
    for (let r = rect.startRow; r <= rect.endRow; r += 1) {
      for (let c = rect.startCol; c <= rect.endCol; c += 1) {
        const id = grid.cells[r]?.[c]?.masterCellId;
        if (!id) continue;
        const origin = grid.origins.get(id);
        if (!origin) continue;

        const next = {
          startRow: Math.min(rect.startRow, origin.rowIndex),
          startCol: Math.min(rect.startCol, origin.colIndex),
          endRow: Math.max(rect.endRow, origin.rowIndex + origin.rowSpan - 1),
          endCol: Math.max(rect.endCol, origin.colIndex + origin.colSpan - 1),
        };

        if (
          next.startRow !== rect.startRow ||
          next.startCol !== rect.startCol ||
          next.endRow !== rect.endRow ||
          next.endCol !== rect.endCol
        ) {
          rect = next;
          changed = true;
        }
      }
    }
  }

  return rect;
}
