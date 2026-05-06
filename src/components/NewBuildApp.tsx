import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { NewBuildStepHeader } from "./newbuild/NewBuildStepHeader";
import { PdfUpload } from "./newbuild/PdfUpload";
import { PaintBucketCanvas } from "./newbuild/PaintBucketCanvas";
import { NewBuildOutletCanvas } from "./newbuild/NewBuildOutletCanvas";
import { NewBuildSidebar } from "./newbuild/NewBuildSidebar";
import { RoofIllustrationCanvas } from "./newbuild/RoofIllustrationCanvas";
import { ProjectDetailsForm } from "./ProjectDetailsForm";
import { useToast } from "@/hooks/use-toast";
import {
  BackendProductionSchema,
  checkBackendHealth,
  runAutomatedExtraction,
} from "@/integrations/backend/client";
import {
  backendCandidateToCanvasOutline,
  backendOutletsToCanvas,
  backendRooflightsToCanvasHoles,
} from "@/integrations/backend/coords";
import {
  NewBuildStep,
  Outlet,
  Point,
  ProjectDetails,
  RoofOutline,
  DrawingScale,
  DrainageEdge,
} from "@/types/roof";
import { FileUp, Loader2, Wand2 } from "lucide-react";

const PAPER_SIZES_MM: Record<string, { w: number; h: number }> = {
  A0: { w: 841, h: 1189 },
  A1: { w: 594, h: 841 },
  A2: { w: 420, h: 594 },
  A3: { w: 297, h: 420 },
  A4: { w: 210, h: 297 },
};

function getMmPerPixel(canvas: HTMLCanvasElement, scale: DrawingScale): number {
  const paper = PAPER_SIZES_MM[scale.paperSize] || PAPER_SIZES_MM.A1;
  // Match longer canvas dimension to longer paper dimension
  const canvasLong = Math.max(canvas.width, canvas.height);
  const paperLongMm = Math.max(paper.w, paper.h);
  // mm on paper per pixel, then multiply by scale ratio to get real-world mm per pixel
  return (paperLongMm / canvasLong) * scale.scaleRatio;
}

function getBoundsOfOutlines(outlines: Point[][]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of outlines) {
    for (const p of o) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

function scalePoints(points: Point[], factor: number): Point[] {
  return points.map(p => ({ x: Math.round(p.x * factor), y: Math.round(p.y * factor) }));
}

export const NewBuildApp = () => {
  const backendEnabled = import.meta.env.VITE_ENABLE_BACKEND === "1" || import.meta.env.VITE_ENABLE_BACKEND === "true";
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState<NewBuildStep>("upload");
  const [pdfCanvas, setPdfCanvas] = useState<HTMLCanvasElement | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [roofOutlines, setRoofOutlines] = useState<Point[][]>([]);
  const [interiorHoles, setInteriorHoles] = useState<Point[][]>([]);
  const [drawingScale, setDrawingScale] = useState<DrawingScale>({ paperSize: "A1", scaleRatio: 100 });
  const [baseDrawingScale, setBaseDrawingScale] = useState<DrawingScale | null>(null);
  const [basePdfCanvas, setBasePdfCanvas] = useState<HTMLCanvasElement | null>(null);
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [drainageEdges, setDrainageEdges] = useState<DrainageEdge[]>([]);
  const [outletMode, setOutletMode] = useState<'add-outlets' | 'drainage-edge'>('add-outlets');
  const [showAdditionalUpload, setShowAdditionalUpload] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [backendExtraction, setBackendExtraction] = useState<BackendProductionSchema | null>(null);
  const savedOutlinesRef = useRef<Point[][]>([]);
  const savedHolesRef = useRef<Point[][]>([]);
  const savedOutletsRef = useRef<Outlet[]>([]);
  const savedDrainageRef = useRef<DrainageEdge[]>([]);
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

  const handlePdfRendered = (canvas: HTMLCanvasElement) => {
    setPdfCanvas(canvas);
    setBackendExtraction(null);
    if (!baseDrawingScale) {
      setBaseDrawingScale({ ...drawingScale });
      setBasePdfCanvas(canvas);
    }
  };

  const handleAdditionalPdfRendered = (canvas: HTMLCanvasElement) => {
    savedOutlinesRef.current = [...roofOutlines];
    savedHolesRef.current = [...interiorHoles];
    savedOutletsRef.current = [...outlets];
    savedDrainageRef.current = [...drainageEdges];
    setRoofOutlines([]);
    setInteriorHoles([]);
    setOutlets([]);
    setDrainageEdges([]);
    setPdfCanvas(canvas);
    setShowAdditionalUpload(false);
    setCurrentStep("paint");
  };

  // Compute rescale factor: converts new PDF pixels to equivalent first-PDF pixels
  const getScaleFactor = () => {
    if (!baseDrawingScale || !basePdfCanvas || !pdfCanvas) return 1;
    const baseMmpp = getMmPerPixel(basePdfCanvas, baseDrawingScale);
    const currentMmpp = getMmPerPixel(pdfCanvas, drawingScale);
    return currentMmpp / baseMmpp;
  };

  const handleOutlinesExtracted = (outlines: Point[][]) => {
    // During a second PDF session, only store new outlines (no merging yet)
    // Merging + offset happens in handleNext when leaving outlets step
    setRoofOutlines(outlines);
  };

  const handleHolesExtracted = (holes: Point[][]) => {
    setInteriorHoles(holes);
  };

  const handleAddOutlet = (x: number, y: number) => {
    const newOutlet: Outlet = {
      id: `outlet-${Date.now()}`,
      x,
      y,
      diameter: 0.15,
    };
    setOutlets((prev) => [...prev, newOutlet]);
  };

  const handleDeleteOutlet = (id: string) => {
    setOutlets((prev) => prev.filter((o) => o.id !== id));
    if (selectedOutlet?.id === id) setSelectedOutlet(null);
  };

  const handleMoveOutlet = (id: string, x: number, y: number) => {
    setOutlets((prev) =>
      prev.map((o) => (o.id === id ? { ...o, x, y } : o))
    );
    if (selectedOutlet?.id === id) {
      setSelectedOutlet((prev) => (prev ? { ...prev, x, y } : null));
    }
  };

  const handleToggleDrainageEdge = (outlineIndex: number, edgeIndex: number) => {
    setDrainageEdges((prev) => {
      const exists = prev.find(
        (d) => d.outlineIndex === outlineIndex && d.edgeIndex === edgeIndex
      );
      if (exists) return prev.filter((d) => d !== exists);
      return [...prev, { outlineIndex, edgeIndex }];
    });
  };

  const buildOutlines = (): RoofOutline[] =>
    roofOutlines.map((points) => ({
      segments: [],
      startPoint: points[0] || { x: 0, y: 0 },
      currentPoint: points[points.length - 1] || { x: 0, y: 0 },
      polygonPoints: points,
    }));

  const stepOrder: NewBuildStep[] = backendEnabled
    ? ["upload", "classify", "paint", "outlets", "details"]
    : ["upload", "paint", "outlets", "details"];

  const continueManually = () => {
    setBackendExtraction(null);
    setCurrentStep("paint");
  };

  const handleAutomatedExtraction = async () => {
    if (!pdfFile || !pdfCanvas) return;

    setIsExtracting(true);
    try {
      const backendReachable = await checkBackendHealth();
      if (!backendReachable) {
        toast({
          title: "Backend unavailable",
          description: "Continuing with manual roof area selection.",
        });
        continueManually();
        return;
      }

      const result = await runAutomatedExtraction(pdfFile);
      const schema = result.exportResult.production_schema;
      const outline = backendCandidateToCanvasOutline(result.candidate, pdfCanvas, schema);
      const holes = backendRooflightsToCanvasHoles(result.validatedCandidate, pdfCanvas, schema);
      const extractedOutlets = backendOutletsToCanvas(result.validatedCandidate, pdfCanvas, schema);

      setRoofOutlines(outline.length > 2 ? [outline] : []);
      setInteriorHoles(holes);
      setOutlets(extractedOutlets);
      setDrainageEdges([]);
      setBackendExtraction(schema);
      setCurrentStep("paint");

      toast({
        title: "Automated extraction complete",
        description: `Loaded ${extractedOutlets.length} outlets and ${holes.length} rooflights for review.`,
      });
    } catch (error) {
      console.error("Automated extraction failed:", error);
      toast({
        title: "Automated extraction failed",
        description: "Continuing with the existing manual workflow.",
        variant: "destructive",
      });
      continueManually();
    } finally {
      setIsExtracting(false);
    }
  };

  const handleNext = () => {
    const idx = stepOrder.indexOf(currentStep);
    if (idx < stepOrder.length - 1) {
      const nextStep = stepOrder[idx + 1];

      // When leaving outlets step with saved data from a previous PDF, merge everything
      if (currentStep === "outlets" && savedOutlinesRef.current.length > 0) {
        const factor = getScaleFactor();
        const savedOutlineCount = savedOutlinesRef.current.length;

        // Scale new outlines to match first PDF's coordinate space
        const scaledOutlines = factor !== 1
          ? roofOutlines.map(o => scalePoints(o, factor))
          : roofOutlines;

        // Auto-offset: place new outlines to the right of saved ones
        const savedBounds = getBoundsOfOutlines(savedOutlinesRef.current);
        const newBounds = getBoundsOfOutlines(scaledOutlines);
        const gap = 40;
        const offsetX = scaledOutlines.length > 0
          ? savedBounds.maxX - newBounds.minX + gap
          : 0;

        const mergedOutlines = [
          ...savedOutlinesRef.current,
          ...scaledOutlines.map(o => o.map(p => ({ x: p.x + offsetX, y: p.y }))),
        ];
        setRoofOutlines(mergedOutlines);

        // Scale + offset holes
        const scaledHoles = factor !== 1
          ? interiorHoles.map(h => scalePoints(h, factor))
          : interiorHoles;
        const mergedHoles = [
          ...savedHolesRef.current,
          ...scaledHoles.map(h => h.map(p => ({ x: p.x + offsetX, y: p.y }))),
        ];
        setInteriorHoles(mergedHoles);

        // Scale + offset outlets
        const mergedOutlets = [
          ...savedOutletsRef.current,
          ...outlets.map(o => ({
            ...o,
            x: Math.round(o.x * factor) + offsetX,
            y: Math.round(o.y * factor),
          })),
        ];
        setOutlets(mergedOutlets);

        // Adjust drainage edge indices
        const mergedDrainage = [
          ...savedDrainageRef.current,
          ...drainageEdges.map(d => ({
            ...d,
            outlineIndex: d.outlineIndex + savedOutlineCount,
          })),
        ];
        setDrainageEdges(mergedDrainage);

        // Clear saved refs
        savedOutletsRef.current = [];
        savedDrainageRef.current = [];
        savedOutlinesRef.current = [];
        savedHolesRef.current = [];
      }

      setCurrentStep(nextStep);
    }
  };


  const handlePrev = () => {
    const idx = stepOrder.indexOf(currentStep);
    if (idx > 0) setCurrentStep(stepOrder[idx - 1]);
  };

  const canProceed = (): boolean => {
    switch (currentStep) {
      case "upload":
        return pdfCanvas !== null;
      case "classify":
        return true;
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
      case "classify":
        return (
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-xl text-center space-y-4">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Wand2 className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-xl font-semibold">Automated roof extraction</h3>
                <p className="text-sm text-muted-foreground mt-2">
                  Use the backend pipeline to extract the roof outline, rooflights, and RWP outlets,
                  then review and adjust them in the existing tools.
                </p>
              </div>
              {backendExtraction && (
                <div className="p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                  Last automated result: {backendExtraction.target_area.area_m2_estimated}m²,
                  review status {backendExtraction.quality_checks.human_review_status}.
                </div>
              )}
              {backendExtraction?.document.source_type === "rasterized_pdf" ||
              backendExtraction?.quality_checks.human_review_status === "required" ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                  Raster pipeline — human review required. Adjust the outline, rooflights,
                  outlets, and scale before requesting CAD/DXF export.
                </div>
              ) : null}
              <div className="flex gap-3 justify-center">
                <Button
                  onClick={handleAutomatedExtraction}
                  disabled={!pdfFile || !pdfCanvas || isExtracting}
                >
                  {isExtracting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Use Automated Extraction
                </Button>
                <Button variant="outline" onClick={continueManually} disabled={isExtracting}>
                  Continue Manually
                </Button>
              </div>
              {!backendEnabled && (
                <p className="text-xs text-muted-foreground">
                  Backend integration is disabled. Set VITE_ENABLE_BACKEND=1 to enable it.
                </p>
              )}
            </div>
          </div>
        );
      case "paint":
        return pdfCanvas ? (
          <PaintBucketCanvas
            pdfCanvas={pdfCanvas}
            onOutlinesExtracted={handleOutlinesExtracted}
            onHolesExtracted={handleHolesExtracted}
            roofOutlines={roofOutlines}
          />
        ) : null;
      case "outlets":
        if (showAdditionalUpload) {
          return (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-96">
                <PdfUpload
                  onPdfRendered={handleAdditionalPdfRendered}
                  drawingScale={drawingScale}
                  onDrawingScaleChange={setDrawingScale}
                />
                <Button
                  variant="outline"
                  onClick={() => setShowAdditionalUpload(false)}
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
    if (currentStep === "upload") {
      return (
        <PdfUpload
          onPdfRendered={handlePdfRendered}
          drawingScale={drawingScale}
          onDrawingScaleChange={setDrawingScale}
          onPdfFileSelected={setPdfFile}
        />
      );
    }
    if (currentStep === "details") {
      return (
        <ProjectDetailsForm
          projectDetails={projectDetails}
          onProjectDetailsChange={setProjectDetails}
          onSubmit={() => alert("Project successfully sent to TaperedPlus!")}
          outline={buildOutlines()}
          outlets={outlets}
          penetrations={[]}
          backendExtraction={backendExtraction}
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
          savedOutlines={savedOutlinesRef.current}
          savedOutlets={savedOutletsRef.current}
        />
        {currentStep === "outlets" && !showAdditionalUpload && (
          <Button
            variant="outline"
            onClick={() => setShowAdditionalUpload(true)}
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
      <NewBuildStepHeader currentStep={currentStep} />

      <div className="flex h-[calc(100vh-80px)]">
        <div
          className={`${
            currentStep === "details" || currentStep === "upload" ? "w-96" : "w-80"
          } border-r border-border bg-card p-4 overflow-y-auto`}
        >
          {renderSidebar()}

          <div className="mt-6 flex gap-2">
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
              className="flex-1"
            >
              {currentStep === "details" ? "Complete" : "Next"}
            </Button>
          </div>
        </div>

        <div className={`flex-1 p-4 flex overflow-hidden ${currentStep === "paint" || currentStep === "outlets" || currentStep === "details" ? "flex-col" : "items-center justify-center"}`}>
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
          {(currentStep === "classify" || currentStep === "paint" || currentStep === "outlets") &&
            renderMainContent()}
          {currentStep === "details" && (
            <RoofIllustrationCanvas
              roofOutlines={roofOutlines}
              interiorHoles={interiorHoles}
              outlets={outlets}
              drainageEdges={drainageEdges}
              onOutlinesChange={setRoofOutlines}
              onHolesChange={setInteriorHoles}
              onOutletsChange={setOutlets}
            />
          )}
        </div>
      </div>
    </div>
  );
};
