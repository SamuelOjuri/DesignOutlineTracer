import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyProjectDetails } from "@/lib/projectDetailsFields";
import { ProjectDetailsForm } from "./ProjectDetailsForm";

const props = {
  projectDetails: { ...emptyProjectDetails(), name: "Sam", email: "sam@example.invalid", projectName: "Demo",
    projectAddress: "Exeter" },
  onProjectDetailsChange: vi.fn(),
  onSubmit: vi.fn(),
  outline: [],
  outlets: [],
  penetrations: [],
};

describe("ProjectDetailsForm", () => {
  it("keeps Send to TaperedPlus inactive and never submits while sending is paused", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { container } = render(<ProjectDetailsForm {...props} actions={<button type="button">Package action</button>} />);
    expect(screen.getByRole("button", { name: "Send to TaperedPlus" })).toBeDisabled();
    expect(screen.getByText("Sending to TaperedPlus is coming soon.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Package action" })).toBeEnabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("restores the send button when the feature flag is enabled", () => {
    render(<ProjectDetailsForm {...props} sendEnabled />);
    expect(screen.getByRole("button", { name: "Send to TaperedPlus" })).toBeEnabled();
  });

  it("renders select options from the shared field definitions", () => {
    render(<ProjectDetailsForm {...props} projectDetails={{ ...props.projectDetails, fallType: "1:80", buildMethod: "multilayer" }} />);
    const triggers = screen.getAllByRole("combobox").map(trigger => trigger.textContent);
    expect(triggers).toContain("1:80");
    expect(triggers).toContain("MultiLayer");
  });

  it("does not ask for requirements covered by the performance specification", () => {
    render(<ProjectDetailsForm {...props} />);
    for (const label of [/Target U-Value/, /Product Type/, /Deck Type/, /Waterproofing Type/]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByText("Name *")).toBeInTheDocument();
    expect(screen.getByText("Company *")).toBeInTheDocument();
  });
});
