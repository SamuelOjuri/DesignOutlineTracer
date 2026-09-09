import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, FileUp } from "lucide-react";

const Landing = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="bg-card border-b border-border p-4">
        <div className="flex items-center justify-center space-x-3">
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
          <h1 className="text-lg font-bold text-foreground whitespace-nowrap">
            TaperedPlus XPress
          </h1>
        </div>
      </div>

      {/* Selection area */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-3xl w-full">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold text-foreground mb-2">
              Select Project Type
            </h2>
            <p className="text-muted-foreground text-lg">
              Choose how you'd like to define your roof layout
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Refurbishment */}
            <Card
              className="p-8 cursor-pointer hover:border-primary transition-all hover:shadow-lg group"
              onClick={() => navigate("/refurbishment")}
            >
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <Building2 className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">
                  Refurbishment
                </h3>
                <p className="text-muted-foreground text-sm">
                  Manually draw your roof outline step-by-step using
                  dimensions. Define drainage, outlets, and penetrations.
                </p>
                <Button className="w-full mt-4">Get Started</Button>
              </div>
            </Card>

            {/* New Build */}
            <Card
              className="p-8 cursor-pointer hover:border-primary transition-all hover:shadow-lg group"
              onClick={() => navigate("/new-build")}
            >
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <FileUp className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-xl font-semibold text-foreground">
                  New Build
                </h3>
                <p className="text-muted-foreground text-sm">
                  Upload a PDF roof plan, highlight the roof area with a paint
                  bucket tool, and place outlets directly on the plan.
                </p>
                <Button className="w-full mt-4">Get Started</Button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Landing;
