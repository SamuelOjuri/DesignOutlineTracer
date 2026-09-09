import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { checkBackendHealth, runAutomatedExtraction } from "@/integrations/backend/client";
import { NewBuildApp } from "./NewBuildApp";

vi.mock("pdfjs-dist", () => ({
  version: "test", GlobalWorkerOptions: {}, getDocument: vi.fn(),
}));
vi.mock("@/integrations/backend/client", () => ({
  checkBackendHealth: vi.fn(), runAutomatedExtraction: vi.fn(),
}));
vi.mock("@/integrations/backend/coords", () => ({
  backendRasterToCanvasGeometry: () => ({
    outline: [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }],
    holes: [], outlets: [],
  }),
}));
vi.mock("./newbuild/PaintBucketCanvas", () => ({ PaintBucketCanvas: () => <div>Roof review</div> }));
vi.mock("./newbuild/NewBuildStepHeader", () => ({ NewBuildStepHeader: () => null }));
vi.mock("./newbuild/NewBuildSidebar", () => ({ NewBuildSidebar: () => null }));
vi.mock("./newbuild/NewBuildOutletCanvas", () => ({ NewBuildOutletCanvas: () => null }));
vi.mock("./newbuild/RoofIllustrationCanvas", () => ({ RoofIllustrationCanvas: () => null }));
vi.mock("./ProjectDetailsForm", () => ({ ProjectDetailsForm: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const renderPage = vi.fn(() => ({ promise: Promise.resolve() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_ENABLE_BACKEND", "1");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
  vi.mocked(pdfjsLib.getDocument).mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (pageNumber: number) => ({
        getViewport: () => ({ width: 600 + pageNumber * 100, height: 400 }),
        render: renderPage,
      }),
    }),
  } as unknown as ReturnType<typeof pdfjsLib.getDocument>);
  vi.mocked(checkBackendHealth).mockResolvedValue(true);
  vi.mocked(runAutomatedExtraction).mockImplementation(async (_file, pageIndex) => ({
    document_id: "document-1",
    pipeline: "raster_first",
    human_review_status: "required",
    render: { page_index: pageIndex ?? 0, width_px: 1000, height_px: 500 },
    production_schema: {
      document: { source_type: "rasterized_pdf" },
      quality_checks: { human_review_status: "required" },
    },
    warnings: [],
  } as Awaited<ReturnType<typeof runAutomatedExtraction>>));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function uploadPdf() {
  const file = Object.assign(new File(["pdf"], "roof.pdf", { type: "application/pdf" }), {
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const { container } = render(<NewBuildApp />);
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await screen.findByText(/1\s*\/\s*2/);
  return file;
}

describe("New Build selected-page extraction", () => {
  it.each([1, 2])("extracts displayed page %s", async (pageNumber) => {
    const file = await uploadPdf();
    if (pageNumber === 2) {
      fireEvent.click(screen.getByRole("button", { name: "\u2192" }));
      await screen.findByText(/2\s*\/\s*2/);
    }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Automated Extraction" }));

    await screen.findByText("Roof review");
    expect(runAutomatedExtraction).toHaveBeenCalledWith(file, pageNumber - 1);
  });

  it("blocks progression until the selected page has finished rendering", async () => {
    await uploadPdf();
    let finishRender!: () => void;
    const pendingRender = new Promise<void>(resolve => { finishRender = resolve; });
    renderPage.mockReturnValueOnce({ promise: pendingRender });

    fireEvent.click(screen.getByRole("button", { name: "\u2192" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true));
    expect(runAutomatedExtraction).not.toHaveBeenCalled();

    await act(async () => { finishRender(); });
    await screen.findByText(/2\s*\/\s*2/);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("continues to manual review when raster extraction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runAutomatedExtraction).mockRejectedValueOnce(new Error("Raster unavailable"));
    await uploadPdf();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Automated Extraction" }));

    await screen.findByText("Roof review");
    expect(runAutomatedExtraction).toHaveBeenCalledTimes(1);
  });
});