export type CellTag = "td" | "th";
export type TableSection = "thead" | "tbody" | "tfoot";

export interface TableCellModel {
  id: string;
  tag: CellTag;
  content: string;
  rowSpan: number;
  colSpan: number;
  attrs: Record<string, string>;
  style: Record<string, string>;
}

export interface TableRowModel {
  id: string;
  section: TableSection;
  cells: TableCellModel[];
}

export interface TableModel {
  attrs: Record<string, string>;
  rows: TableRowModel[];
}

export interface CellSelection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface GridSlot {
  rowIndex: number;
  colIndex: number;
  rowId: string | null;
  section: TableSection;
  cellId: string | null;
  masterCellId: string | null;
  isOrigin: boolean;
  isCovered: boolean;
  originRowIndex: number | null;
  originColIndex: number | null;
  rowSpan: number;
  colSpan: number;
}

export interface GridOrigin {
  cellId: string;
  rowIndex: number;
  colIndex: number;
  rowSpan: number;
  colSpan: number;
  rowId: string;
  section: TableSection;
}

export interface TableGrid {
  cells: GridSlot[][];
  rowCount: number;
  colCount: number;
  origins: Map<string, GridOrigin>;
  cellMap: Map<string, TableCellModel>;
}
