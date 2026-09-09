import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProjectDetails } from "@/types/roof";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface ProjectDetailsFormProps {
  projectDetails: ProjectDetails;
  onProjectDetailsChange: (details: ProjectDetails) => void;
  onSubmit: () => void;
  outline: any;
  outlets: any[];
  penetrations: any[];
}

export const ProjectDetailsForm = ({
  projectDetails,
  onProjectDetailsChange,
  onSubmit,
  outline,
  outlets,
  penetrations,
}: ProjectDetailsFormProps) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handleFieldChange = (field: keyof ProjectDetails, value: string) => {
    onProjectDetailsChange({
      ...projectDetails,
      [field]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!projectDetails.projectName || !projectDetails.name || !projectDetails.email || !projectDetails.projectAddress) {
      toast({
        title: "Missing Information",
        description: "Please fill in all required fields.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    
    try {
      console.log('Sending project data:', { outline, outlets, penetrations, projectDetails });
      
      const response = await fetch(`https://nispvuhrvlvjsvfcelsp.supabase.co/functions/v1/send-project-email`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pc3B2dWhydmx2anN2ZmNlbHNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE2MTkzMDIsImV4cCI6MjA2NzE5NTMwMn0.p17LIdptbs7WALkYewOntnuBMBokMvvmG_M9aySDlFA`,
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pc3B2dWhydmx2anN2ZmNlbHNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE2MTkzMDIsImV4cCI6MjA2NzE5NTMwMn0.p17LIdptbs7WALkYewOntnuBMBokMvvmG_M9aySDlFA',
        },
        body: JSON.stringify({
          outline,
          outlets,
          penetrations,
          projectDetails
        })
      });

      console.log('Raw response status:', response.status);
      console.log('Raw response headers:', [...response.headers.entries()]);
      
      const responseText = await response.text();
      console.log('Raw response body:', responseText);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.error('Failed to parse response as JSON:', e);
        throw new Error(`Invalid JSON response: ${responseText}`);
      }

      toast({
        title: "Success!",
        description: "Project email sent successfully to TaperedPlus!",
      });
      onSubmit();
    } catch (error) {
      console.error('Error sending project:', error);
      toast({
        title: "Error",
        description: `Failed to send project: ${error.message}`,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Project Details</h3>
      
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              type="text"
              value={projectDetails.name}
              onChange={(e) => handleFieldChange('name', e.target.value)}
              placeholder="Your full name"
              required
            />
          </div>
          
          <div>
            <Label htmlFor="company">Company *</Label>
            <Input
              id="company"
              type="text"
              value={projectDetails.company}
              onChange={(e) => handleFieldChange('company', e.target.value)}
              placeholder="Company name"
              required
            />
          </div>
        </div>

        <div>
          <Label htmlFor="email">Email Address *</Label>
          <Input
            id="email"
            type="email"
            value={projectDetails.email}
            onChange={(e) => handleFieldChange('email', e.target.value)}
            placeholder="your.email@company.com"
            required
          />
        </div>

        <div>
          <Label htmlFor="account">Account *</Label>
          <Select
            value={projectDetails.account}
            onValueChange={(value) => handleFieldChange('account', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select account" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="axter-limited">Axter Limited</SelectItem>
              <SelectItem value="taperedplus-limited">TaperedPlus Limited</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="projectName">Project Name *</Label>
          <Input
            id="projectName"
            value={projectDetails.projectName}
            onChange={(e) => handleFieldChange('projectName', e.target.value)}
            placeholder="Enter project name"
            required
          />
        </div>

        <div>
          <Label htmlFor="projectAddress">Project Address (Including Postcode) *</Label>
          <Input
            id="projectAddress"
            value={projectDetails.projectAddress}
            onChange={(e) => handleFieldChange('projectAddress', e.target.value)}
            placeholder="Enter project address"
            required
          />
        </div>

        <div>
          <Label htmlFor="targetUValue">Target U-Value *</Label>
          <Input
            id="targetUValue"
            type="text"
            value={projectDetails.targetUValue}
            onChange={(e) => handleFieldChange('targetUValue', e.target.value)}
            placeholder="e.g., 0.18 W/m²K"
            required
          />
        </div>

        <div>
          <Label htmlFor="maxInsulationHeight">Max Insulation Height Allowable</Label>
          <Input
            id="maxInsulationHeight"
            type="text"
            value={projectDetails.maxInsulationHeight}
            onChange={(e) => handleFieldChange('maxInsulationHeight', e.target.value)}
            placeholder="e.g., 200mm"
          />
        </div>

        <div>
          <Label htmlFor="productType">Product Type *</Label>
          <Select
            value={projectDetails.productType}
            onValueChange={(value) => handleFieldChange('productType', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select product type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tissuefaced-pir" title="Polyisocyanurate with glass fibre facers suitable for use below single ply fully adhered roof membranes, single ply waterproofing systems and partially bonded built-up felt.">
                TissueFaced PIR (TR/MG)
              </SelectItem>
              <SelectItem value="torchon-pir" title="Polyisocyanurate roof insulation with a polypropylene fleece finished bitumen/ glass fibre working surface and a mineral glass facing to the under side. (These boards are not reversible). They are suitable for use below most bitumen based partially bonded built up roofing systems.">
                Torch On (TR/BGM)
              </SelectItem>
              <SelectItem value="foilfaced-pir" title="Polyisocyanurate Roof Insulation with vapour-tight aluminium foil facings suitable for use with single ply membranes in mechanically fixed systems.">
                FoilFaced PIR (TR/ALU)
              </SelectItem>
              <SelectItem value="rockwool-hardrock-multifix" title="ROCKWOOL HardRock MultiFix - stone wool insulation board for flat roof applications.">
                ROCKWOOL HardRock MultiFix
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="deckType">Deck Type *</Label>
          <Select
            value={projectDetails.deckType}
            onValueChange={(value) => handleFieldChange('deckType', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select deck type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="concrete">Concrete</SelectItem>
              <SelectItem value="metal">Metal</SelectItem>
              <SelectItem value="timber">Timber</SelectItem>
              <SelectItem value="composite">Composite</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="fallType">Fall Type *</Label>
          <Select
            value={projectDetails.fallType}
            onValueChange={(value) => handleFieldChange('fallType', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select fall type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1:80">1:80</SelectItem>
              <SelectItem value="1:60">1:60</SelectItem>
              <SelectItem value="1:40">1:40</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="waterproofingType">Waterproofing Type *</Label>
          <Select
            value={projectDetails.waterproofingType}
            onValueChange={(value) => handleFieldChange('waterproofingType', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select waterproofing type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single-ply">Single Ply</SelectItem>
              <SelectItem value="built-up-felt">Built Up Felt</SelectItem>
              <SelectItem value="liquid-waterproofing">Liquid Waterproofing</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="buildMethod">Build Method *</Label>
          <Select
            value={projectDetails.buildMethod}
            onValueChange={(value) => handleFieldChange('buildMethod', value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select build method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="multilayer">MultiLayer</SelectItem>
              <SelectItem value="prebonded">Prebonded</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="additionalNotes">Additional Notes</Label>
          <Textarea
            id="additionalNotes"
            value={projectDetails.additionalNotes}
            onChange={(e) => handleFieldChange('additionalNotes', e.target.value)}
            placeholder="Any additional information or special requirements..."
            rows={4}
          />
        </div>

        <div className="pt-4 border-t">
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Sending to TaperedPlus..." : "Send to TaperedPlus"}
          </Button>
        </div>
      </form>

      <div className="mt-4 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground">
          Complete all project details and click "Send to TaperedPlus" to submit your roof design for processing.
        </p>
      </div>
    </Card>
  );
};