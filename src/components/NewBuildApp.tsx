import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { NewBuildStepHeader } from "./newbuild/NewBuildStepHeader";
import { PdfUpload } from "./newbuild/PdfUpload";
import { PaintBucketCanvas } from "./newbuild/PaintBucketCanvas";
import { NewBuildOutletCanvas } from "./newbuild/NewBuildOutletCanvas";
import { NewBuildSidebar } from "./newbuild/NewBuildSidebar";
import { RoofIllustrationCanvas } from "./newbuild/RoofIllustrationCanvas";
import { ProjectDetailsForm } from "./ProjectDetailsForm";
import {
  NewBuildStep,
  Outlet,
  Point,
  ProjectDetails,
  RoofOutline,
  DrawingScale,
} from "@/types/roof";
import type { Box2D, PageDrawing, RenderedPdfPage } from "@/types/roi";
import { useRoiSession } from "@/hooks/useRoiSession";
import { useRoiDetection } from "@/hooks/useRoiDetection";
import { roiClient } from "@/integrations/roi/client";
import { RoiReviewCanvas } from "./newbuild/RoiReviewCanvas";
import { RoiReviewSidebar } from "./newbuild/RoiReviewSidebar";
import { combinePageDrawings, editorDrainage, reconcilePolygons, shiftedOffsets } from "@/utils/roiDrawing";
import { FileUp } from "lucide-react";

const ignoreRenderedCanvas = () => undefined;

export const NewBuildApp = () => {
  const [currentStep, setCurrentStep] = useState<NewBuildStep>("upload");
  const session = useRoiSession();
  const { state, dispatch, activePage, getActivePage } = session;
  const detection = useRoiDetection(session);
  const [selectedRoiId, setSelectedRoiId] = useState<string | null>(null);
  const [addingRoi, setAddingRoi] = useState(false);
  const roofRegions = activePage?.annotations.filter((annotation) => annotation.kind === "roof_roi") ?? [];
  const acceptedRegions = roofRegions.filter((annotation) => annotation.review_status === "accepted" && annotation.validity === "current");
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const [uploadScale, setUploadScale] = useState<DrawingScale>({ paperSize: "A1", scaleRatio: 100 });
  const [selectionPending, setSelectionPending] = useState(false);
  const [illustrationOffsets, setIllustrationOffsets] = useState<Record<string, Point>>({});
  const additionalReturnPage = useRef<string | null>(null);
  const pdfCanvas = activePage ? canvases.current.get(activePage.source.page_id) ?? null : null;
  const roofOutlines = activePage?.drawing.outlines.map((outline) => outline.points) ?? [];
  const interiorHoles = activePage?.drawing.holes.map((hole) => hole.points) ?? [];
  const outlets = activePage?.drawing.outlets ?? [];
  const drainageEdges = activePage ? editorDrainage(activePage) : [];
  const drawingScale = activePage?.drawing.drawing_scale ?? uploadScale;
  const combined = combinePageDrawings(Object.values(state.pages), illustrationOffsets);
  const saved = combinePageDrawings(Object.values(state.pages).filter((page) => page.source.page_id !== state.active_page_id));
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [outletMode, setOutletMode] = useState<'add-outlets' | 'drainage-edge'>('add-outlets');
  const [showAdditionalUpload, setShowAdditionalUpload] = useState(false);
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>({
    name: "",
    company: "",
    email: "",
    projectName: "",
    projectAddress: "",
    targetUValue: "",
    productType: "",
    deckType: "",
    additionalNotes: "",
    maxInsulationHeight: "",
    account: "",
    fallType: "",
    waterproofingType: "",
    buildMethod: "",
  });

  const handlePageRendered = (source: RenderedPdfPage, canvas: HTMLCanvasElement) => {
    canvases.current.set(source.page_id, canvas);
    dispatch({ type: "activate", source, scale: uploadScale });
    setSelectionPending(false);
    setSelectedOutlet(null);
    setSelectedRoiId(null);
    setAddingRoi(false);
  };

  const handlePageSelectionStart = () => {
    setUploadScale(drawingScale);
    setSelectionPending(true);
    setSelectedOutlet(null);
    dispatch({ type: "select", page_id: null });
  };

  const updateDrawing = (update: (drawing: PageDrawing) => PageDrawing) => {
    const page = getActivePage();
    if (!page || page.source.page_id !== activePage?.source.page_id) return;
    dispatch({ type: "drawing", page_id: page.source.page_id, drawing: update(page.drawing) });
  };

  const handleDrawingScaleChange = (scale: DrawingScale) => {
    setUploadScale(scale);
    updateDrawing((drawing) => ({ ...drawing, drawing_scale: scale }));
  };

  const handleOutlinesExtracted = (outlines: Point[][], editedIndex?: number) => {
    updateDrawing((drawing) => {
      const next = reconcilePolygons(drawing.outlines, outlines, activePage!.source.page_id, editedIndex);
      return { ...drawing, outlines: next, drainage_edges: drawing.drainage_edges.filter((edge) => {
        const previous = drawing.outlines.find((outline) => outline.id === edge.outline_id);
        const current = next.find((outline) => outline.id === edge.outline_id);
        return current && previous?.points.length === current.points.length;
      }) };
    });
  };

  const handleHolesExtracted = (holes: Point[][]) => updateDrawing((drawing) => ({ ...drawing,
    holes: reconcilePolygons(drawing.holes, holes, activePage!.source.page_id) }));

  const handleAddOutlet = (x: number, y: number) => {
    updateDrawing((drawing) => ({ ...drawing, outlets: [...drawing.outlets,
      { id: crypto.randomUUID(), page_id: activePage!.source.page_id, x, y, diameter: 0.15 }] }));
  };

  const handleDeleteOutlet = (id: string) => {
    updateDrawing((drawing) => ({ ...drawing, outlets: drawing.outlets.filter((outlet) => outlet.id !== id) }));
    if (selectedOutlet?.id === id) setSelectedOutlet(null);
  };

  const handleMoveOutlet = (id: string, x: number, y: number) => {
    updateDrawing((drawing) => ({ ...drawing, outlets: drawing.outlets.map((outlet) => outlet.id === id ? { ...outlet, x, y } : outlet) }));
    if (selectedOutlet?.id === id) {
      setSelectedOutlet((prev) => (prev ? { ...prev, x, y } : null));
    }
  };

  const handleToggleDrainageEdge = (outlineIndex: number, edgeIndex: number) => {
    updateDrawing((drawing) => {
      const outline = drawing.outlines[outlineIndex];
      if (!outline) return drawing;
      const exists = drawing.drainage_edges.find((edge) => edge.outline_id === outline.id && edge.edge_index === edgeIndex);
      return { ...drawing, drainage_edges: exists ? drawing.drainage_edges.filter((edge) => edge !== exists)
        : [...drawing.drainage_edges, { outline_id: outline.id, edge_index: edgeIndex }] };
    });
  };

  const buildOutlines = (): RoofOutline[] =>
    combined.roofOutlines.map((points) => ({
      segments: [],
      startPoint: points[0] || { x: 0, y: 0 },
      currentPoint: points[points.length - 1] || { x: 0, y: 0 },
      polygonPoints: points,
    }));

  const stepOrder: NewBuildStep[] = roiClient.enabled ? ["upload", "roi", "paint", "outlets", "details"]
    : ["upload", "paint", "outlets", "details"];

  const editRoi = (id: string, box_2d: Box2D) => {
    if (activePage) dispatch({ type: "review", page_id: activePage.source.page_id, id, patch: { box_2d } });
  };

  const addRoi = (box: Box2D) => {
    if (!activePage) return;
    const id = crypto.randomUUID();
    dispatch({ type: "add", page_id: activePage.source.page_id, annotation: {
      id, page_id: activePage.source.page_id, kind: "roof_roi", label: `Roof area ${roofRegions.length + 1}`,
      box_2d: box, proposed_box_2d: box, roi_id: null, origin: "manual", review_status: "accepted", validity: "current",
      revision: 1, edits: [], warnings: [],
    } });
    setSelectedRoiId(id);
    setAddingRoi(false);
  };

  const handleNext = () => {
    detection.cancel();
    setAddingRoi(false);
    if (showAdditionalUpload) {
      setShowAdditionalUpload(false);
      setCurrentStep(roiClient.enabled ? "roi" : "paint");
      return;
    }
    const idx = stepOrder.indexOf(currentStep);
    if (idx < stepOrder.length - 1) {
      setCurrentStep(stepOrder[idx + 1]);
    }
  };

  const cancelAdditionalUpload = () => {
    dispatch({ type: "select", page_id: additionalReturnPage.current });
    setSelectionPending(false);
    setShowAdditionalUpload(false);
  };

  const handlePrev = () => {
    detection.cancel();
    setAddingRoi(false);
    if (showAdditionalUpload) return cancelAdditionalUpload();
    const idx = stepOrder.indexOf(currentStep);
    if (idx > 0) setCurrentStep(stepOrder[idx - 1]);
  };

  const canProceed = (): boolean => {
    if (selectionPending || !activePage) return false;
    if (showAdditionalUpload) return activePage.source.page_id !== additionalReturnPage.current;
    switch (currentStep) {
      case "upload":
      case "roi":
        return pdfCanvas !== null;
      case "paint":
        return roofOutlines.length > 0 && roofOutlines.some((o) => o.length > 2);
      case "outlets":
        return true;
      case "details":
        return !!(projectDetails.projectName && projectDetails.name && projectDetails.email);
      default:
        return false;
    }
  };

  const renderMainContent = () => {
    switch (currentStep) {
      case "upload":
        return null;
      case "roi":
        return pdfCanvas ? <RoiReviewCanvas key={activePage?.source.page_id} pdfCanvas={pdfCanvas} annotations={roofRegions}
          selectedId={selectedRoiId} adding={addingRoi} onAddingChange={setAddingRoi} onSelect={setSelectedRoiId}
          onEdit={editRoi} onAdd={addRoi} /> : null;
      case "paint":
        return pdfCanvas ? (
          <PaintBucketCanvas
            key={activePage?.source.page_id}
            pdfCanvas={pdfCanvas}
            onOutlinesExtracted={handleOutlinesExtracted}
            onHolesExtracted={handleHolesExtracted}
            roofOutlines={roofOutlines}
            interiorHoles={interiorHoles}
            acceptedRegions={roiClient.enabled ? acceptedRegions : undefined}
            regionLabels={Object.fromEntries(roofRegions.map((annotation, index) => [annotation.id, `Roof area ${index + 1}`]))}
          />
        ) : null;
      case "outlets":
        if (showAdditionalUpload) {
          return (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-96">
                <PdfUpload
                  onPdfRendered={ignoreRenderedCanvas}
                  onPageRendered={handlePageRendered}
                  onPageSelectionStart={handlePageSelectionStart}
                  drawingScale={drawingScale}
                  onDrawingScaleChange={handleDrawingScaleChange}
                />
                <Button
                  variant="outline"
                  onClick={cancelAdditionalUpload}
                  className="w-full mt-3"
                >
                  Cancel
                </Button>
              </div>
            </div>
          );
        }
        return pdfCanvas ? (
          <NewBuildOutletCanvas
            key={activePage?.source.page_id}
            pdfCanvas={pdfCanvas}
            roofOutlines={roofOutlines}
            interiorHoles={interiorHoles}
            outlets={outlets}
            selectedOutlet={selectedOutlet}
            onAddOutlet={handleAddOutlet}
            onSelectOutlet={setSelectedOutlet}
            onMoveOutlet={handleMoveOutlet}
            drainageEdges={drainageEdges}
            onToggleDrainageEdge={handleToggleDrainageEdge}
            outletMode={outletMode}
          />
        ) : null;
      case "details":
        return null;
      default:
        return null;
    }
  };

  const renderSidebar = () => {
    if (currentStep === "roi" && activePage) {
      return <RoiReviewSidebar page={activePage} selectedId={selectedRoiId} adding={addingRoi}
        onSelect={setSelectedRoiId} onAddingChange={setAddingRoi} dispatch={dispatch} detection={detection} />;
    }
    if (currentStep === "upload") {
      return <PdfUpload onPdfRendered={ignoreRenderedCanvas} onPageRendered={handlePageRendered}
        onPageSelectionStart={handlePageSelectionStart} drawingScale={drawingScale} onDrawingScaleChange={handleDrawingScaleChange} />;
    }
    if (currentStep === "details") {
      return (
        <ProjectDetailsForm
          projectDetails={projectDetails}
          onProjectDetailsChange={setProjectDetails}
          onSubmit={() => alert("Project successfully sent to TaperedPlus!")}
          outline={buildOutlines()}
          outlets={combined.outlets}
          penetrations={[]}
        />
      );
    }
    return (
      <>
        <NewBuildSidebar
          currentStep={currentStep}
          roofOutlines={roofOutlines}
          outlets={outlets}
          selectedOutlet={selectedOutlet}
          onDeleteOutlet={handleDeleteOutlet}
          drainageEdges={drainageEdges}
          outletMode={outletMode}
          onOutletModeChange={setOutletMode}
          savedOutlines={saved.roofOutlines}
          savedOutlets={saved.outlets}
        />
        {currentStep === "outlets" && !showAdditionalUpload && (
          <Button
            variant="outline"
            onClick={() => {
              additionalReturnPage.current = state.active_page_id;
              setUploadScale(drawingScale);
              dispatch({ type: "select", page_id: null });
              setSelectedOutlet(null);
              setShowAdditionalUpload(true);
            }}
            className="w-full mt-4"
          >
            <FileUp className="w-4 h-4 mr-2" />
            Upload Another PDF
          </Button>
        )}
      </>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <NewBuildStepHeader currentStep={currentStep} steps={stepOrder} />

      <div className={`flex h-[calc(100vh-80px)] ${currentStep === "roi" ? "flex-col md:flex-row" : ""}`}>
        <div
          className={`${
            currentStep === "roi" ? "w-full md:w-80 max-h-[45vh] md:max-h-none" : currentStep === "details" || currentStep === "upload" ? "w-96" : "w-80"
          } shrink-0 border-r border-border bg-card p-4 ${currentStep === "roi" ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}
        >
          <div className={currentStep === "roi" ? "flex-1 min-h-0 overflow-y-auto" : undefined}>{renderSidebar()}</div>

          <div className="mt-6 flex gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={handlePrev}
              disabled={currentStep === "upload"}
              className="flex-1"
            >
              Previous
            </Button>
            <Button
              onClick={handleNext}
              disabled={currentStep === "details" || !canProceed()}
              className="flex-1 min-w-0 whitespace-normal h-auto min-h-10 py-2"
            >
              {currentStep === "details" ? "Complete" : currentStep === "roi" ? "Define roof manually" : "Next"}
            </Button>
          </div>
        </div>

        <div className={`flex-1 min-w-0 p-4 flex overflow-hidden ${currentStep === "roi" ? "flex-col min-h-[360px] md:min-h-0" : currentStep === "paint" || currentStep === "outlets" || currentStep === "details" ? "flex-col" : "items-center justify-center"}`}>
          {currentStep === "upload" && pdfCanvas && (
            <div className="text-center">
              <p className="text-muted-foreground mb-4">
                PDF loaded — click Next to define the roof area
              </p>
              <img
                src={pdfCanvas.toDataURL()}
                alt="PDF Preview"
                className="max-w-full max-h-[500px] border border-border rounded-lg mx-auto"
              />
            </div>
          )}
          {currentStep === "upload" && !pdfCanvas && (
            <p className="text-muted-foreground">
              Upload a PDF to get started
            </p>
          )}
          {(currentStep === "roi" || currentStep === "paint" || currentStep === "outlets") &&
            renderMainContent()}
          {currentStep === "details" && (
            <RoofIllustrationCanvas
              roofOutlines={combined.roofOutlines}
              interiorHoles={combined.interiorHoles}
              outlets={combined.outlets}
              drainageEdges={combined.drainageEdges}
              onOutlinesChange={(points) => setIllustrationOffsets((previous) => shiftedOffsets(previous,
                combined.outlineRefs, combined.roofOutlines.map((polygon) => polygon[0]), points.map((polygon) => polygon[0])))}
              onHolesChange={(points) => setIllustrationOffsets((previous) => shiftedOffsets(previous,
                combined.holeRefs, combined.interiorHoles.map((polygon) => polygon[0]), points.map((polygon) => polygon[0])))}
              onOutletsChange={(points) => setIllustrationOffsets((previous) => shiftedOffsets(previous,
                combined.outletRefs, combined.outlets, points))}
            />
          )}
        </div>
      </div>
    </div>
  );
};
