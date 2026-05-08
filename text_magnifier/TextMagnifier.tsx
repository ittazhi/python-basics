import { useEffect, useState } from "react";
import "./TextMagnifier.css";

type LensState = {
  x: number;
  y: number;
  text: string;
  source: string;
};

type TextMagnifierProps = {
  enabled: boolean;
  scale?: number;
  lensWidth?: number;
  lensHeight?: number;
  onRequestDisable?: () => void;
};

const LENS_OFFSET = 16;
const VIEWPORT_MARGIN = 8;
const MAX_PREVIEW_LENGTH = 1400;
const TEXT_TARGET_SELECTOR = [
  "textarea",
  "input[type='text']",
  "input[type='search']",
  "input:not([type])",
  ".cell-content",
  ".table-cell",
].join(",");

function isTextInput(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement;
}

function normalizeText(text: string): string {
  return text.replace(/\u00a0/g, " ");
}

function hasReadableText(text: string): boolean {
  return text.trim().length > 0;
}

function truncatePreview(text: string): string {
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return `${text.slice(0, MAX_PREVIEW_LENGTH)}...`;
}

function getFormSelection(element: HTMLInputElement | HTMLTextAreaElement): string | null {
  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (start === null || end === null || start === end) return null;
  const selectedText = normalizeText(element.value.slice(Math.min(start, end), Math.max(start, end)));
  return hasReadableText(selectedText) ? selectedText : null;
}

function getFormPreview(element: HTMLInputElement | HTMLTextAreaElement): string | null {
  const value = normalizeText(element.value);
  if (!hasReadableText(value)) return null;

  const caret = element === document.activeElement ? element.selectionStart : null;
  if (caret === null) return truncatePreview(value);

  const lineStart = element.value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const lineEndIndex = element.value.indexOf("\n", caret);
  const lineEnd = lineEndIndex === -1 ? element.value.length : lineEndIndex;
  const line = normalizeText(element.value.slice(lineStart, lineEnd));

  return truncatePreview(hasReadableText(line) ? line : value);
}

function getDocumentSelection(): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (element?.closest(".text-magnifier-lens")) return null;

  const selectedText = normalizeText(selection.toString());
  return hasReadableText(selectedText) ? selectedText : null;
}

function getTargetText(target: EventTarget | null): { text: string; source: string } | null {
  if (!(target instanceof Element)) return null;

  const textTarget = target.closest(TEXT_TARGET_SELECTOR);
  if (!textTarget || textTarget.closest(".toolbar, .context-menu")) return null;

  if (isTextInput(textTarget)) {
    const selectedText = getFormSelection(textTarget);
    if (selectedText) {
      return { text: truncatePreview(selectedText), source: "文本框选区" };
    }

    const preview = getFormPreview(textTarget);
    return preview ? { text: preview, source: "文本框内容" } : null;
  }

  const text = normalizeText(textTarget.textContent ?? "");
  return hasReadableText(text) ? { text: truncatePreview(text), source: "单元格内容" } : null;
}

function clampLensPosition(clientX: number, clientY: number, width: number, height: number): { x: number; y: number } {
  let x = clientX + LENS_OFFSET;
  let y = clientY + LENS_OFFSET;

  if (x + width + VIEWPORT_MARGIN > window.innerWidth) {
    x = clientX - width - LENS_OFFSET;
  }
  if (y + height + VIEWPORT_MARGIN > window.innerHeight) {
    y = clientY - height - LENS_OFFSET;
  }

  return {
    x: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN)),
    y: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - VIEWPORT_MARGIN)),
  };
}

export function TextMagnifier({
  enabled,
  scale = 2,
  lensWidth = 260,
  lensHeight = 120,
  onRequestDisable,
}: TextMagnifierProps) {
  const [lens, setLens] = useState<LensState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLens(null);
      return;
    }

    const updateLens = (event: MouseEvent) => {
      const documentSelection = getDocumentSelection();
      const targetText = getTargetText(event.target);
      const content = documentSelection
        ? { text: truncatePreview(documentSelection), source: "手动选中文本" }
        : targetText;

      if (!content) {
        setLens(null);
        return;
      }

      const position = clampLensPosition(event.clientX, event.clientY, lensWidth, lensHeight);
      setLens({ ...position, ...content });
    };

    const hideLens = () => setLens(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLens(null);
        onRequestDisable?.();
      }
    };

    window.addEventListener("mousemove", updateLens);
    window.addEventListener("scroll", hideLens, true);
    window.addEventListener("blur", hideLens);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousemove", updateLens);
      window.removeEventListener("scroll", hideLens, true);
      window.removeEventListener("blur", hideLens);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, lensHeight, lensWidth, onRequestDisable]);

  if (!enabled || !lens) return null;

  return (
    <div
      className="text-magnifier-lens"
      style={{
        left: lens.x,
        top: lens.y,
        width: lensWidth,
        height: lensHeight,
      }}
      aria-hidden="true"
    >
      <div className="text-magnifier-source">{lens.source} · {scale}x</div>
      <div className="text-magnifier-content" style={{ fontSize: `${12 * scale}px` }}>
        {lens.text}
      </div>
    </div>
  );
}
