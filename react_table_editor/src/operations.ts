import { buildGrid, expandSelectionToWholeCells, getCellIdsInSelection } from "./grid";
import { createId } from "./ids";
import { htmlToPlainText, plainTextToCellHtml } from "./tableHtml";
import type { CellSelection, CellTag, TableCellModel, TableModel, TableRowModel, TableSection } from "./types";

type Projection = {
  attrs: Record<string, string>;
  slots: string[][];
  cells: Map<string, TableCellModel>;
  rowIds: string[];
  rowSections: TableSection[];
};

type CellBounds = {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
  positions: Array<[number, number]>;
};

function cloneCell(cell: TableCellModel): TableCellModel {
  return {
    ...cell,
    attrs: { ...cell.attrs },
    style: { ...cell.style },
  };
}

function cloneRow(row: TableRowModel): TableRowModel {
  return {
    ...row,
    cells: row.cells.map(cloneCell),
  };
}

function cloneModel(model: TableModel): TableModel {
  return {
    attrs: { ...model.attrs },
    rows: model.rows.map(cloneRow),
  };
}

function createBlankCell(tag: CellTag = "td", content = ""): TableCellModel {
  return {
    id: createId("cell"),
    tag,
    content,
    rowSpan: 1,
    colSpan: 1,
    attrs: {},
    style: {},
  };
}

export function createBlankTable(rowCount = 30, colCount = 12): TableModel {
  return {
    attrs: {},
    rows: Array.from({ length: rowCount }, () => ({
      id: createId("row"),
      section: "tbody",
      cells: Array.from({ length: colCount }, () => createBlankCell()),
    })),
  };
}

function projectModel(model: TableModel): Projection {
  const grid = buildGrid(model);
  const rowCount = Math.max(model.rows.length, 1);
  const colCount = Math.max(grid.colCount, 1);
  const cells = new Map<string, TableCellModel>();

  for (const row of model.rows) {
    for (const cell of row.cells) {
      cells.set(cell.id, cloneCell(cell));
    }
  }

  const slots: string[][] = [];
  const rowIds: string[] = [];
  const rowSections: TableSection[] = [];

  for (let r = 0; r < rowCount; r += 1) {
    rowIds[r] = model.rows[r]?.id ?? createId("row");
    rowSections[r] = model.rows[r]?.section ?? "tbody";
    slots[r] = [];

    for (let c = 0; c < colCount; c += 1) {
      const existing = grid.cells[r]?.[c]?.masterCellId;
      if (existing) {
        slots[r][c] = existing;
      } else {
        const blank = createBlankCell();
        cells.set(blank.id, blank);
        slots[r][c] = blank.id;
      }
    }
  }

  return {
    attrs: { ...model.attrs },
    slots,
    cells,
    rowIds,
    rowSections,
  };
}

function collectBounds(slots: string[][]): Map<string, CellBounds> {
  const bounds = new Map<string, CellBounds>();

  slots.forEach((row, r) => {
    row.forEach((id, c) => {
      const current = bounds.get(id);
      if (!current) {
        bounds.set(id, {
          minRow: r,
          maxRow: r,
          minCol: c,
          maxCol: c,
          positions: [[r, c]],
        });
        return;
      }

      current.minRow = Math.min(current.minRow, r);
      current.maxRow = Math.max(current.maxRow, r);
      current.minCol = Math.min(current.minCol, c);
      current.maxCol = Math.max(current.maxCol, c);
      current.positions.push([r, c]);
    });
  });

  return bounds;
}

function splitNonRectangularSlots(projection: Projection): void {
  const bounds = collectBounds(projection.slots);

  for (const [id, bound] of bounds) {
    let isRectangle = true;
    for (let r = bound.minRow; r <= bound.maxRow; r += 1) {
      for (let c = bound.minCol; c <= bound.maxCol; c += 1) {
        if (projection.slots[r]?.[c] !== id) {
          isRectangle = false;
        }
      }
    }

    if (isRectangle) continue;

    const source = projection.cells.get(id) ?? createBlankCell();
    const [firstRow, firstCol] = bound.positions[0];
    projection.slots[firstRow][firstCol] = id;
    projection.cells.set(id, { ...cloneCell(source), rowSpan: 1, colSpan: 1 });

    for (let index = 1; index < bound.positions.length; index += 1) {
      const [r, c] = bound.positions[index];
      const blank = createBlankCell(source.tag);
      projection.cells.set(blank.id, blank);
      projection.slots[r][c] = blank.id;
    }
  }
}

function reconstructModel(projection: Projection): TableModel {
  splitNonRectangularSlots(projection);
  const bounds = collectBounds(projection.slots);
  const rows: TableRowModel[] = [];

  for (let r = 0; r < projection.slots.length; r += 1) {
    const rowCells: TableCellModel[] = [];
    const colCount = projection.slots[r]?.length ?? 0;

    for (let c = 0; c < colCount; c += 1) {
      const id = projection.slots[r][c];
      const bound = bounds.get(id);
      if (!bound || bound.minRow !== r || bound.minCol !== c) continue;

      const source = projection.cells.get(id) ?? createBlankCell();
      rowCells.push({
        ...cloneCell(source),
        id,
        rowSpan: bound.maxRow - bound.minRow + 1,
        colSpan: bound.maxCol - bound.minCol + 1,
      });
    }

    rows.push({
      id: projection.rowIds[r] ?? createId("row"),
      section: projection.rowSections[r] ?? "tbody",
      cells: rowCells,
    });
  }

  return {
    attrs: { ...projection.attrs },
    rows,
  };
}

function mapCells(model: TableModel, ids: Set<string>, transform: (cell: TableCellModel) => TableCellModel): TableModel {
  if (ids.size === 0) return model;
  let changed = false;

  const rows = model.rows.map((row) => {
    let rowChanged = false;
    const cells = row.cells.map((cell) => {
      if (!ids.has(cell.id)) return cell;
      const next = transform(cloneCell(cell));
      if (next !== cell) {
        rowChanged = true;
        changed = true;
      }
      return next;
    });

    return rowChanged ? { ...row, cells } : row;
  });

  return changed ? { attrs: { ...model.attrs }, rows } : model;
}

export function updateCellContent(model: TableModel, cellId: string, content: string): TableModel {
  return mapCells(model, new Set([cellId]), (cell) => ({ ...cell, content }));
}

export function switchCellTag(model: TableModel, cellId: string): TableModel {
  return mapCells(model, new Set([cellId]), (cell) => ({
    ...cell,
    tag: cell.tag === "td" ? "th" : "td",
  }));
}

export function insertRow(model: TableModel, rowIndex: number, position: "before" | "after"): TableModel {
  const projection = projectModel(model);
  const rowCount = projection.slots.length;
  const colCount = projection.slots[0]?.length ?? 1;
  const target = Math.max(0, Math.min(rowCount, rowIndex + (position === "after" ? 1 : 0)));
  const section = projection.rowSections[target] ?? projection.rowSections[target - 1] ?? "tbody";
  const newRow = Array.from({ length: colCount }, (_, col) => {
    const spansThroughBoundary =
      target > 0 &&
      target < rowCount &&
      projection.slots[target - 1]?.[col] &&
      projection.slots[target - 1][col] === projection.slots[target]?.[col];

    if (spansThroughBoundary) return projection.slots[target - 1][col];

    const blank = createBlankCell();
    projection.cells.set(blank.id, blank);
    return blank.id;
  });

  projection.slots.splice(target, 0, newRow);
  projection.rowIds.splice(target, 0, createId("row"));
  projection.rowSections.splice(target, 0, section);

  return reconstructModel(projection);
}

export function deleteRow(model: TableModel, rowIndex: number): TableModel {
  const projection = projectModel(model);
  if (projection.slots.length <= 1) {
    const colCount = projection.slots[0]?.length ?? 1;
    projection.slots[0] = Array.from({ length: colCount }, () => {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      return blank.id;
    });
    return reconstructModel(projection);
  }

  const target = Math.max(0, Math.min(projection.slots.length - 1, rowIndex));
  projection.slots.splice(target, 1);
  projection.rowIds.splice(target, 1);
  projection.rowSections.splice(target, 1);

  return reconstructModel(projection);
}

export function deleteRows(model: TableModel, startRowIndex: number, endRowIndex: number): TableModel {
  const projection = projectModel(model);
  const rowCount = projection.slots.length;
  const start = Math.max(0, Math.min(rowCount - 1, Math.min(startRowIndex, endRowIndex)));
  const end = Math.max(0, Math.min(rowCount - 1, Math.max(startRowIndex, endRowIndex)));
  const deleteCount = end - start + 1;

  if (deleteCount >= rowCount) {
    const colCount = projection.slots[0]?.length ?? 1;
    projection.slots = [
      Array.from({ length: colCount }, () => {
        const blank = createBlankCell();
        projection.cells.set(blank.id, blank);
        return blank.id;
      }),
    ];
    projection.rowIds = [createId("row")];
    projection.rowSections = [projection.rowSections[start] ?? "tbody"];
    return reconstructModel(projection);
  }

  projection.slots.splice(start, deleteCount);
  projection.rowIds.splice(start, deleteCount);
  projection.rowSections.splice(start, deleteCount);

  return reconstructModel(projection);
}

export function insertColumn(model: TableModel, colIndex: number, position: "before" | "after"): TableModel {
  const projection = projectModel(model);
  const colCount = projection.slots[0]?.length ?? 1;
  const target = Math.max(0, Math.min(colCount, colIndex + (position === "after" ? 1 : 0)));

  for (let r = 0; r < projection.slots.length; r += 1) {
    const spansThroughBoundary =
      target > 0 &&
      target < colCount &&
      projection.slots[r]?.[target - 1] &&
      projection.slots[r][target - 1] === projection.slots[r]?.[target];

    if (spansThroughBoundary) {
      projection.slots[r].splice(target, 0, projection.slots[r][target - 1]);
    } else {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      projection.slots[r].splice(target, 0, blank.id);
    }
  }

  return reconstructModel(projection);
}

export function deleteColumn(model: TableModel, colIndex: number): TableModel {
  const projection = projectModel(model);
  const colCount = projection.slots[0]?.length ?? 1;

  if (colCount <= 1) {
    for (let r = 0; r < projection.slots.length; r += 1) {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      projection.slots[r] = [blank.id];
    }
    return reconstructModel(projection);
  }

  const target = Math.max(0, Math.min(colCount - 1, colIndex));
  for (const row of projection.slots) {
    row.splice(target, 1);
  }

  return reconstructModel(projection);
}

export function deleteColumns(model: TableModel, startColIndex: number, endColIndex: number): TableModel {
  const projection = projectModel(model);
  const colCount = projection.slots[0]?.length ?? 1;
  const start = Math.max(0, Math.min(colCount - 1, Math.min(startColIndex, endColIndex)));
  const end = Math.max(0, Math.min(colCount - 1, Math.max(startColIndex, endColIndex)));
  const deleteCount = end - start + 1;

  if (deleteCount >= colCount) {
    for (let r = 0; r < projection.slots.length; r += 1) {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      projection.slots[r] = [blank.id];
    }
    return reconstructModel(projection);
  }

  for (const row of projection.slots) {
    row.splice(start, deleteCount);
  }

  return reconstructModel(projection);
}

export function mergeSelectedCells(model: TableModel, selection: CellSelection, options: { mergeContent?: boolean } = {}): TableModel {
  const rect = expandSelectionToWholeCells(model, selection);
  if (rect.startRow === rect.endRow && rect.startCol === rect.endCol) return model;

  const projection = projectModel(model);
  const masterId = projection.slots[rect.startRow]?.[rect.startCol];
  if (!masterId) return model;

  const ids = new Set<string>();
  for (let r = rect.startRow; r <= rect.endRow; r += 1) {
    for (let c = rect.startCol; c <= rect.endCol; c += 1) {
      const id = projection.slots[r]?.[c];
      if (id) ids.add(id);
    }
  }

  if (options.mergeContent !== false) {
    const bounds = collectBounds(projection.slots);
    const mergedText = Array.from(ids)
      .sort((a, b) => {
        const boundsA = bounds.get(a);
        const boundsB = bounds.get(b);
        return (boundsA?.minRow ?? 0) - (boundsB?.minRow ?? 0) || (boundsA?.minCol ?? 0) - (boundsB?.minCol ?? 0);
      })
      .map((id) => htmlToPlainText(projection.cells.get(id)?.content ?? "").trim())
      .filter(Boolean)
      .join("\n");

    const master = projection.cells.get(masterId);
    if (master) master.content = plainTextToCellHtml(mergedText);
  }

  for (let r = rect.startRow; r <= rect.endRow; r += 1) {
    for (let c = rect.startCol; c <= rect.endCol; c += 1) {
      projection.slots[r][c] = masterId;
    }
  }

  return reconstructModel(projection);
}

export function splitCell(model: TableModel, cellId: string): TableModel {
  const projection = projectModel(model);
  const bounds = collectBounds(projection.slots);
  const bound = bounds.get(cellId);
  if (!bound) return model;

  const height = bound.maxRow - bound.minRow + 1;
  const width = bound.maxCol - bound.minCol + 1;
  if (height === 1 && width === 1) return model;

  const source = projection.cells.get(cellId) ?? createBlankCell();
  projection.cells.set(cellId, { ...cloneCell(source), rowSpan: 1, colSpan: 1 });

  for (let r = bound.minRow; r <= bound.maxRow; r += 1) {
    for (let c = bound.minCol; c <= bound.maxCol; c += 1) {
      if (r === bound.minRow && c === bound.minCol) {
        projection.slots[r][c] = cellId;
        continue;
      }

      const blank = createBlankCell(source.tag);
      projection.cells.set(blank.id, blank);
      projection.slots[r][c] = blank.id;
    }
  }

  return reconstructModel(projection);
}

export function pasteMatrix(model: TableModel, startCellId: string, matrix: string[][]): TableModel {
  if (matrix.length === 0 || matrix.every((row) => row.length === 0)) return model;

  const grid = buildGrid(model);
  const origin = grid.origins.get(startCellId);
  if (!origin) return model;

  const projection = projectModel(model);
  const rowNeed = origin.rowIndex + matrix.length;
  const colNeed = origin.colIndex + Math.max(...matrix.map((row) => row.length), 1);

  while (projection.slots.length < rowNeed) {
    const colCount = projection.slots[0]?.length ?? 1;
    const row = Array.from({ length: colCount }, () => {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      return blank.id;
    });
    projection.slots.push(row);
    projection.rowIds.push(createId("row"));
    projection.rowSections.push(projection.rowSections.at(-1) ?? "tbody");
  }

  while ((projection.slots[0]?.length ?? 0) < colNeed) {
    for (const row of projection.slots) {
      const blank = createBlankCell();
      projection.cells.set(blank.id, blank);
      row.push(blank.id);
    }
  }

  matrix.forEach((row, rOffset) => {
    row.forEach((value, cOffset) => {
      const targetId = projection.slots[origin.rowIndex + rOffset]?.[origin.colIndex + cOffset];
      const target = targetId ? projection.cells.get(targetId) : null;
      if (target) target.content = plainTextToCellHtml(value);
    });
  });

  return reconstructModel(projection);
}

export function batchReplace(model: TableModel, findText: string, replaceText: string, selection?: CellSelection): TableModel {
  if (!findText) return model;
  const ids = selection ? getCellIdsInSelection(model, selection) : new Set(model.rows.flatMap((row) => row.cells.map((cell) => cell.id)));

  return mapCells(model, ids, (cell) => ({
    ...cell,
    content: plainTextToCellHtml(htmlToPlainText(cell.content).split(findText).join(replaceText)),
  }));
}

export function batchTrim(model: TableModel, selection?: CellSelection): TableModel {
  const ids = selection ? getCellIdsInSelection(model, selection) : new Set(model.rows.flatMap((row) => row.cells.map((cell) => cell.id)));

  return mapCells(model, ids, (cell) => ({
    ...cell,
    content: plainTextToCellHtml(htmlToPlainText(cell.content).trim()),
  }));
}

export function batchClearSelectedCells(model: TableModel, selection: CellSelection): TableModel {
  return mapCells(model, getCellIdsInSelection(model, selection), (cell) => ({
    ...cell,
    content: "",
  }));
}

export function clearCellsContent(model: TableModel, ids: Set<string>): TableModel {
  return mapCells(model, ids, (cell) => ({
    ...cell,
    content: "",
  }));
}

export function setCellsStyle(model: TableModel, ids: Set<string>, stylePatch: Record<string, string | null>): TableModel {
  return mapCells(model, ids, (cell) => {
    const style = { ...cell.style };
    for (const [key, value] of Object.entries(stylePatch)) {
      if (value === null || value === "") delete style[key];
      else style[key] = value;
    }
    return { ...cell, style };
  });
}

export function clearCellsStyle(model: TableModel, ids: Set<string>): TableModel {
  return mapCells(model, ids, (cell) => ({
    ...cell,
    style: {},
  }));
}

export function clearCellsClass(model: TableModel, ids: Set<string>): TableModel {
  return mapCells(model, ids, (cell) => {
    const attrs = { ...cell.attrs };
    delete attrs.class;
    return { ...cell, attrs };
  });
}

export function setCellsTag(model: TableModel, ids: Set<string>, tag: CellTag): TableModel {
  return mapCells(model, ids, (cell) => ({ ...cell, tag }));
}

export function cloneTableModel(model: TableModel): TableModel {
  return cloneModel(model);
}
