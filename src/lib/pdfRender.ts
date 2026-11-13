/** Draws pages of a stored PDF for the page preview. */
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdfjs } from './pdfjs';

// One PDF stays open at a time: the one being read.
let open: { id: string; pdf: Promise<PDFDocumentProxy>; close: () => void } | null = null;

export function openPdf(id: string, file: Blob): Promise<PDFDocumentProxy> {
  if (open?.id === id) return open.pdf;
  open?.close();
  let close = () => {};
  const pdf = (async () => {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    close = () => void task.destroy();
    return task.promise;
  })();
  const entry = { id, pdf, close: () => close() };
  open = entry;
  // A file that cannot be opened is not kept, so the next attempt starts again.
  pdf.catch(() => {
    if (open === entry) open = null;
  });
  return pdf;
}

/**
 * Draws one page onto `canvas`, `cssWidth` CSS pixels wide. Returns a
 * function that cancels the drawing if it is still running.
 */
export function renderPdfPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  onDone: (ok: boolean) => void,
): () => void {
  let cancelled = false;
  let task: RenderTask | null = null;
  void (async () => {
    try {
      const page = await pdf.getPage(Math.min(Math.max(1, pageNumber), pdf.numPages));
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      const pixels = cssWidth * Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: pixels / natural.width });
      // Drawn off screen first, so the visible page never shows half a drawing.
      const buffer = document.createElement('canvas');
      buffer.width = Math.floor(viewport.width);
      buffer.height = Math.floor(viewport.height);
      task = page.render({ canvas: buffer, viewport });
      await task.promise;
      if (cancelled) return;
      canvas.width = buffer.width;
      canvas.height = buffer.height;
      canvas.getContext('2d')?.drawImage(buffer, 0, 0);
      onDone(true);
    } catch {
      if (!cancelled) onDone(false);
    }
  })();
  return () => {
    cancelled = true;
    task?.cancel();
  };
}
