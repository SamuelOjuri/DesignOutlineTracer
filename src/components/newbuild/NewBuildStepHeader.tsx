import { NewBuildStep } from "@/types/roof";

interface NewBuildStepHeaderProps {
  currentStep: NewBuildStep;
}

const backendEnabled =
  import.meta.env.VITE_ENABLE_BACKEND === "1" || import.meta.env.VITE_ENABLE_BACKEND === "true";

const steps = backendEnabled
  ? [
      { key: "upload", label: "Step 1: Upload Roof Plan", number: 1 },
      { key: "classify", label: "Step 2: Extract or Manual", number: 2 },
      { key: "paint", label: "Step 3: Define Roof Area", number: 3 },
      { key: "outlets", label: "Step 4: Place Outlets", number: 4 },
      { key: "details", label: "Step 5: Project Details", number: 5 },
    ]
  : [
      { key: "upload", label: "Step 1: Upload Roof Plan", number: 1 },
      { key: "paint", label: "Step 2: Define Roof Area", number: 2 },
      { key: "outlets", label: "Step 3: Place Outlets", number: 3 },
      { key: "details", label: "Step 4: Project Details", number: 4 },
    ];

export const NewBuildStepHeader = ({ currentStep }: NewBuildStepHeaderProps) => {
  return (
    <div className="bg-card border-b border-border p-4">
      <div className="flex items-center w-full pl-4 pr-4 gap-8">
        <div className="flex items-center space-x-3 min-w-0 flex-shrink-0">
          <img
            src="/lovable-uploads/d52bf8e7-f8b3-42ac-bb6a-e1e682408032.png"
            alt="UNILIN"
            className="h-12 w-auto"
          />
          <img
            src="/lovable-uploads/8a611bea-62f7-4c52-bafa-6d8d4e3e1fef.png"
            alt="TaperedPlus"
            className="h-28 w-auto"
          />
          <h1 className="text-lg font-bold text-foreground whitespace-nowrap">TaperedPlus XPress</h1>
        </div>
        <div className="flex items-center space-x-4 flex-1 justify-center">
          {steps.map((step) => (
            <div
              key={step.key}
              className={`flex items-center space-x-2 px-3 py-2 rounded-lg transition-colors ${
                step.key === currentStep
                  ? 'bg-primary text-primary-foreground'
                  : step.number < (steps.find(s => s.key === currentStep)?.number ?? 0)
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              <div className="w-6 h-6 rounded-full bg-current/20 flex items-center justify-center text-sm font-medium">
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
