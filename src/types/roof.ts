export interface Point {
    x: number;
    y: number;
  }
  
  export interface RoofSegment {
    direction: 'up' | 'down' | 'left' | 'right' | 'up-right' | 'up-left' | 'down-right' | 'down-left' | 'custom';
    length: number;
    customAngle?: number;
    isDrainageEdge?: boolean;
  }
  
  export interface RoofOutline {
    segments: RoofSegment[];
    startPoint: Point;
    currentPoint: Point;
    polygonPoints?: Point[]; // For new build flow - extracted from PDF paint bucket
  }
  
  export interface Outlet {
    id: string;
    x: number;
    y: number;
    diameter: number;
  }
  
  export interface Penetration {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }
  
  export interface ProjectDetails {
    name: string;
    company: string;
    email: string;
    account: string;
    projectName: string;
    projectAddress: string;
    targetUValue: string;
    maxInsulationHeight: string;
    productType: string;
    deckType: string;
    fallType: string;
    waterproofingType: string;
    buildMethod: string;
    additionalNotes: string;
  }
  
  export interface RoofDesign {
    outline: RoofOutline;
    outlets: Outlet[];
    penetrations: Penetration[];
    projectDetails: ProjectDetails;
  }
  
  export interface DrawingScale {
    paperSize: string; // e.g. "A1", "A0", "A2", "A3"
    scaleRatio: number; // e.g. 100 means 1:100
  }
  
  export type DrawingStep = 'outline' | 'outlets' | 'penetrations' | 'details';
  
  export type NewBuildStep = 'upload' | 'classify' | 'paint' | 'outlets' | 'details';
  
  export interface DrainageEdge {
    outlineIndex: number;
    edgeIndex: number; // index of the starting point of the edge within the polygon
  }
  
  export type AppMode = 'landing' | 'refurbishment' | 'new-build';
  