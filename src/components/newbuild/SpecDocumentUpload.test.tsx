import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { pdfFile } from "@/test/package";
import { SpecDocumentUpload } from "./SpecDocumentUpload";

function Harness({ onChange }: { onChange?: (file: File | null) => void }) {
  const [file, setFile] = useState<File | null>(null);
  return <SpecDocumentUpload file={file} onChange={next => { setFile(next); onChange?.(next); }} />;
}

describe("SpecDocumentUpload", () => {
  it("attaches a valid PDF without reading it into the form, and can remove it", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const spec = pdfFile("Project_Performance_Specification_Details.pdf");
    await user.upload(screen.getByLabelText("Performance specification PDF"), spec);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(spec));
    expect(screen.getByTestId("spec-document-name")).toHaveTextContent("Project_Performance_Specification_Details.pdf");
    expect(screen.getByText(/exactly as\s+provided/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("spec-document-name")).not.toBeInTheDocument();
  });

  it("rejects files that are not PDFs", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ applyAccept: false });
    render(<Harness onChange={onChange} />);
    await user.upload(screen.getByLabelText("Performance specification PDF"), new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a PDF file.");
    await user.upload(screen.getByLabelText("Performance specification PDF"), new File(["not a pdf"], "fake.pdf", { type: "application/pdf" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a valid PDF");
    expect(onChange).not.toHaveBeenCalled();
  });
});
