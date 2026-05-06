import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { parseTsv, selectionToTsv } from "./clipboard";
import { buildGrid, getCellIdsInGridSelection, normalizeSelection } from "./grid";
import {
  batchReplace,
  batchTrim,
  clearCellsContent,
  clearCellsClass,
  clearCellsStyle,
  createBlankTable,
  deleteColumns,
  deleteRows,
  insertColumn,
  insertRow,
  mergeSelectedCells,
  pasteMatrix,
  setCellsStyle,
  splitCell,
  switchCellTag,
  updateCellContent,
} from "./operations";
import {
  htmlToPlainText,
  parseInlineStyle,
  parseTableHtml,
  plainTextToCellHtml,
  serializeTableModel,
  TableParseError,
} from "./tableHtml";
import type { CellSelection, GridOrigin, TableCellModel, TableGrid, TableModel } from "./types";

type GridPoint = { row: number; col: number };
type SelectionState = { anchor: GridPoint; focus: GridPoint };
type MenuState = { x: number; y: number } | null;
type SourceMode = "view" | "import";

const noopEditorKeyDown = () => undefined;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;

type HistoryState = {
  model: TableModel;
  past: TableModel[];
  future: TableModel[];
};

type HistoryAction =
  | { type: "apply"; update: (model: TableModel) => TableModel }
  | { type: "replace"; model: TableModel }
  | { type: "undo" }
  | { type: "redo" };

const MAX_HISTORY = 80;

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      model: previous,
      past: state.past.slice(0, -1),
      future: [state.model, ...state.future],
    };
  }

  if (action.type === "redo") {
    const next = state.future[0];
    if (!next) return state;
    return {
      model: next,
      past: [...state.past, state.model].slice(-MAX_HISTORY),
      future: state.future.slice(1),
    };
  }

  const nextModel = action.type === "replace" ? action.model : action.update(state.model);
  if (nextModel === state.model) return state;

  return {
    model: nextModel,
    past: [...state.past, state.model].slice(-MAX_HISTORY),
    future: [],
  };
}

function selectionToRect(selection: SelectionState): CellSelection {
  return normalizeSelection({
    startRow: selection.anchor.row,
    startCol: selection.anchor.col,
    endRow: selection.focus.row,
    endCol: selection.focus.col,
  });
}

function clampPoint(point: GridPoint, grid: TableGrid): GridPoint {
  return {
    row: Math.max(0, Math.min(Math.max(0, grid.rowCount - 1), point.row)),
    col: Math.max(0, Math.min(Math.max(0, grid.colCount - 1), point.col)),
  };
}

function getSlotCellId(grid: TableGrid, point: GridPoint): string | null {
  return grid.cells[point.row]?.[point.col]?.masterCellId ?? null;
}

function cssToReactStyle(style: Record<string, string>): CSSProperties {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(style)) {
    if (key.startsWith("--")) {
      result[key] = value;
    } else {
      result[key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = value;
    }
  }

  return result as CSSProperties;
}

function attrsForReact(attrs: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const lower = key.toLowerCase();
    if (lower === "class" || lower === "style" || lower === "rowspan" || lower === "colspan") continue;
    result[key] = value;
  }
  return result;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function getTableReactProps(attrs: Record<string, string>) {
  const style = parseInlineStyle(attrs.style);
  const props = attrsForReact(attrs);
  return {
    ...props,
    className: ["editable-table", attrs.class].filter(Boolean).join(" "),
    style: cssToReactStyle(style),
  };
}

const TableCellView = memo(function TableCellView({
  cell,
  origin,
  selected,
  active,
  editing,
  draft,
  onDraftChange,
  onEditorKeyDown,
  onEditorBlur,
  onCellMouseDown,
  onCellMouseEnter,
  onCellDoubleClick,
  onCellContextMenu,
}: {
  cell: TableCellModel;
  origin: GridOrigin;
  selected: boolean;
  active: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onEditorBlur: () => void;
  onCellMouseDown: (event: ReactMouseEvent, point: GridPoint, cellId: string) => void;
  onCellMouseEnter: (point: GridPoint) => void;
  onCellDoubleClick: (cellId: string) => void;
  onCellContextMenu: (event: ReactMouseEvent, point: GridPoint, cellId: string) => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const Tag = cell.tag;
  const importedClassName = cell.attrs.class ?? "";
  const className = [
    "table-cell",
    importedClassName,
    selected ? "is-selected" : "",
    active ? "is-active" : "",
    editing ? "is-editing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!editing) return;
    editorRef.current?.focus();
    editorRef.current?.select();
  }, [editing]);

  return (
    <Tag
      {...attrsForReact(cell.attrs)}
      className={className}
      style={cssToReactStyle(cell.style)}
      rowSpan={cell.rowSpan}
      colSpan={cell.colSpan}
      data-cell-id={cell.id}
      data-row={origin.rowIndex}
      data-col={origin.colIndex}
      onMouseDown={(event) => onCellMouseDown(event, { row: origin.rowIndex, col: origin.colIndex }, cell.id)}
      onMouseEnter={() => onCellMouseEnter({ row: origin.rowIndex, col: origin.colIndex })}
      onDoubleClick={() => onCellDoubleClick(cell.id)}
      onContextMenu={(event) => onCellContextMenu(event, { row: origin.rowIndex, col: origin.colIndex }, cell.id)}
    >
      {editing ? (
        <textarea
          ref={editorRef}
          className="cell-editor"
          value={draft}
          spellCheck={false}
          onMouseDown={(event) => event.stopPropagation()}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onEditorKeyDown}
          onBlur={onEditorBlur}
        />
      ) : (
        <span className="cell-content" dangerouslySetInnerHTML={{ __html: cell.content || "" }} />
      )}
    </Tag>
  );
});

function menuButton(label: string, action: () => void) {
  return (
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={action}>
      {label}
    </button>
  );
}

export function App() {
  const [history, dispatch] = useReducer(historyReducer, {
    model: createBlankTable(30, 12),
    past: [],
    future: [],
  });
  const model = history.model;
  const grid = useMemo(() => buildGrid(model), [model]);
  const htmlString = useMemo(() => serializeTableModel(model), [model]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<SelectionState>({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
  const [dragging, setDragging] = useState(false);
  const [editingCellId, setEditingCellId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("view");
  const [zoom, setZoom] = useState(1);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);

  const selectedRect = useMemo(() => selectionToRect(selection), [selection]);
  const selectedIds = useMemo(() => getCellIdsInGridSelection(grid, selectedRect), [grid, selectedRect]);
  const activeCellId = useMemo(() => getSlotCellId(grid, selection.focus), [grid, selection.focus]);
  const activeCell = activeCellId ? grid.cellMap.get(activeCellId) : null;
  const activeOrigin = activeCellId ? grid.origins.get(activeCellId) : null;
  const gridRef = useRef(grid);
  const selectedIdsRef = useRef(selectedIds);
  const draggingRef = useRef(dragging);
  const editingCellIdRef = useRef<string | null>(editingCellId);
  const editDraftRef = useRef(editDraft);
  const liveHtmlString = useMemo(() => {
    if (!sourceOpen || !editingCellId) return htmlString;
    return serializeTableModel(updateCellContent(model, editingCellId, plainTextToCellHtml(editDraft)));
  }, [editDraft, editingCellId, htmlString, model, sourceOpen]);

  const focusStage = useCallback(() => {
    requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    gridRef.current = grid;
  }, [grid]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);

  useEffect(() => {
    editingCellIdRef.current = editingCellId;
  }, [editingCellId]);

  useEffect(() => {
    editDraftRef.current = editDraft;
  }, [editDraft]);

  useEffect(() => {
    setSelection((current) => {
      const anchor = clampPoint(current.anchor, grid);
      const focus = clampPoint(current.focus, grid);
      if (anchor.row === current.anchor.row && anchor.col === current.anchor.col && focus.row === current.focus.row && focus.col === current.focus.col) {
        return current;
      }
      return { anchor, focus };
    });
  }, [grid]);

  useEffect(() => {
    if (editingCellId && !grid.cellMap.has(editingCellId)) {
      setEditingCellId(null);
      setEditDraft("");
    }
  }, [editingCellId, grid.cellMap]);

  useEffect(() => {
    const stopDrag = () => setDragging(false);
    const closeMenu = () => setMenu(null);
    window.addEventListener("mouseup", stopDrag);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      window.removeEventListener("mouseup", stopDrag);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, []);

  const applyModel = useCallback((update: (model: TableModel) => TableModel, nextSelection?: SelectionState, nextStatus?: string) => {
    dispatch({ type: "apply", update });
    if (nextSelection) setSelection(nextSelection);
    if (nextStatus !== undefined) setStatus(nextStatus);
    setMenu(null);
    focusStage();
  }, [focusStage]);

  const startEditing = useCallback((cellId: string, initialValue?: string) => {
    const cell = gridRef.current.cellMap.get(cellId);
    if (!cell) return;
    const nextDraft = initialValue ?? htmlToPlainText(cell.content);
    editingCellIdRef.current = cellId;
    editDraftRef.current = nextDraft;
    setEditingCellId(cellId);
    setEditDraft(nextDraft);
    setMenu(null);
  }, []);

  const updateEditDraft = useCallback((value: string) => {
    editDraftRef.current = value;
    setEditDraft(value);
  }, []);

  const moveTo = useCallback(
    (point: GridPoint, extend = false) => {
      const next = clampPoint(point, grid);
      setSelection((current) => ({
        anchor: extend ? current.anchor : next,
        focus: next,
      }));
      setMenu(null);
      focusStage();
    },
    [focusStage, grid],
  );

  const moveBy = useCallback(
    (rowDelta: number, colDelta: number, extend = false) => {
      moveTo({ row: selection.focus.row + rowDelta, col: selection.focus.col + colDelta }, extend);
    },
    [moveTo, selection.focus],
  );

  const moveTab = useCallback(
    (backward: boolean) => {
      let row = selection.focus.row;
      let col = selection.focus.col;

      if (backward) {
        if (col > 0) col -= 1;
        else if (row > 0) {
          row -= 1;
          col = Math.max(0, grid.colCount - 1);
        }
        moveTo({ row, col });
        return;
      }

      if (col < grid.colCount - 1) {
        moveTo({ row, col: col + 1 });
        return;
      }

      if (row < grid.rowCount - 1) {
        moveTo({ row: row + 1, col: 0 });
        return;
      }

      applyModel(
        (current) => insertRow(current, row, "after"),
        { anchor: { row: row + 1, col: 0 }, focus: { row: row + 1, col: 0 } },
        "已自动添加下一行。",
      );
    },
    [applyModel, grid.colCount, grid.rowCount, moveTo, selection.focus],
  );

  const moveDownAfterEdit = useCallback(() => {
    const row = selection.focus.row;
    const col = selection.focus.col;
    if (row < grid.rowCount - 1) {
      moveTo({ row: row + 1, col });
      return;
    }
    applyModel(
      (current) => insertRow(current, row, "after"),
      { anchor: { row: row + 1, col }, focus: { row: row + 1, col } },
      "已自动添加下一行。",
    );
  }, [applyModel, grid.rowCount, moveTo, selection.focus]);

  const commitEditing = useCallback(
    (move: "down" | "right" | "left" | null = null) => {
      const cellId = editingCellIdRef.current;
      if (!cellId) return;
      const content = plainTextToCellHtml(editDraftRef.current);
      editingCellIdRef.current = null;
      editDraftRef.current = "";
      dispatch({ type: "apply", update: (current) => updateCellContent(current, cellId, content) });
      setEditingCellId(null);
      setEditDraft("");

      if (move === "down") moveDownAfterEdit();
      if (move === "right") moveTab(false);
      if (move === "left") moveTab(true);
    },
    [moveDownAfterEdit, moveTab],
  );

  const cancelEditing = useCallback(() => {
    editingCellIdRef.current = null;
    editDraftRef.current = "";
    setEditingCellId(null);
    setEditDraft("");
    focusStage();
  }, [focusStage]);

  const handleEditorBlur = useCallback(() => {
    commitEditing(null);
  }, [commitEditing]);

  const handleCellMouseDown = useCallback(
    (event: ReactMouseEvent, point: GridPoint) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("textarea")) return;
      event.preventDefault();
      const next = clampPoint(point, gridRef.current);
      setDragging(true);
      setSelection((current) => ({
        anchor: event.shiftKey ? current.anchor : next,
        focus: next,
      }));
      setMenu(null);
      focusStage();
    },
    [focusStage],
  );

  const handleCellMouseEnter = useCallback(
    (point: GridPoint) => {
      if (!draggingRef.current) return;
      const next = clampPoint(point, gridRef.current);
      setSelection((current) => ({ ...current, focus: next }));
    },
    [],
  );

  const handleCellContextMenu = useCallback(
    (event: ReactMouseEvent, point: GridPoint) => {
      event.preventDefault();
      const currentGrid = gridRef.current;
      const next = clampPoint(point, currentGrid);
      if (!selectedIdsRef.current.has(getSlotCellId(currentGrid, next) ?? "")) {
        setSelection({ anchor: next, focus: next });
      }
      setMenu({ x: event.clientX, y: event.clientY });
      focusStage();
    },
    [focusStage],
  );

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        commitEditing("down");
      } else if (event.key === "Tab") {
        event.preventDefault();
        commitEditing(event.shiftKey ? "left" : "right");
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing();
      }
    },
    [cancelEditing, commitEditing],
  );

  const clearSelected = useCallback(() => {
    const ids = new Set(selectedIds);
    applyModel((current) => clearCellsContent(current, ids), undefined, "已清空选区。");
  }, [applyModel, selectedIds]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (editingCellId) return;

      const key = event.key;
      const isMod = event.metaKey || event.ctrlKey;

      if (isMod && key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        setStatus(event.shiftKey ? "已重做。" : "已撤销。");
        return;
      }

      if ((isMod && key.toLowerCase() === "y") || (isMod && event.shiftKey && key.toLowerCase() === "z")) {
        event.preventDefault();
        dispatch({ type: "redo" });
        setStatus("已重做。");
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        if (activeCellId) startEditing(activeCellId);
        return;
      }

      if (key === "Tab") {
        event.preventDefault();
        moveTab(event.shiftKey);
        return;
      }

      if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        const delta =
          key === "ArrowUp" ? [-1, 0] :
          key === "ArrowDown" ? [1, 0] :
          key === "ArrowLeft" ? [0, -1] :
          [0, 1];
        moveBy(delta[0], delta[1], event.shiftKey);
        return;
      }

      if (key === "Delete" || key === "Backspace") {
        event.preventDefault();
        clearSelected();
        return;
      }

      if (!isMod && !event.altKey && key.length === 1 && activeCellId) {
        event.preventDefault();
        startEditing(activeCellId, key);
      }
    },
    [activeCellId, clearSelected, editingCellId, moveBy, moveTab, startEditing],
  );

  const handleCopy = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (editingCellId) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", selectionToTsv(model, grid, selectedRect));
      setStatus("已复制 TSV。");
    },
    [editingCellId, grid, model, selectedRect],
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (editingCellId || !activeCellId) return;
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      const matrix = parseTsv(text);
      const targetRows = matrix.length;
      const targetCols = Math.max(...matrix.map((row) => row.length), 1);
      const start = activeOrigin ? { row: activeOrigin.rowIndex, col: activeOrigin.colIndex } : selection.focus;

      applyModel(
        (current) => pasteMatrix(current, activeCellId, matrix),
        {
          anchor: start,
          focus: { row: start.row + targetRows - 1, col: start.col + targetCols - 1 },
        },
        `已粘贴 ${targetRows} x ${targetCols}。`,
      );
    },
    [activeCellId, activeOrigin, applyModel, editingCellId, selection.focus],
  );

  const insertRowBefore = useCallback(() => {
    applyModel((current) => insertRow(current, selection.focus.row, "before"), {
      anchor: { row: selection.focus.row, col: selection.focus.col },
      focus: { row: selection.focus.row, col: selection.focus.col },
    });
  }, [applyModel, selection.focus]);

  const insertRowAfter = useCallback(() => {
    applyModel((current) => insertRow(current, selection.focus.row, "after"), {
      anchor: { row: selection.focus.row + 1, col: selection.focus.col },
      focus: { row: selection.focus.row + 1, col: selection.focus.col },
    });
  }, [applyModel, selection.focus]);

  const deleteCurrentRow = useCallback(() => {
    const removed = selectedRect.endRow - selectedRect.startRow + 1;
    const nextRow = Math.min(selectedRect.startRow, Math.max(0, grid.rowCount - removed - 1));
    const nextCol = Math.min(selection.focus.col, Math.max(0, grid.colCount - 1));

    applyModel((current) => deleteRows(current, selectedRect.startRow, selectedRect.endRow), {
      anchor: { row: nextRow, col: nextCol },
      focus: { row: nextRow, col: nextCol },
    }, removed === 1 ? `已删除第 ${selectedRect.startRow + 1} 行。` : `已删除 ${removed} 行。`);
  }, [applyModel, grid.colCount, grid.rowCount, selectedRect, selection.focus.col]);

  const insertColumnLeft = useCallback(() => {
    applyModel((current) => insertColumn(current, selection.focus.col, "before"), {
      anchor: { row: selection.focus.row, col: selection.focus.col },
      focus: { row: selection.focus.row, col: selection.focus.col },
    });
  }, [applyModel, selection.focus]);

  const insertColumnRight = useCallback(() => {
    applyModel((current) => insertColumn(current, selection.focus.col, "after"), {
      anchor: { row: selection.focus.row, col: selection.focus.col + 1 },
      focus: { row: selection.focus.row, col: selection.focus.col + 1 },
    });
  }, [applyModel, selection.focus]);

  const deleteCurrentColumn = useCallback(() => {
    const removed = selectedRect.endCol - selectedRect.startCol + 1;
    const nextRow = Math.min(selection.focus.row, Math.max(0, grid.rowCount - 1));
    const nextCol = Math.min(selectedRect.startCol, Math.max(0, grid.colCount - removed - 1));

    applyModel((current) => deleteColumns(current, selectedRect.startCol, selectedRect.endCol), {
      anchor: { row: nextRow, col: nextCol },
      focus: { row: nextRow, col: nextCol },
    }, removed === 1 ? `已删除第 ${selectedRect.startCol + 1} 列。` : `已删除 ${removed} 列。`);
  }, [applyModel, grid.colCount, grid.rowCount, selectedRect, selection.focus.row]);

  const mergeSelection = useCallback(() => {
    applyModel((current) => mergeSelectedCells(current, selectedRect), { anchor: { row: selectedRect.startRow, col: selectedRect.startCol }, focus: { row: selectedRect.startRow, col: selectedRect.startCol } });
  }, [applyModel, selectedRect]);

  const splitActiveCell = useCallback(() => {
    if (!activeCellId) return;
    applyModel((current) => splitCell(current, activeCellId), undefined, "已拆分当前单元格。");
  }, [activeCellId, applyModel]);

  const toggleActiveTag = useCallback(() => {
    if (!activeCellId) return;
    applyModel((current) => switchCellTag(current, activeCellId), undefined, "已切换 td/th。");
  }, [activeCellId, applyModel]);

  const applySelectedStyle = useCallback(
    (stylePatch: Record<string, string | null>) => {
      const ids = new Set(selectedIds);
      applyModel((current) => setCellsStyle(current, ids, stylePatch));
    },
    [applyModel, selectedIds],
  );

  const clearStyle = useCallback(() => {
    const ids = new Set(selectedIds);
    applyModel((current) => clearCellsStyle(current, ids), undefined, "已清除 style。");
  }, [applyModel, selectedIds]);

  const clearClass = useCallback(() => {
    const ids = new Set(selectedIds);
    applyModel((current) => clearCellsClass(current, ids), undefined, "已清除 class。");
  }, [applyModel, selectedIds]);

  const copyHtml = useCallback(async () => {
    await writeClipboard(liveHtmlString);
    setStatus("已复制 HTML table。");
    focusStage();
  }, [focusStage, liveHtmlString]);

  const openSourceView = useCallback(() => {
    setSourceMode("view");
    setSourceOpen(true);
    setMenu(null);
  }, []);

  const openSourceImport = useCallback(() => {
    setSourceMode("import");
    setSourceText(liveHtmlString);
    setSourceOpen(true);
    setMenu(null);
  }, [liveHtmlString]);

  const importSource = useCallback(() => {
    try {
      const next = parseTableHtml(sourceText);
      dispatch({ type: "replace", model: next });
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } });
      setSourceOpen(false);
      setSourceMode("view");
      setStatus("已导入 HTML table。");
      focusStage();
    } catch (error) {
      const message = error instanceof TableParseError ? error.message : "HTML 解析失败。";
      setStatus(message);
    }
  }, [focusStage, sourceText]);

  const applyBatchReplace = useCallback(() => {
    applyModel((current) => batchReplace(current, findText, replaceText, selectedRect), undefined, "已替换选区文本。");
  }, [applyModel, findText, replaceText, selectedRect]);

  const applyBatchTrim = useCallback(() => {
    applyModel((current) => batchTrim(current, selectedRect), undefined, "已清理选区首尾空格。");
  }, [applyModel, selectedRect]);

  const changeZoom = useCallback((delta: number) => {
    setZoom((current) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((current + delta).toFixed(2)))));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
  }, []);

  const rowsBySection = useMemo(() => {
    return {
      thead: model.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.section === "thead"),
      tbody: model.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.section === "tbody"),
      tfoot: model.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.section === "tfoot"),
    };
  }, [model.rows]);

  const renderSection = (section: "thead" | "tbody" | "tfoot") => {
    const rows = rowsBySection[section];
    if (rows.length === 0 && section !== "tbody") return null;
    const SectionTag = section;

    return (
      <SectionTag>
        {rows.map(({ row, index }) => (
          <tr key={row.id} data-row-id={row.id} data-row-index={index}>
            {row.cells.map((cell) => {
              const origin = grid.origins.get(cell.id);
              if (!origin) return null;
              return (
                <TableCellView
                  key={cell.id}
                  cell={cell}
                  origin={origin}
                  selected={selectedIds.has(cell.id)}
                  active={activeCellId === cell.id}
                  editing={editingCellId === cell.id}
                  draft={editingCellId === cell.id ? editDraft : ""}
                  onDraftChange={updateEditDraft}
                  onEditorKeyDown={editingCellId === cell.id ? handleEditorKeyDown : noopEditorKeyDown}
                  onEditorBlur={handleEditorBlur}
                  onCellMouseDown={handleCellMouseDown}
                  onCellMouseEnter={handleCellMouseEnter}
                  onCellDoubleClick={startEditing}
                  onCellContextMenu={handleCellContextMenu}
                />
              );
            })}
          </tr>
        ))}
      </SectionTag>
    );
  };

  const selectedSize = `${selectedRect.endRow - selectedRect.startRow + 1}x${selectedRect.endCol - selectedRect.startCol + 1}`;
  const activeLabel = activeOrigin ? `R${activeOrigin.rowIndex + 1}C${activeOrigin.colIndex + 1}` : "R1C1";

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={openSourceImport}>导入HTML</button>
        <button type="button" onClick={copyHtml}>复制HTML</button>
        <button type="button" onClick={openSourceView}>HTML</button>
        <span className="split" />
        <button type="button" disabled={history.past.length === 0} onClick={() => dispatch({ type: "undo" })}>撤销</button>
        <button type="button" disabled={history.future.length === 0} onClick={() => dispatch({ type: "redo" })}>重做</button>
        <span className="split" />
        <button type="button" onClick={insertRowBefore}>上行</button>
        <button type="button" onClick={insertRowAfter}>下行</button>
        <button type="button" onClick={deleteCurrentRow}>删行</button>
        <button type="button" onClick={insertColumnLeft}>左列</button>
        <button type="button" onClick={insertColumnRight}>右列</button>
        <button type="button" onClick={deleteCurrentColumn}>删列</button>
        <button type="button" onClick={mergeSelection}>合并</button>
        <button type="button" onClick={splitActiveCell}>拆分</button>
        <button type="button" onClick={toggleActiveTag}>td/th</button>
        <span className="split" />
        <button type="button" title="缩小表格" onClick={() => changeZoom(-ZOOM_STEP)}>－</button>
        <button type="button" title="恢复 100% 缩放" onClick={resetZoom}>{Math.round(zoom * 100)}%</button>
        <button type="button" title="放大表格" onClick={() => changeZoom(ZOOM_STEP)}>＋</button>
        <span className="status">
          {activeLabel} · {selectedSize}
          {activeCell ? ` · ${activeCell.tag}` : ""}
          {status ? ` · ${status}` : ""}
        </span>
      </div>

      <div
        ref={stageRef}
        className="table-scroll"
        style={{ "--table-zoom": zoom } as CSSProperties}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onPaste={handlePaste}
      >
        <table {...getTableReactProps(model.attrs)}>
          <colgroup>
            {Array.from({ length: grid.colCount }, (_, index) => (
              <col key={index} />
            ))}
          </colgroup>
          {renderSection("thead")}
          {renderSection("tbody")}
          {renderSection("tfoot")}
        </table>
      </div>

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menuButton("插入上一行", insertRowBefore)}
          {menuButton("插入下一行", insertRowAfter)}
          {menuButton("删除选区行", deleteCurrentRow)}
          {menuButton("插入左列", insertColumnLeft)}
          {menuButton("插入右列", insertColumnRight)}
          {menuButton("删除选区列", deleteCurrentColumn)}
          <span />
          {menuButton("合并选中单元格", mergeSelection)}
          {menuButton("拆分当前单元格", splitActiveCell)}
          {menuButton("td / th 切换", toggleActiveTag)}
          <span />
          {menuButton("左对齐", () => applySelectedStyle({ "text-align": "left" }))}
          {menuButton("居中", () => applySelectedStyle({ "text-align": "center" }))}
          {menuButton("右对齐", () => applySelectedStyle({ "text-align": "right" }))}
          {menuButton("顶部对齐", () => applySelectedStyle({ "vertical-align": "top" }))}
          {menuButton("垂直居中", () => applySelectedStyle({ "vertical-align": "middle" }))}
          {menuButton("底部对齐", () => applySelectedStyle({ "vertical-align": "bottom" }))}
          <span />
          {menuButton("清空内容", clearSelected)}
          {menuButton("清除 style", clearStyle)}
          {menuButton("清除 class", clearClass)}
        </div>
      )}

      <div className={`source-panel ${sourceOpen ? "is-open" : ""}`}>
        <div className="source-toolbar">
          {sourceMode === "import" ? (
            <button type="button" onClick={importSource}>应用导入</button>
          ) : (
            <button type="button" onClick={openSourceImport}>编辑导入</button>
          )}
          <button type="button" onClick={copyHtml}>复制</button>
          <button type="button" onClick={openSourceView}>实时HTML</button>
          <button type="button" onClick={() => {
            setSourceOpen(false);
            setSourceMode("view");
          }}>关闭</button>
          <details className="batch-tools">
            <summary>批量</summary>
            <input value={findText} onChange={(event) => setFindText(event.target.value)} placeholder="查找" />
            <input value={replaceText} onChange={(event) => setReplaceText(event.target.value)} placeholder="替换" />
            <button type="button" onClick={applyBatchReplace}>替换</button>
            <button type="button" title="清理选中单元格内容开头和结尾的空格、换行、Tab" onClick={applyBatchTrim}>去首尾空白</button>
          </details>
        </div>
        <textarea
          className="source-textarea"
          value={sourceMode === "import" ? sourceText : liveHtmlString}
          readOnly={sourceMode === "view"}
          spellCheck={false}
          onChange={(event) => {
            if (sourceMode === "import") setSourceText(event.target.value);
          }}
        />
      </div>
    </div>
  );
}
