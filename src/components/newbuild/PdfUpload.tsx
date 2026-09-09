import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUp, Loader2, Ruler } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { DrawingScale } from "@/types/roof";
import type { RenderedPdfPage } from "@/types/roi";
import { capturePdfPage, readBlobBytes, sha256 } from "@/utils/roiSource";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PAPER_SIZES: { label: string; widthMm: number; heightMm: number }[] = [
  { label: "A0", widthMm: 841, heightMm: 1189 },
  { label: "A1", widthMm: 594, heightMm: 841 },
  { label: "A2", widthMm: 420, heightMm: 594 },
  { label: "A3", widthMm: 297, heightMm: 420 },
  { label: "A4", widthMm: 210, heightMm: 297 },
];

const COMMON_SCALES = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500];

interface PdfUploadProps {
  onPdfRendered: (imageData: HTMLCanvasElement) => void;
  onPageRendered?: (page: RenderedPdfPage, canvas: HTMLCanvasElement) => void;
  onPageSelectionStart?: () => void;
  drawingScale: DrawingScale;
  onDrawingScaleChange: (scale: DrawingScale) => void;
}

export const PdfUpload = ({ onPdfRendered, onPageRendered, onPageSelectionStart, drawingScale, onDrawingScaleChange }: PdfUploadProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPage, setSelectedPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState<{ pdf: pdfjsLib.PDFDocumentProxy; documentId: string; fileName: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const renderTask = useRef<pdfjsLib.RenderTask | null>(null);
  const loadingTask = useRef<ReturnType<typeof pdfjsLib.getDocument> | null>(null);
  const callbacks = useRef({ onPageRendered, onPdfRendered });

  useEffect(() => {
    callbacks.current = { onPageRendered, onPdfRendered };
  }, [onPageRendered, onPdfRendered]);

  useEffect(() => () => {
    generation.current += 1;
    renderTask.current?.cancel();
    void loadingTask.current?.destroy();
  }, []);

  const startSelection = () => {
    generation.current += 1;
    renderTask.current?.cancel();
    setIsLoading(true);
    setError(null);
    setPreviewUrl(null);
    onPageSelectionStart?.();
    return generation.current;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || file.type !== "application/pdf") return;

    const selection = startSelection();
    void loadingTask.current?.destroy();
    setPdfDoc(null);
    setPageCount(0);
    setFileName(file.name);

    try {
      const arrayBuffer = await readBlobBytes(file);
      const documentId = `document_${await sha256(arrayBuffer)}`;
      if (selection !== generation.current) return;
      const task = pdfjsLib.getDocument({ data: arrayBuffer });
      loadingTask.current = task;
      const pdf = await task.promise;
      if (selection !== generation.current) return;
      const document = { pdf, documentId, fileName: file.name };
      setPdfDoc(document);
      setPageCount(pdf.numPages);
      setSelectedPage(1);

      await renderPage(document, 1, selection);
    } catch {
      if (selection === generation.current) setError("Unable to load the selected PDF page. Please try again.");
    } finally {
      if (selection === generation.current) setIsLoading(false);
    }
  };

  const renderPage = async (documentContext: NonNullable<typeof pdfDoc>, pageNum: number, selection: number) => {
    const page = await documentContext.pdf.getPage(pageNum);
    if (selection !== generation.current) return;
    const scale = 2; // Higher resolution
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d")!;

    const task = page.render({ canvasContext: ctx, viewport });
    renderTask.current = task;
    await task.promise;
    if (selection !== generation.current) return;
    const source = await capturePdfPage(canvas, {
      document_id: documentContext.documentId,
      file_name: documentContext.fileName,
      page_index: pageNum - 1,
      render_scale: viewport.scale,
      render_rotation: viewport.rotation,
      render_version: `pdfjs-${pdfjsLib.version}-png-v1`,
      pdf_view_box: viewport.viewBox,
    });
    if (selection !== generation.current) return;

    setPreviewUrl(canvas.toDataURL());
    callbacks.current.onPageRendered?.(source, canvas);
    callbacks.current.onPdfRendered(canvas);
  };

  const handlePageChange = async (pageNum: number) => {
    if (!pdfDoc || pageNum < 1 || pageNum > pageCount) return;
    const selection = startSelection();
    setSelectedPage(pageNum);
    try {
      await renderPage(pdfDoc, pageNum, selection);
    } catch {
      if (selection === generation.current) setError("Unable to load the selected PDF page. Please try again.");
    } finally {
      if (selection === generation.current) setIsLoading(false);
    }
  };

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Upload Roof Plan</h3>

      <div className="space-y-4">
        <div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary transition-colors">
          <FileUp className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground mb-4">
            Upload a PDF file containing your roof plan
          </p>
          <Input
            type="file"
            accept="application/pdf"
            onChange={handleFileUpload}
            className="max-w-xs mx-auto"
          />
        </div>

        {isLoading && (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-6 h-6 animate-spin text-primary mr-2" />
            <span className="text-sm text-muted-foreground">Loading PDF...</span>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        {fileName && !isLoading && (
          <div className="p-3 bg-muted rounded-lg">
            <p className="text-sm font-medium">📄 {fileName}</p>
            {pageCount > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Page:</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(selectedPage - 1)}
                  disabled={selectedPage <= 1}
                >
                  ←
                </Button>
                <span className="text-sm font-medium">
                  {selectedPage} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(selectedPage + 1)}
                  disabled={selectedPage >= pageCount}
                >
                  →
                </Button>
              </div>
            )}
          </div>
        )}

        {previewUrl && (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground mb-2">Preview:</p>
            <img
              src={previewUrl}
              alt="PDF Preview"
              className="w-full border border-border rounded-lg"
            />
          </div>
        )}

        {/* Drawing Scale */}
        <Card className="p-4 bg-muted/50">
          <div className="flex items-center gap-2 mb-3">
            <Ruler className="w-4 h-4 text-primary" />
            <h4 className="text-sm font-semibold">Drawing Scale</h4>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Paper Size</Label>
              <Select
                value={drawingScale.paperSize}
                onValueChange={(v) => onDrawingScaleChange({ ...drawingScale, paperSize: v })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAPER_SIZES.map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label} ({p.widthMm}×{p.heightMm}mm)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Scale Ratio</Label>
              <Select
                value={String(drawingScale.scaleRatio)}
                onValueChange={(v) => onDrawingScaleChange({ ...drawingScale, scaleRatio: Number(v) })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_SCALES.map((s) => (
                    <SelectItem key={s} value={String(s)}>
                      1:{s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Currently set to <strong>{drawingScale.paperSize} @ 1:{drawingScale.scaleRatio}</strong> — this ensures exported outlines match real-world dimensions.
          </p>
        </Card>

        <div className="p-3 bg-muted rounded-lg">
          <p className="text-sm text-muted-foreground">
            Upload a PDF of your roof plan. Select the correct page if the PDF has multiple pages, then proceed to define the roof area.
          </p>
        </div>
      </div>
    </Card>
  );
};
