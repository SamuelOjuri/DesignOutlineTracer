import { useRef, useEffect, useState } from "react";
import { RoofOutline, Outlet, Penetration, Point, DrawingStep } from "@/types/roof";

interface DrawingCanvasProps {
  currentStep: DrawingStep;
  outline: RoofOutline;
  outlets: Outlet[];
  penetrations: Penetration[];
  onOutletSelect?: (outlet: Outlet | null) => void;
  onPenetrationSelect?: (penetration: Penetration | null) => void;
  onOutletMove?: (outletId: string, x: number, y: number) => void;
  onPenetrationMove?: (penetrationId: string, x: number, y: number) => void;
  onOutletResize?: (outletId: string, diameter: number) => void;
  onPenetrationResize?: (penetrationId: string, width: number, height: number) => void;
  onAddOutlet?: (x: number, y: number) => void;
  onAddPenetration?: (x: number, y: number) => void;
  onSegmentClick?: (segmentIndex: number) => void;
  drainageMode?: boolean;
}

export const DrawingCanvas = ({
  currentStep,
  outline,
  outlets,
  penetrations,
  onOutletSelect,
  onPenetrationSelect,
  onOutletMove,
  onPenetrationMove,
  onOutletResize,
  onPenetrationResize,
  onAddOutlet,
  onAddPenetration,
  onSegmentClick,
  drainageMode = false,
}: DrawingCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedElement, setSelectedElement] = useState<{ type: 'outlet' | 'penetration'; id: string } | null>(null);
  const [hoveredElement, setHoveredElement] = useState<{ type: 'outlet' | 'penetration' | 'segment'; id: string | number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [transform, setTransform] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  const SCALE_BASE = 1; // 1px = 1cm (since segments are stored in mm, we convert)
  const GRID_SIZE = 100; // 1m grid in display coordinates
  const CANVAS_WIDTH = 800;
  const CANVAS_HEIGHT = 600;
  const PADDING = 80; // Padding around the roof for better visibility

  useEffect(() => {
    calculateAutoZoom();
  }, [outline]);

  useEffect(() => {
    drawCanvas();
  }, [outline, outlets, penetrations, selectedElement, hoveredElement, currentStep, transform, drainageMode]);

  const calculateAutoZoom = () => {
    if (outline.segments.length === 0) {
      setTransform({ scale: 1, offsetX: 0, offsetY: 0 });
      return;
    }

    const bounds = calculateOutlineBounds();
    if (bounds.width === 0 || bounds.height === 0) return;

    // Calculate scale to fit the roof with padding
    const scaleX = (CANVAS_WIDTH - PADDING * 2) / bounds.width;
    const scaleY = (CANVAS_HEIGHT - PADDING * 2) / bounds.height;
    const scale = Math.min(scaleX, scaleY, 2); // Max scale of 2 for very small roofs

    // Calculate center offset
    const centerX = bounds.minX + bounds.width / 2;
    const centerY = bounds.minY + bounds.height / 2;
    const offsetX = CANVAS_WIDTH / 2 - centerX * scale;
    const offsetY = CANVAS_HEIGHT / 2 - centerY * scale;

    setTransform({ scale, offsetX, offsetY });
  };

  const calculateOutlineBounds = () => {
    if (outline.segments.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
    }

    let currentPoint = { ...outline.startPoint };
    let minX = currentPoint.x, maxX = currentPoint.x;
    let minY = currentPoint.y, maxY = currentPoint.y;

    outline.segments.forEach(segment => {
      const diagonalMultiplier = Math.sqrt(2) / 2;
      
      if (segment.direction === 'custom' && segment.customAngle !== undefined) {
        // Handle custom angle segments
        const angleRad = (segment.customAngle * Math.PI) / 180;
        const deltaX = (segment.length / 10) * Math.cos(angleRad); // Convert mm to cm
        const deltaY = (segment.length / 10) * Math.sin(angleRad);
        currentPoint.x += deltaX;
        currentPoint.y += deltaY;
      } else {
        // Handle predefined direction segments
        switch (segment.direction) {
          case 'right':
            currentPoint.x += segment.length / 10; // Convert mm to cm
            break;
          case 'left':
            currentPoint.x -= segment.length / 10;
            break;
          case 'up':
            currentPoint.y -= segment.length / 10;
            break;
          case 'down':
            currentPoint.y += segment.length / 10;
            break;
          case 'up-right':
            currentPoint.x += (segment.length / 10) * diagonalMultiplier;
            currentPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'up-left':
            currentPoint.x -= (segment.length / 10) * diagonalMultiplier;
            currentPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-right':
            currentPoint.x += (segment.length / 10) * diagonalMultiplier;
            currentPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-left':
            currentPoint.x -= (segment.length / 10) * diagonalMultiplier;
            currentPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
        }
      }
      
      minX = Math.min(minX, currentPoint.x);
      maxX = Math.max(maxX, currentPoint.x);
      minY = Math.min(minY, currentPoint.y);
      maxY = Math.max(maxY, currentPoint.y);
    });

    return {
      minX, maxX, minY, maxY,
      width: maxX - minX,
      height: maxY - minY
    };
  };

  const transformPoint = (x: number, y: number) => ({
    x: x * transform.scale + transform.offsetX,
    y: y * transform.scale + transform.offsetY
  });

  const inverseTransformPoint = (x: number, y: number) => ({
    x: (x - transform.offsetX) / transform.scale,
    y: (y - transform.offsetY) / transform.scale
  });

  // Get computed CSS color values for canvas
  const getCanvasColors = () => {
    const computedStyle = getComputedStyle(document.documentElement);
    return {
      roofOutline: `hsl(${computedStyle.getPropertyValue('--roof-outline').trim()})`,
      outletStroke: `hsl(${computedStyle.getPropertyValue('--outlet-stroke').trim()})`,
      outletFill: `hsl(${computedStyle.getPropertyValue('--outlet-fill').trim()})`,
      penetrationStroke: `hsl(${computedStyle.getPropertyValue('--penetration-stroke').trim()})`,
      penetrationFill: `hsl(${computedStyle.getPropertyValue('--penetration-fill').trim()})`,
      selectedOutline: `hsl(${computedStyle.getPropertyValue('--selected-outline').trim()})`,
      dimensionLine: `hsl(${computedStyle.getPropertyValue('--dimension-line').trim()})`,
      gridLine: `hsl(${computedStyle.getPropertyValue('--grid-line').trim()})`,
      accent: `hsl(${computedStyle.getPropertyValue('--accent').trim()})`,
      primary: `hsl(${computedStyle.getPropertyValue('--primary').trim()})`,
      foreground: `hsl(${computedStyle.getPropertyValue('--foreground').trim()})`,
      mutedForeground: `hsl(${computedStyle.getPropertyValue('--muted-foreground').trim()})`
    };
  };

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const colors = getCanvasColors();

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw grid
    drawGrid(ctx, canvas.width, canvas.height, colors);

    // Draw roof outline
    if (outline.segments.length > 0) {
      drawRoofOutline(ctx, colors);
    }

    // Draw outlets (Step 2+)
    if (currentStep !== 'outline') {
      outlets.forEach(outlet => drawOutlet(ctx, outlet, colors));
      // Draw dimension lines for outlets
      outlets.forEach(outlet => drawElementDimensions(ctx, outlet.x, outlet.y, 'outlet', colors));
    }

    // Draw penetrations (Step 3+)
    if (currentStep === 'penetrations' || currentStep === 'details') {
      penetrations.forEach(penetration => drawPenetration(ctx, penetration, colors));
      // Draw dimension lines for penetrations
      penetrations.forEach(penetration => drawPenetrationDimensions(ctx, penetration, colors));
    }

    // Draw placement hints
    if (currentStep === 'outlets' && !drainageMode && onAddOutlet) {
      drawPlacementHint(ctx, colors);
    } else if (currentStep === 'penetrations' && onAddPenetration) {
      drawPlacementHint(ctx, colors);
    }
    
    // Draw drainage mode hint
    if (drainageMode && currentStep === 'outlets') {
      drawDrainageModeHint(ctx, colors);
    }
  };

  const drawDrainageModeHint = (ctx: CanvasRenderingContext2D, colors: any) => {
    ctx.fillStyle = colors.accent;
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    
    const hintText = '🟦 Click roof outline segments to mark as drainage edges';
    ctx.fillText(hintText, 10, 50);
  };

  const drawGrid = (ctx: CanvasRenderingContext2D, width: number, height: number, colors: any) => {
    ctx.strokeStyle = colors.gridLine;
    ctx.lineWidth = 0.5;
    
    const gridSpacing = GRID_SIZE * transform.scale;
    const startX = (transform.offsetX % gridSpacing);
    const startY = (transform.offsetY % gridSpacing);
    
    for (let x = startX; x <= width; x += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    
    for (let y = startY; y <= height; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  };

  const drawRoofOutline = (ctx: CanvasRenderingContext2D, colors: any) => {
    if (outline.segments.length === 0) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let currentPoint = { ...outline.startPoint };
    const transformedStart = transformPoint(currentPoint.x, currentPoint.y);
    
    // Draw start point
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.arc(transformedStart.x, transformedStart.y, 4, 0, 2 * Math.PI);
    ctx.fill();

    // Draw segments
    outline.segments.forEach((segment, index) => {
      const nextPoint = { ...currentPoint };
      const diagonalMultiplier = Math.sqrt(2) / 2;
      
      if (segment.direction === 'custom' && segment.customAngle !== undefined) {
        // Handle custom angle segments
        const angleRad = (segment.customAngle * Math.PI) / 180;
        const deltaX = (segment.length / 10) * Math.cos(angleRad); // Convert mm to cm
        const deltaY = (segment.length / 10) * Math.sin(angleRad);
        nextPoint.x += deltaX;
        nextPoint.y += deltaY;
      } else {
        // Handle predefined direction segments
        switch (segment.direction) {
          case 'right':
            nextPoint.x += segment.length / 10; // Convert mm to cm for display
            break;
          case 'left':
            nextPoint.x -= segment.length / 10;
            break;
          case 'up':
            nextPoint.y -= segment.length / 10;
            break;
          case 'down':
            nextPoint.y += segment.length / 10;
            break;
          case 'up-right':
            nextPoint.x += (segment.length / 10) * diagonalMultiplier;
            nextPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'up-left':
            nextPoint.x -= (segment.length / 10) * diagonalMultiplier;
            nextPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-right':
            nextPoint.x += (segment.length / 10) * diagonalMultiplier;
            nextPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-left':
            nextPoint.x -= (segment.length / 10) * diagonalMultiplier;
            nextPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
        }
      }

      const transformedStart = transformPoint(currentPoint.x, currentPoint.y);
      const transformedNext = transformPoint(nextPoint.x, nextPoint.y);
      
      // Check if segment is hovered or is a drainage edge
      const isHovered = drainageMode && hoveredElement?.type === 'segment' && hoveredElement.id === index;
      const isDrainageEdge = segment.isDrainageEdge;
      
      // Set line style based on state
      if (isDrainageEdge) {
        ctx.strokeStyle = colors.accent; // Blue for drainage edges
        ctx.lineWidth = 4;
      } else if (isHovered) {
        ctx.strokeStyle = colors.primary; // Highlight color for hover
        ctx.lineWidth = 4;
      } else {
        ctx.strokeStyle = colors.roofOutline;
        ctx.lineWidth = 3;
      }

      // Draw the segment line
      ctx.beginPath();
      ctx.moveTo(transformedStart.x, transformedStart.y);
      ctx.lineTo(transformedNext.x, transformedNext.y);
      ctx.stroke();

      // Draw drainage edge arrows if this is a drainage edge
      if (isDrainageEdge) {
        drawDrainageArrows(ctx, transformedStart, transformedNext, colors);
      }

      // Draw segment labels at true midpoint
      const midX = (transformedStart.x + transformedNext.x) / 2;
      const midY = (transformedStart.y + transformedNext.y) / 2;
      
      // Calculate perpendicular offset for label positioning
      const dx = transformedNext.x - transformedStart.x;
      const dy = transformedNext.y - transformedStart.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const offsetDistance = 15;
      const offsetX = (-dy / length) * offsetDistance;
      const offsetY = (dx / length) * offsetDistance;
      
      ctx.fillStyle = colors.dimensionLine;
      ctx.font = `${Math.max(10, 10 * transform.scale)}px Arial`;
      ctx.textAlign = 'center';
      
      // Add angle indicator for custom segments
      const labelText = segment.direction === 'custom' && segment.customAngle !== undefined
        ? `${(segment.length / 1000).toFixed(2)}m (${segment.customAngle.toFixed(1)}°)`
        : `${(segment.length / 1000).toFixed(2)}m`;
      
      ctx.fillText(labelText, midX + offsetX, midY + offsetY);
      
      currentPoint = nextPoint;
    });

    // Draw current point
    const transformedCurrent = transformPoint(currentPoint.x, currentPoint.y);
    ctx.fillStyle = colors.primary;
    ctx.beginPath();
    ctx.arc(transformedCurrent.x, transformedCurrent.y, 6, 0, 2 * Math.PI);
    ctx.fill();
    
    // Draw directional cross indicator
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Horizontal line
    ctx.moveTo(transformedCurrent.x - 10, transformedCurrent.y);
    ctx.lineTo(transformedCurrent.x + 10, transformedCurrent.y);
    // Vertical line
    ctx.moveTo(transformedCurrent.x, transformedCurrent.y - 10);
    ctx.lineTo(transformedCurrent.x, transformedCurrent.y + 10);
    ctx.stroke();

    // Show if shape is closed
    const isClosedShape = outline.segments.length >= 3 && 
           Math.abs(currentPoint.x - outline.startPoint.x) < 10 &&
           Math.abs(currentPoint.y - outline.startPoint.y) < 10;

    if (isClosedShape) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(transformedCurrent.x, transformedCurrent.y);
      ctx.lineTo(transformedStart.x, transformedStart.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  };

  const drawDrainageArrows = (ctx: CanvasRenderingContext2D, startPoint: Point, endPoint: Point, colors: any) => {
    // Calculate segment direction
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);
    
    if (segmentLength === 0) return;
    
    // Normalize direction vector
    const normalizedDx = dx / segmentLength;
    const normalizedDy = dy / segmentLength;
    
    // Calculate perpendicular vector pointing outward (assuming clockwise roof outline)
    const perpX = normalizedDy; // Rotate 90 degrees clockwise
    const perpY = -normalizedDx;
    
    // Draw arrows at regular intervals along the segment
    const arrowSpacing = 30; // pixels
    const numArrows = Math.max(1, Math.floor(segmentLength / arrowSpacing));
    
    ctx.strokeStyle = colors.accent;
    ctx.fillStyle = colors.accent;
    ctx.lineWidth = 2;
    
    for (let i = 0; i < numArrows; i++) {
      // Position arrow along the segment
      const t = (i + 0.5) / numArrows; // Center arrows in their sections
      const arrowX = startPoint.x + dx * t;
      const arrowY = startPoint.y + dy * t;
      
      // Arrow points outward from the roof
      const arrowLength = 12;
      const arrowEndX = arrowX + perpX * arrowLength;
      const arrowEndY = arrowY + perpY * arrowLength;
      
      // Draw arrow line
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowEndX, arrowEndY);
      ctx.stroke();
      
      // Draw arrowhead
      const headLength = 4;
      const headAngle = Math.PI / 6; // 30 degrees
      
      const angle = Math.atan2(perpY, perpX);
      
      ctx.beginPath();
      ctx.moveTo(arrowEndX, arrowEndY);
      ctx.lineTo(
        arrowEndX - headLength * Math.cos(angle - headAngle),
        arrowEndY - headLength * Math.sin(angle - headAngle)
      );
      ctx.moveTo(arrowEndX, arrowEndY);
      ctx.lineTo(
        arrowEndX - headLength * Math.cos(angle + headAngle),
        arrowEndY - headLength * Math.sin(angle + headAngle)
      );
      ctx.stroke();
    }
  };

  const drawOutlet = (ctx: CanvasRenderingContext2D, outlet: Outlet, colors: any) => {
    const isSelected = selectedElement?.type === 'outlet' && selectedElement.id === outlet.id;
    const isHovered = hoveredElement?.type === 'outlet' && hoveredElement.id === outlet.id;
    const transformed = transformPoint(outlet.x, outlet.y);
    
    ctx.fillStyle = isHovered ? colors.accent : colors.outletFill;
    ctx.strokeStyle = isSelected ? colors.selectedOutline : (isHovered ? colors.accent : colors.outletStroke);
    ctx.lineWidth = isSelected ? 3 : (isHovered ? 3 : 2);

    const radius = (outlet.diameter * 100 * transform.scale) / 2; // Convert meters to cm
    
    ctx.beginPath();
    ctx.arc(transformed.x, transformed.y, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    // Draw hover indicator
    if (isHovered && !isSelected) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(transformed.x, transformed.y, radius + 5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw selection indicators
    if (isSelected) {
      drawSelectionIndicators(ctx, transformed.x, transformed.y, radius, colors);
    }

    // Label
    ctx.fillStyle = colors.foreground;
    ctx.font = `${Math.max(10, 12 * transform.scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(`Ø${(outlet.diameter * 1000).toFixed(0)}mm`, transformed.x, transformed.y + radius + 15);
  };

  const drawPenetration = (ctx: CanvasRenderingContext2D, penetration: Penetration, colors: any) => {
    const isSelected = selectedElement?.type === 'penetration' && selectedElement.id === penetration.id;
    const isHovered = hoveredElement?.type === 'penetration' && hoveredElement.id === penetration.id;
    const transformed = transformPoint(penetration.x, penetration.y);
    
    ctx.fillStyle = isHovered ? colors.accent : colors.penetrationFill;
    ctx.strokeStyle = isSelected ? colors.selectedOutline : (isHovered ? colors.accent : colors.penetrationStroke);
    ctx.lineWidth = isSelected ? 3 : (isHovered ? 3 : 2);

    const scaledWidth = penetration.width * 100 * transform.scale; // Convert meters to cm
    const scaledHeight = penetration.height * 100 * transform.scale;
    
    ctx.beginPath();
    ctx.rect(
      transformed.x - scaledWidth / 2,
      transformed.y - scaledHeight / 2,
      scaledWidth,
      scaledHeight
    );
    ctx.fill();
    ctx.stroke();

    // Draw hover indicator
    if (isHovered && !isSelected) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        transformed.x - scaledWidth / 2 - 5,
        transformed.y - scaledHeight / 2 - 5,
        scaledWidth + 10,
        scaledHeight + 10
      );
      ctx.setLineDash([]);
    }

    // Draw selection indicators
    if (isSelected) {
      drawSelectionIndicators(ctx, transformed.x, transformed.y, Math.max(scaledWidth, scaledHeight) / 2, colors);
    }

    // Label
    ctx.fillStyle = colors.foreground;
    ctx.font = `${Math.max(8, 10 * transform.scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(
      `${(penetration.width * 1000).toFixed(0)}×${(penetration.height * 1000).toFixed(0)}mm`,
      transformed.x,
      transformed.y + (scaledHeight / 2) + 15
    );
  };

  const drawSelectionIndicators = (ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, colors: any) => {
    // Draw bounding box with dashed border
    ctx.strokeStyle = colors.selectedOutline;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    
    const boxSize = radius * 2 + 20;
    ctx.strokeRect(x - boxSize/2, y - boxSize/2, boxSize, boxSize);
    
    // Draw resize handles at corners and edges (like Canva)
    const handleSize = 8;
    const halfBox = boxSize / 2;
    
    ctx.fillStyle = 'hsl(var(--background))';
    ctx.strokeStyle = colors.selectedOutline;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    
    // Corner handles
    const corners = [
      { x: x - halfBox, y: y - halfBox }, // Top-left
      { x: x + halfBox, y: y - halfBox }, // Top-right
      { x: x + halfBox, y: y + halfBox }, // Bottom-right
      { x: x - halfBox, y: y + halfBox }, // Bottom-left
    ];
    
    corners.forEach(corner => {
      ctx.fillRect(corner.x - handleSize/2, corner.y - handleSize/2, handleSize, handleSize);
      ctx.strokeRect(corner.x - handleSize/2, corner.y - handleSize/2, handleSize, handleSize);
    });
    
    // Edge handles for resizing
    const edges = [
      { x: x, y: y - halfBox }, // Top
      { x: x + halfBox, y: y }, // Right
      { x: x, y: y + halfBox }, // Bottom
      { x: x - halfBox, y: y }, // Left
    ];
    
    edges.forEach(edge => {
      ctx.fillRect(edge.x - handleSize/2, edge.y - handleSize/2, handleSize, handleSize);
      ctx.strokeRect(edge.x - handleSize/2, edge.y - handleSize/2, handleSize, handleSize);
    });
    
    // Draw rotation handle
    const rotateHandleY = y - halfBox - 20;
    ctx.beginPath();
    ctx.arc(x, rotateHandleY, 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    
    // Connect rotation handle with dashed line
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x, y - halfBox);
    ctx.lineTo(x, rotateHandleY + 4);
    ctx.stroke();
    
    ctx.setLineDash([]);
  };

  const drawPlacementHint = (ctx: CanvasRenderingContext2D, colors: any) => {
    ctx.fillStyle = colors.mutedForeground;
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    
    const hintText = currentStep === 'outlets' 
      ? '🔴 Click to place outlet' 
      : '🟡 Click to place penetration';
    
    ctx.fillText(hintText, 10, 25);
  };

  const calculateDistanceToNearestEdges = (elementX: number, elementY: number) => {
    if (outline.segments.length === 0) return null;

    const bounds = calculateOutlineBounds();
    
    // Calculate distances to each edge
    const distanceToLeft = elementX - bounds.minX;
    const distanceToRight = bounds.maxX - elementX;
    const distanceToTop = elementY - bounds.minY;
    const distanceToBottom = bounds.maxY - elementY;

    return {
      left: distanceToLeft,
      right: distanceToRight,
      top: distanceToTop,
      bottom: distanceToBottom,
      nearestHorizontal: distanceToLeft < distanceToRight ? 'left' : 'right',
      nearestVertical: distanceToTop < distanceToBottom ? 'top' : 'bottom',
      horizontalDistance: Math.min(distanceToLeft, distanceToRight),
      verticalDistance: Math.min(distanceToTop, distanceToBottom)
    };
  };

  const drawElementDimensions = (ctx: CanvasRenderingContext2D, elementX: number, elementY: number, type: 'outlet' | 'penetration', colors: any) => {
    const distances = calculateDistanceToNearestEdges(elementX, elementY);
    if (!distances) return;

    const bounds = calculateOutlineBounds();
    const transformed = transformPoint(elementX, elementY);
    
    // Draw horizontal dimension line
    const horizontalEdgeY = distances.nearestHorizontal === 'left' ? bounds.minY : bounds.minY;
    const horizontalLineY = elementY;
    const horizontalEdgeX = distances.nearestHorizontal === 'left' ? bounds.minX : bounds.maxX;
    
    const transformedHorizontalStart = transformPoint(horizontalEdgeX, horizontalLineY);
    const transformedHorizontalEnd = transformPoint(elementX, horizontalLineY);
    
    // Draw dimension line
    ctx.strokeStyle = colors.dimensionLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    
    // Horizontal dimension line
    const horizontalOffset = type === 'outlet' ? -30 : -40;
    const horizontalDimY = transformed.y + horizontalOffset;
    
    ctx.beginPath();
    ctx.moveTo(transformedHorizontalStart.x, horizontalDimY);
    ctx.lineTo(transformedHorizontalEnd.x, horizontalDimY);
    ctx.stroke();
    
    // Extension lines for horizontal dimension
    ctx.beginPath();
    ctx.moveTo(transformedHorizontalStart.x, horizontalDimY - 5);
    ctx.lineTo(transformedHorizontalStart.x, horizontalDimY + 5);
    ctx.moveTo(transformedHorizontalEnd.x, horizontalDimY - 5);
    ctx.lineTo(transformedHorizontalEnd.x, horizontalDimY + 5);
    ctx.stroke();
    
    // Horizontal dimension text
    const horizontalMidX = (transformedHorizontalStart.x + transformedHorizontalEnd.x) / 2;
    ctx.fillStyle = colors.dimensionLine;
    ctx.font = `${Math.max(8, 10 * transform.scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(`${(distances.horizontalDistance / 100).toFixed(2)}m`, horizontalMidX, horizontalDimY - 8);
    
    // Draw vertical dimension line
    const verticalEdgeX = distances.nearestVertical === 'top' ? bounds.minX : bounds.minX;
    const verticalLineX = elementX;
    const verticalEdgeY = distances.nearestVertical === 'top' ? bounds.minY : bounds.maxY;
    
    const transformedVerticalStart = transformPoint(verticalLineX, verticalEdgeY);
    const transformedVerticalEnd = transformPoint(verticalLineX, elementY);
    
    // Vertical dimension line
    const verticalOffset = type === 'outlet' ? -30 : -40;
    const verticalDimX = transformed.x + verticalOffset;
    
    ctx.beginPath();
    ctx.moveTo(verticalDimX, transformedVerticalStart.y);
    ctx.lineTo(verticalDimX, transformedVerticalEnd.y);
    ctx.stroke();
    
    // Extension lines for vertical dimension
    ctx.beginPath();
    ctx.moveTo(verticalDimX - 5, transformedVerticalStart.y);
    ctx.lineTo(verticalDimX + 5, transformedVerticalStart.y);
    ctx.moveTo(verticalDimX - 5, transformedVerticalEnd.y);
    ctx.lineTo(verticalDimX + 5, transformedVerticalEnd.y);
    ctx.stroke();
    
    // Vertical dimension text
    const verticalMidY = (transformedVerticalStart.y + transformedVerticalEnd.y) / 2;
    ctx.save();
    ctx.translate(verticalDimX - 12, verticalMidY);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${(distances.verticalDistance / 100).toFixed(2)}m`, 0, 0);
    ctx.restore();
    
    ctx.setLineDash([]);
  };

  const drawPenetrationDimensions = (ctx: CanvasRenderingContext2D, penetration: Penetration, colors: any) => {
    const distances = calculateDistanceToNearestEdges(penetration.x, penetration.y);
    if (!distances) return;

    const bounds = calculateOutlineBounds();
    
    // Calculate penetration edge points based on nearest roof edges
    const penetrationHalfWidth = (penetration.width * 100) / 2; // Convert to cm
    const penetrationHalfHeight = (penetration.height * 100) / 2;
    
    // Determine which edge of penetration is closest to roof edge
    let horizontalMeasurePoint = penetration.x;
    let verticalMeasurePoint = penetration.y;
    
    // For horizontal dimension (measuring to left/right roof edge)
    if (distances.nearestHorizontal === 'left') {
      horizontalMeasurePoint = penetration.x - penetrationHalfWidth; // Left edge of penetration
    } else {
      horizontalMeasurePoint = penetration.x + penetrationHalfWidth; // Right edge of penetration
    }
    
    // For vertical dimension (measuring to top/bottom roof edge)
    if (distances.nearestVertical === 'top') {
      verticalMeasurePoint = penetration.y - penetrationHalfHeight; // Top edge of penetration
    } else {
      verticalMeasurePoint = penetration.y + penetrationHalfHeight; // Bottom edge of penetration
    }
    
    const transformedCenter = transformPoint(penetration.x, penetration.y);
    
    // Draw horizontal dimension line
    const horizontalEdgeX = distances.nearestHorizontal === 'left' ? bounds.minX : bounds.maxX;
    const transformedHorizontalStart = transformPoint(horizontalEdgeX, verticalMeasurePoint);
    const transformedHorizontalEnd = transformPoint(horizontalMeasurePoint, verticalMeasurePoint);
    
    // Calculate actual distance from penetration edge to roof edge
    const actualHorizontalDistance = Math.abs(horizontalMeasurePoint - horizontalEdgeX);
    
    ctx.strokeStyle = colors.dimensionLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    
    // Horizontal dimension line
    const horizontalOffset = -40;
    const horizontalDimY = transformedCenter.y + horizontalOffset;
    
    ctx.beginPath();
    ctx.moveTo(transformedHorizontalStart.x, horizontalDimY);
    ctx.lineTo(transformedHorizontalEnd.x, horizontalDimY);
    ctx.stroke();
    
    // Extension lines for horizontal dimension
    ctx.beginPath();
    ctx.moveTo(transformedHorizontalStart.x, horizontalDimY - 5);
    ctx.lineTo(transformedHorizontalStart.x, horizontalDimY + 5);
    ctx.moveTo(transformedHorizontalEnd.x, horizontalDimY - 5);
    ctx.lineTo(transformedHorizontalEnd.x, horizontalDimY + 5);
    ctx.stroke();
    
    // Horizontal dimension text
    const horizontalMidX = (transformedHorizontalStart.x + transformedHorizontalEnd.x) / 2;
    ctx.fillStyle = colors.dimensionLine;
    ctx.font = `${Math.max(8, 10 * transform.scale)}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(`${(actualHorizontalDistance / 100).toFixed(2)}m`, horizontalMidX, horizontalDimY - 8);
    
    // Draw vertical dimension line
    const verticalEdgeY = distances.nearestVertical === 'top' ? bounds.minY : bounds.maxY;
    const transformedVerticalStart = transformPoint(horizontalMeasurePoint, verticalEdgeY);
    const transformedVerticalEnd = transformPoint(horizontalMeasurePoint, verticalMeasurePoint);
    
    // Calculate actual distance from penetration edge to roof edge
    const actualVerticalDistance = Math.abs(verticalMeasurePoint - verticalEdgeY);
    
    // Vertical dimension line
    const verticalOffset = -40;
    const verticalDimX = transformedCenter.x + verticalOffset;
    
    ctx.beginPath();
    ctx.moveTo(verticalDimX, transformedVerticalStart.y);
    ctx.lineTo(verticalDimX, transformedVerticalEnd.y);
    ctx.stroke();
    
    // Extension lines for vertical dimension
    ctx.beginPath();
    ctx.moveTo(verticalDimX - 5, transformedVerticalStart.y);
    ctx.lineTo(verticalDimX + 5, transformedVerticalStart.y);
    ctx.moveTo(verticalDimX - 5, transformedVerticalEnd.y);
    ctx.lineTo(verticalDimX + 5, transformedVerticalEnd.y);
    ctx.stroke();
    
    // Vertical dimension text
    const verticalMidY = (transformedVerticalStart.y + transformedVerticalEnd.y) / 2;
    ctx.save();
    ctx.translate(verticalDimX - 12, verticalMidY);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${(actualVerticalDistance / 100).toFixed(2)}m`, 0, 0);
    ctx.restore();
    
    ctx.setLineDash([]);
  };

  const getResizeHandle = (x: number, y: number, elementX: number, elementY: number, radius: number) => {
    const boxSize = radius * 2 + 20;
    const halfBox = boxSize / 2;
    const handleSize = 8;
    
    // Check corner handles
    const corners = [
      { name: 'nw', x: elementX - halfBox, y: elementY - halfBox },
      { name: 'ne', x: elementX + halfBox, y: elementY - halfBox },
      { name: 'se', x: elementX + halfBox, y: elementY + halfBox },
      { name: 'sw', x: elementX - halfBox, y: elementY + halfBox },
    ];
    
    for (const corner of corners) {
      if (x >= corner.x - handleSize/2 && x <= corner.x + handleSize/2 &&
          y >= corner.y - handleSize/2 && y <= corner.y + handleSize/2) {
        return corner.name;
      }
    }
    
    // Check edge handles
    const edges = [
      { name: 'n', x: elementX, y: elementY - halfBox },
      { name: 'e', x: elementX + halfBox, y: elementY },
      { name: 's', x: elementX, y: elementY + halfBox },
      { name: 'w', x: elementX - halfBox, y: elementY },
    ];
    
    for (const edge of edges) {
      if (x >= edge.x - handleSize/2 && x <= edge.x + handleSize/2 &&
          y >= edge.y - handleSize/2 && y <= edge.y + handleSize/2) {
        return edge.name;
      }
    }
    
    return null;
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Handle drainage edge mode
    if (drainageMode && currentStep === 'outlets') {
      const clickedSegmentIndex = getClickedSegmentIndex(x, y);
      if (clickedSegmentIndex !== -1) {
        onSegmentClick?.(clickedSegmentIndex);
        return;
      }
    }

    // Check for outlet clicks first (only if not in drainage mode)
    if (!drainageMode) {
      for (const outlet of outlets) {
        const transformed = transformPoint(outlet.x, outlet.y);
        const radius = (outlet.diameter * 100 * transform.scale) / 2;
        const distance = Math.sqrt((x - transformed.x) ** 2 + (y - transformed.y) ** 2);
        if (distance <= radius) {
          setSelectedElement({ type: 'outlet', id: outlet.id });
          setHoveredElement(null); // Clear hover when selecting
          onOutletSelect?.(outlet);
          return; // Prevent adding new elements
        }
      }
    }

    // Check for penetration clicks
    for (const penetration of penetrations) {
      const transformed = transformPoint(penetration.x, penetration.y);
      const scaledWidth = penetration.width * 100 * transform.scale;
      const scaledHeight = penetration.height * 100 * transform.scale;
      if (
        x >= transformed.x - scaledWidth / 2 &&
        x <= transformed.x + scaledWidth / 2 &&
        y >= transformed.y - scaledHeight / 2 &&
        y <= transformed.y + scaledHeight / 2
      ) {
        setSelectedElement({ type: 'penetration', id: penetration.id });
        setHoveredElement(null); // Clear hover when selecting
        onPenetrationSelect?.(penetration);
        return; // Prevent adding new elements
      }
    }

    // Only add new elements if no existing element was clicked
    if (currentStep === 'outlets' && !drainageMode && onAddOutlet) {
      const worldPos = inverseTransformPoint(x, y);
      onAddOutlet(worldPos.x, worldPos.y);
    } else if (currentStep === 'penetrations' && onAddPenetration) {
      const worldPos = inverseTransformPoint(x, y);
      onAddPenetration(worldPos.x, worldPos.y);
    } else {
      // Deselect if clicking on empty space while an element is selected
      setSelectedElement(null);
      setHoveredElement(null);
      onOutletSelect?.(null);
      onPenetrationSelect?.(null);
    }
  };

  const getClickedSegmentIndex = (mouseX: number, mouseY: number): number => {
    if (outline.segments.length === 0) return -1;

    let currentPoint = { ...outline.startPoint };
    const clickThreshold = 10; // pixels

    for (let i = 0; i < outline.segments.length; i++) {
      const segment = outline.segments[i];
      const nextPoint = { ...currentPoint };
      const diagonalMultiplier = Math.sqrt(2) / 2;

      // Calculate next point using the same logic as drawing
      if (segment.direction === 'custom' && segment.customAngle !== undefined) {
        const angleRad = (segment.customAngle * Math.PI) / 180;
        const deltaX = (segment.length / 10) * Math.cos(angleRad);
        const deltaY = (segment.length / 10) * Math.sin(angleRad);
        nextPoint.x += deltaX;
        nextPoint.y += deltaY;
      } else {
        switch (segment.direction) {
          case 'right':
            nextPoint.x += segment.length / 10;
            break;
          case 'left':
            nextPoint.x -= segment.length / 10;
            break;
          case 'up':
            nextPoint.y -= segment.length / 10;
            break;
          case 'down':
            nextPoint.y += segment.length / 10;
            break;
          case 'up-right':
            nextPoint.x += (segment.length / 10) * diagonalMultiplier;
            nextPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'up-left':
            nextPoint.x -= (segment.length / 10) * diagonalMultiplier;
            nextPoint.y -= (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-right':
            nextPoint.x += (segment.length / 10) * diagonalMultiplier;
            nextPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
          case 'down-left':
            nextPoint.x -= (segment.length / 10) * diagonalMultiplier;
            nextPoint.y += (segment.length / 10) * diagonalMultiplier;
            break;
        }
      }

      // Transform points to screen coordinates
      const transformedStart = transformPoint(currentPoint.x, currentPoint.y);
      const transformedEnd = transformPoint(nextPoint.x, nextPoint.y);

      // Check if mouse click is near this line segment
      const distance = pointToLineDistance(
        mouseX, mouseY,
        transformedStart.x, transformedStart.y,
        transformedEnd.x, transformedEnd.y
      );

      if (distance < clickThreshold) {
        return i;
      }

      currentPoint = nextPoint;
    }

    return -1;
  };

  const pointToLineDistance = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) {
      param = dot / lenSq;
    }

    let xx, yy;
    if (param < 0) {
      xx = x1;
      yy = y1;
    } else if (param > 1) {
      xx = x2;
      yy = y2;
    } else {
      xx = x1 + param * C;
      yy = y1 + param * D;
    }

    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedElement) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (selectedElement.type === 'outlet') {
      const outlet = outlets.find(o => o.id === selectedElement.id);
      if (outlet) {
        const transformed = transformPoint(outlet.x, outlet.y);
        const radius = (outlet.diameter * 100 * transform.scale) / 2;
        const handle = getResizeHandle(x, y, transformed.x, transformed.y, radius);
        
        if (handle) {
          setIsResizing(true);
          setResizeHandle(handle);
        } else {
          setDragOffset({ x: x - transformed.x, y: y - transformed.y });
          setIsDragging(true);
        }
      }
    } else if (selectedElement.type === 'penetration') {
      const penetration = penetrations.find(p => p.id === selectedElement.id);
      if (penetration) {
        const transformed = transformPoint(penetration.x, penetration.y);
        const scaledWidth = penetration.width * 100 * transform.scale;
        const scaledHeight = penetration.height * 100 * transform.scale;
        const radius = Math.max(scaledWidth, scaledHeight) / 2;
        const handle = getResizeHandle(x, y, transformed.x, transformed.y, radius);
        
        if (handle) {
          setIsResizing(true);
          setResizeHandle(handle);
        } else {
          setDragOffset({ x: x - transformed.x, y: y - transformed.y });
          setIsDragging(true);
        }
      }
    }
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Handle dragging and resizing first
    if (isDragging && selectedElement) {
      const adjustedX = x - dragOffset.x;
      const adjustedY = y - dragOffset.y;
      const worldPos = inverseTransformPoint(adjustedX, adjustedY);

      if (selectedElement.type === 'outlet') {
        onOutletMove?.(selectedElement.id, worldPos.x, worldPos.y);
      } else if (selectedElement.type === 'penetration') {
        onPenetrationMove?.(selectedElement.id, worldPos.x, worldPos.y);
      }
      return;
    }

    if (isResizing && resizeHandle && selectedElement) {
      if (selectedElement.type === 'outlet') {
        const outlet = outlets.find(o => o.id === selectedElement.id);
        if (outlet) {
          const transformed = transformPoint(outlet.x, outlet.y);
          const distance = Math.sqrt((x - transformed.x) ** 2 + (y - transformed.y) ** 2);
          const newDiameter = Math.max(0.05, (distance * 2) / (100 * transform.scale));
          onOutletResize?.(selectedElement.id, newDiameter);
        }
      } else if (selectedElement.type === 'penetration') {
        const penetration = penetrations.find(p => p.id === selectedElement.id);
        if (penetration) {
          const transformed = transformPoint(penetration.x, penetration.y);
          const deltaX = Math.abs(x - transformed.x);
          const deltaY = Math.abs(y - transformed.y);
          
          let newWidth = penetration.width;
          let newHeight = penetration.height;
          
          if (resizeHandle.includes('e') || resizeHandle.includes('w')) {
            newWidth = Math.max(0.05, (deltaX * 2) / (100 * transform.scale));
          }
          if (resizeHandle.includes('n') || resizeHandle.includes('s')) {
            newHeight = Math.max(0.05, (deltaY * 2) / (100 * transform.scale));
          }
          
          onPenetrationResize?.(selectedElement.id, newWidth, newHeight);
        }
      }
      return;
    }

    // Handle hover detection when not dragging/resizing
    let foundHover = false;
    
    // Check segment hover in drainage mode
    if (drainageMode && currentStep === 'outlets') {
      const hoveredSegmentIndex = getClickedSegmentIndex(x, y);
      if (hoveredSegmentIndex !== -1) {
        setHoveredElement({ type: 'segment', id: hoveredSegmentIndex });
        foundHover = true;
      }
    }
    
    if (!foundHover && !drainageMode) {
      // Check outlet hover (only if not in drainage mode)
      for (const outlet of outlets) {
        const transformed = transformPoint(outlet.x, outlet.y);
        const radius = (outlet.diameter * 100 * transform.scale) / 2;
        const distance = Math.sqrt((x - transformed.x) ** 2 + (y - transformed.y) ** 2);
        if (distance <= radius) {
          setHoveredElement({ type: 'outlet', id: outlet.id });
          foundHover = true;
          break;
        }
      }
    }
    
    if (!foundHover) {
      // Check penetration hover if no outlet hover found
      for (const penetration of penetrations) {
        const transformed = transformPoint(penetration.x, penetration.y);
        const scaledWidth = penetration.width * 100 * transform.scale;
        const scaledHeight = penetration.height * 100 * transform.scale;
        if (
          x >= transformed.x - scaledWidth / 2 &&
          x <= transformed.x + scaledWidth / 2 &&
          y >= transformed.y - scaledHeight / 2 &&
          y <= transformed.y + scaledHeight / 2
        ) {
          setHoveredElement({ type: 'penetration', id: penetration.id });
          foundHover = true;
          break;
        }
      }
    }
    
    // Clear hover if nothing is hovered
    if (!foundHover) {
      setHoveredElement(null);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    setIsResizing(false);
    setResizeHandle(null);
  };

  const getCursorStyle = () => {
    if (isDragging || isResizing) return 'cursor-grabbing';
    if (hoveredElement) {
      if (hoveredElement.type === 'segment' && drainageMode) return 'cursor-pointer';
      if (hoveredElement.type === 'outlet' || hoveredElement.type === 'penetration') return 'cursor-pointer';
    }
    if ((currentStep === 'outlets' && onAddOutlet) || (currentStep === 'penetrations' && onAddPenetration)) {
      if (!drainageMode) return 'cursor-crosshair';
    }
    return 'cursor-default';
  };

  return (
    <div className="w-full h-full bg-canvas-bg border border-border rounded-lg overflow-hidden flex items-center justify-center">
      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className={`${getCursorStyle()} max-w-full max-h-full object-contain`}
        onClick={handleCanvasClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
};