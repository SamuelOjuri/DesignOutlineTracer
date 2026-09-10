import { NewBuildStep } from "@/types/roof";

interface NewBuildStepHeaderProps {
  currentStep: NewBuildStep;
  steps: NewBuildStep[];
}

const labels: Record<NewBuildStep, string> = {
  upload: "Upload Roof Plan", roi: "Review Roof Areas", paint: "Define Roof Area", outlets: "Place Outlets", details: "Project Details",
};

export const NewBuildStepHeader = ({ currentStep, steps: order }: NewBuildStepHeaderProps) => {
  const steps = order.map((key, index) => ({ key, label: `Step ${index + 1}: ${labels[key]}`, number: index + 1 }));
  const currentStepNumber = steps.find((step) => step.key === currentStep)?.number ?? 0;
  return (
    <div className="bg-card border-b border-border p-4">
      <div className="flex flex-wrap items-center w-full gap-3">
        <div className="flex items-center space-x-3 min-w-0 flex-shrink-0">
          <img
            src="/lovable-uploads/d52bf8e7-f8b3-42ac-bb6a-e1e682408032.png"
            alt="UNILIN"
            className="h-12 w-auto"
          />
          <img
            src="/lovable-uploads/8a611bea-62f7-4c52-bafa-6d8d4e3e1fef.png"
            alt="TaperedPlus"
            className="h-12 w-auto"
          />
          <h1 className="text-base font-bold text-foreground">TaperedPlus XPress</h1>
        </div>
        <div className="flex items-center gap-1 flex-1 justify-center" aria-label="New Build steps">
          {steps.map((step) => (
            <div
              key={step.key}
              aria-current={step.key === currentStep ? "step" : undefined}
              title={step.label}
              className={`flex items-center gap-2 px-2 py-2 rounded transition-colors ${
                step.key === currentStep
                  ? 'bg-primary text-primary-foreground'
                  : step.number < currentStepNumber
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              <div className="w-6 h-6 shrink-0 rounded-full bg-current/20 flex items-center justify-center text-sm font-medium">
                {step.number}
              </div>
              <span className="text-sm font-medium hidden md:inline">{step.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
