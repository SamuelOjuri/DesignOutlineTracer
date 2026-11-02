import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Download, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Point, ProjectDetails } from "@/types/roof";
import type { PageSession } from "@/types/roi";
import { PROJECT_DETAIL_FIELDS } from "@/lib/projectDetailsFields";
import { buildRoofExport } from "@/utils/drawingExport";
import { enteredFieldCount } from "@/utils/projectDetailsCsv";
import { buildProjectPackage } from "@/utils/projectPackage";
import { renderDrawingPng, renderMarkedUpPagePng, renderMaskPng } from "@/utils/roofRender";
import { downloadBlob } from "@/utils/specDocument";

interface PackageDownloadProps {
  projectDetails: ProjectDetails;
  specDocument: File | null;
  /** Original roof plan PDFs keyed by document_id. */
  roofPlanFiles: Record<string, File>;
  pages: PageSession[];
  illustrationOffsets: Record<string, Point>;
}

type ItemState = "ready" | "optional" | "missing";

const ItemIcon = ({ state }: { state: ItemState }) => state === "ready"
  ? <CheckCircle2 className="w-4 h-4 shrink-0 text-green-600" aria-hidden />
  : state === "missing"
    ? <XCircle className="w-4 h-4 shrink-0 text-destructive" aria-hidden />
    : <Circle className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />;

export const PackageDownload = ({ projectDetails, specDocument, roofPlanFiles, pages, illustrationOffsets }: PackageDownloadProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const roofExport = useMemo(() => buildRoofExport(pages, illustrationOffsets), [pages, illustrationOffsets]);
  const populated = useMemo(() => pages.filter(page => page.drawing.outlines.some(outline => outline.points.length >= 3)), [pages]);
  const documentIds = [...new Set(populated.map(page => page.source.document_id))];
  const roofPlans = documentIds.flatMap(id => roofPlanFiles[id] ? [roofPlanFiles[id]] : []);
  const missingPlans = documentIds.length - roofPlans.length;
  const entered = enteredFieldCount(projectDetails);

  const items: { label: string; detail: string; state: ItemState }[] = [
    { label: "Performance specification PDF", state: specDocument ? "ready" : "optional",
      detail: specDocument ? specDocument.name : "Not attached (optional)" },
    { label: "Project details CSV", state: "ready", detail: `${entered} of ${PROJECT_DETAIL_FIELDS.length} fields entered` },
    { label: "Roof plan PDF", state: roofPlans.length && !missingPlans ? "ready" : "missing",
      detail: !documentIds.length ? "No roof plan with an outline"
        : missingPlans ? "Re-upload the roof plan PDF in Step 1" : roofPlans.map(file => file.name).join(", ") },
    { label: "Roof drawing (DXF, SVG, GeoJSON, PNG)", state: roofExport ? "ready" : "missing",
      detail: roofExport
        ? `${roofExport.model.totals.roof_areas} roof area(s), ${roofExport.model.totals.outlets} outlet(s)`
        : "Define a roof outline first" },
    { label: "TRICS design prompt", state: roofExport ? "ready" : "missing", detail: "Generated with the package" },
  ];
  const blocked = !roofExport || !roofPlans.length || missingPlans > 0;

  const handleDownload = async () => {
    if (!roofExport || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const drawingPng = await renderDrawingPng({ ...roofExport.drawing,
        outlineIds: roofExport.drawing.outlineRefs.map(reference => reference.id) });
      const maskPng = await renderMaskPng(roofExport.model);
      const markedUpPages = [];
      for (const page of populated) {
        markedUpPages.push({ document_id: page.source.document_id, page_id: page.source.page_id,
          page_index: page.source.page_index, blob: await renderMarkedUpPagePng(page) });
      }
      const result = await buildProjectPackage({ projectDetails, specDocument, roofPlans, model: roofExport.model,
        drawingPng, maskPng, markedUpPages, generatedAt: new Date() });
      downloadBlob(result.blob, result.fileName);
      toast({ title: "Package downloaded", description: result.fileName });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The package could not be created.";
      setError(message);
      toast({ title: "Package not created", description: message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Download package" className="space-y-3">
      <ul className="space-y-1.5" aria-label="Package contents">
        {items.map(item => (
          <li key={item.label} className="flex items-start gap-2 text-xs" data-state={item.state}>
            <ItemIcon state={item.state} />
            <span className="min-w-0">
              <span className="font-medium text-foreground">{item.label}</span>
              <span className="block text-muted-foreground break-all">{item.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {!specDocument && (
        <p className="flex items-start gap-2 text-xs text-amber-700" role="status">
          <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden />
          No performance specification attached: the package will not include target U-values, insulation, membrane or decking.
        </p>
      )}
      <Button type="button" className="w-full" onClick={handleDownload} disabled={blocked || busy}>
        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
        {busy ? "Preparing package..." : "Download package (.zip)"}
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
};
