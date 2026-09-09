import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StepHeader } from "./StepHeader";
import { DrawingCanvas } from "./DrawingCanvas";
import { OutlineControls } from "./OutlineControls";
import { OutletControls } from "./OutletControls";
import { PenetrationControls } from "./PenetrationControls";
import { ProjectDetailsForm } from "./ProjectDetailsForm";
import {
  RoofOutline,
  Outlet,
  Penetration,
  ProjectDetails,
  DrawingStep,
} from "@/types/roof";

export const RoofDrawingApp = () => {
  const [currentStep, setCurrentStep] = useState<DrawingStep>('outline');
  const [outline, setOutline] = useState<RoofOutline>({
    segments: [],
    startPoint: { x: 100, y: 100 },
    currentPoint: { x: 100, y: 100 },
  });
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [penetrations, setPenetrations] = useState<Penetration[]>([]);
  const [projectDetails, setProjectDetails] = useState<ProjectDetails>({
    name: '',
    company: '',
    email: '',
    projectName: '',
    projectAddress: '',
    targetUValue: '',
    productType: '',
    deckType: '',
    additionalNotes: '',
    maxInsulationHeight: '',
    account: '',
    fallType: '',
    waterproofingType: '',
    buildMethod: '',
  });
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [selectedPenetration, setSelectedPenetration] = useState<Penetration | null>(null);
  const [outletMode, setOutletMode] = useState<'none' | 'add-outlets' | 'drainage-edge'>('none');

  const handleAddOutlet = (x: number, y: number) => {
    const newOutlet: Outlet = {
      id: `outlet-${Date.now()}`,
      x,
      y,
      diameter: 0.15, // 0.15m (150mm)
    };
    setOutlets([...outlets, newOutlet]);
  };

  const handleDeleteOutlet = (id: string) => {
    setOutlets(outlets.filter(outlet => outlet.id !== id));
    if (selectedOutlet?.id === id) {
      setSelectedOutlet(null);
    }
  };

  const handleUpdateOutlet = (updatedOutlet: Outlet) => {
    setOutlets(outlets.map(outlet =>
      outlet.id === updatedOutlet.id ? updatedOutlet : outlet
    ));
    setSelectedOutlet(updatedOutlet);
  };

  const handleOutletMove = (outletId: string, x: number, y: number) => {
    const outlet = outlets.find(o => o.id === outletId);
    if (outlet) {
      const updatedOutlet = { ...outlet, x, y };
      handleUpdateOutlet(updatedOutlet);
    }
  };

  const handleAddPenetration = (x: number, y: number) => {
    const newPenetration: Penetration = {
      id: `penetration-${Date.now()}`,
      x,
      y,
      width: 1.2, // 1.2m
      height: 1.2, // 1.2m
    };
    setPenetrations([...penetrations, newPenetration]);
  };

  const handleDeletePenetration = (id: string) => {
    setPenetrations(penetrations.filter(penetration => penetration.id !== id));
    if (selectedPenetration?.id === id) {
      setSelectedPenetration(null);
    }
  };

  const handleUpdatePenetration = (updatedPenetration: Penetration) => {
    setPenetrations(penetrations.map(penetration =>
      penetration.id === updatedPenetration.id ? updatedPenetration : penetration
    ));
    setSelectedPenetration(updatedPenetration);
  };

  const handlePenetrationMove = (penetrationId: string, x: number, y: number) => {
    const penetration = penetrations.find(p => p.id === penetrationId);
    if (penetration) {
      const updatedPenetration = { ...penetration, x, y };
      handleUpdatePenetration(updatedPenetration);
    }
  };

  const handleOutletResize = (outletId: string, diameter: number) => {
    const outlet = outlets.find(o => o.id === outletId);
    if (outlet) {
      const updatedOutlet = { ...outlet, diameter };
      handleUpdateOutlet(updatedOutlet);
    }
  };

  const handlePenetrationResize = (penetrationId: string, width: number, height: number) => {
    const penetration = penetrations.find(p => p.id === penetrationId);
    if (penetration) {
      const updatedPenetration = { ...penetration, width, height };
      handleUpdatePenetration(updatedPenetration);
    }
  };

  const handleNextStep = () => {
    const steps: DrawingStep[] = ['outline', 'outlets', 'penetrations', 'details'];
    const currentIndex = steps.indexOf(currentStep);
    if (currentIndex < steps.length - 1) {
      setCurrentStep(steps[currentIndex + 1]);
    }
  };

  const handlePrevStep = () => {
    const steps: DrawingStep[] = ['outline', 'outlets', 'penetrations', 'details'];
    const currentIndex = steps.indexOf(currentStep);
    if (currentIndex > 0) {
      setCurrentStep(steps[currentIndex - 1]);
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 'outline':
        return outline.segments.length >= 3;
      case 'outlets':
        return true; // Outlets are optional
      case 'penetrations':
        return true; // Penetrations are optional
      case 'details':
        return projectDetails.projectName && projectDetails.name && projectDetails.email;
      default:
        return false;
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 'outline':
        return (
          <OutlineControls
            outline={outline}
            onOutlineChange={setOutline}
          />
        );
      case 'outlets':
        return (
          <OutletControls
            outlets={outlets}
            selectedOutlet={selectedOutlet}
            onDeleteOutlet={handleDeleteOutlet}
            onUpdateOutlet={handleUpdateOutlet}
            outline={outline}
            onOutlineChange={setOutline}
            outletMode={outletMode}
            onOutletModeChange={setOutletMode}
          />
        );
      case 'penetrations':
        return (
          <PenetrationControls
            penetrations={penetrations}
            selectedPenetration={selectedPenetration}
            onDeletePenetration={handleDeletePenetration}
            onUpdatePenetration={handleUpdatePenetration}
          />
        );
      case 'details':
        return (
          <ProjectDetailsForm
            projectDetails={projectDetails}
            onProjectDetailsChange={setProjectDetails}
            onSubmit={() => {
              // Handle successful submission
              alert('Project successfully sent to TaperedPlus!');
            }}
            outline={outline}
            outlets={outlets}
            penetrations={penetrations}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <StepHeader currentStep={currentStep} />
      
      <div className="flex h-[calc(100vh-80px)]">
        {/* Sidebar */}
        <div className={`${currentStep === 'details' ? 'w-96' : 'w-80'} border-r border-border bg-card p-4 overflow-y-auto`}>
          {renderStepContent()}
          
          {/* Navigation buttons */}
          <div className="mt-6 flex gap-2">
            <Button
              variant="outline"
              onClick={handlePrevStep}
              disabled={currentStep === 'outline'}
              className="flex-1"
            >
              Previous
            </Button>
            <Button
              onClick={handleNextStep}
              disabled={currentStep === 'details' || !canProceed()}
              className="flex-1"
            >
              {currentStep === 'details' ? 'Complete' : 'Next'}
            </Button>
          </div>
        </div>

        {/* Main drawing area */}
        <div className="flex-1 p-4">
          <DrawingCanvas
            currentStep={currentStep}
            outline={outline}
            outlets={outlets}
            penetrations={penetrations}
            onOutletSelect={setSelectedOutlet}
            onPenetrationSelect={setSelectedPenetration}
            onOutletMove={handleOutletMove}
            onPenetrationMove={handlePenetrationMove}
            onOutletResize={handleOutletResize}
            onPenetrationResize={handlePenetrationResize}
            onAddOutlet={handleAddOutlet}
            onAddPenetration={handleAddPenetration}
            onSegmentClick={(segmentIndex) => {
              const newSegments = [...outline.segments];
              newSegments[segmentIndex] = {
                ...newSegments[segmentIndex],
                isDrainageEdge: !newSegments[segmentIndex].isDrainageEdge,
              };
              setOutline({ ...outline, segments: newSegments });
            }}
            drainageMode={outletMode === 'drainage-edge'}
          />
        </div>
      </div>
    </div>
  );
};