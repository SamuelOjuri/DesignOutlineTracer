import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

interface RoofSegment {
  direction: 'up' | 'down' | 'left' | 'right' | 'up-right' | 'up-left' | 'down-right' | 'down-left' | 'custom';
  length: number;
  customAngle?: number; // Angle in degrees for custom direction
  isDrainageEdge?: boolean; // Whether this segment is marked as a drainage edge
}

interface RoofOutline {
  segments: RoofSegment[];
  startPoint: { x: number; y: number };
}

interface Outlet {
  id: string;
  x: number;
  y: number;
  diameter: number;
}

interface Penetration {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ProjectDetails {
  name: string;
  company: string;
  email: string;
  projectName: string;
  projectAddress: string;
  targetUValue: string;
  productType: string;
  deckType: string;
  additionalNotes: string;
}

interface RequestBody {
  outline: RoofOutline;
  outlets: Outlet[];
  penetrations: Penetration[];
  projectDetails: ProjectDetails;
}

// Function to generate DXF content
function generateDXF(outline: RoofOutline, outlets: Outlet[], penetrations: Penetration[]): string {
  let dxf = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
4
0
LAYER
2
0
70
0
62
7
6
CONTINUOUS
0
LAYER
2
Outline
70
0
62
1
6
CONTINUOUS
0
LAYER
2
Outlets
70
0
62
2
6
CONTINUOUS
0
LAYER
2
Penetrations
70
0
62
3
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
2
OUTLET_CIRCLE
70
0
10
0
20
0
`;

  // Define outlet block as circle polyline
  const segments = 16;
  const blockRadius = 75; // Standard radius for block definition
  dxf += `0
POLYLINE
8
Outlets
70
1
`;
  
  // Add vertices for circle in block
  for (let i = 0; i < segments; i++) {
    const angle = (i * 2 * Math.PI) / segments;
    const x = blockRadius * Math.cos(angle);
    const y = blockRadius * Math.sin(angle);
    dxf += `0
VERTEX
8
Outlets
10
${x}
20
${y}
`;
  }
  
  // End polyline and block
  dxf += `0
SEQEND
8
Outlets
0
ENDBLK
2
OUTLET_CIRCLE
8
Outlets
0
ENDSEC
0
SECTION
2
ENTITIES
`;

  // Convert coordinates to proper scale - all in millimeters for DXF
  // Roof outline: startPoint is in pixels, convert to mm (assuming 1 pixel = 1 cm)
  let currentX = outline.startPoint.x * 10; // Convert cm to mm
  let currentY = -outline.startPoint.y * 10; // Convert cm to mm and flip Y for DXF
  
  // Collect all points for the outline first
  const outlinePoints = [{ x: currentX, y: currentY }];
  
  // Calculate all points
  for (let i = 0; i < outline.segments.length; i++) {
    const segment = outline.segments[i];
    let nextX = currentX;
    let nextY = currentY;
    
    // segment.length is already in mm
    const diagonalMultiplier = Math.sqrt(2) / 2;
    
    if (segment.direction === 'custom' && segment.customAngle !== undefined) {
      // Handle custom angle segments - convert angle to match canvas coordinate system
      const angleRad = (segment.customAngle * Math.PI) / 180;
      const deltaX = segment.length * Math.cos(angleRad);
      const deltaY = segment.length * Math.sin(angleRad);
      nextX = currentX + deltaX;
      nextY = currentY - deltaY; // Flip Y for DXF coordinate system
    } else {
      // Handle predefined direction segments
      switch (segment.direction) {
        case 'right':
          nextX = currentX + segment.length;
          break;
        case 'left':
          nextX = currentX - segment.length;
          break;
        case 'up':
          nextY = currentY + segment.length; // Up is positive Y in DXF
          break;
        case 'down':
          nextY = currentY - segment.length; // Down is negative Y in DXF
          break;
        case 'up-right':
          nextX = currentX + segment.length * diagonalMultiplier;
          nextY = currentY + segment.length * diagonalMultiplier;
          break;
        case 'up-left':
          nextX = currentX - segment.length * diagonalMultiplier;
          nextY = currentY + segment.length * diagonalMultiplier;
          break;
        case 'down-right':
          nextX = currentX + segment.length * diagonalMultiplier;
          nextY = currentY - segment.length * diagonalMultiplier;
          break;
        case 'down-left':
          nextX = currentX - segment.length * diagonalMultiplier;
          nextY = currentY - segment.length * diagonalMultiplier;
          break;
      }
    }
    
    outlinePoints.push({ x: nextX, y: nextY });
    currentX = nextX;
    currentY = nextY;
  }

  // Draw outline as a polyline for better CAD compatibility
  dxf += `0
POLYLINE
8
Outline
70
1
`;

  // Add all vertices
  for (const point of outlinePoints) {
    dxf += `0
VERTEX
8
Outline
10
${point.x}
20
${point.y}
`;
  }

  // Close the polyline
  dxf += `0
SEQEND
8
Outline
`;

  // Insert outlet blocks
  outlets.forEach((outlet) => {
    const radius = (outlet.diameter * 1000) / 2; // Convert meters to mm, then to radius
    // Convert canvas coordinates (cm) to mm for DXF
    const outletX = outlet.x * 10; // Convert cm to mm
    const outletY = -outlet.y * 10; // Convert cm to mm and flip Y
    
    // Calculate scale factor (actual radius / block radius)
    const scale = radius / 75; // 75 is the blockRadius defined above
    
    // Insert block with scaling
    dxf += `0
INSERT
2
OUTLET_CIRCLE
8
Outlets
10
${outletX}
20
${outletY}
41
${scale}
42
${scale}
`;
  });

  // Draw penetrations as rectangles using lines
  penetrations.forEach((penetration) => {
    // Convert canvas coordinates (cm) to mm for DXF
    const centerX = penetration.x * 10; // Convert cm to mm
    const centerY = -penetration.y * 10; // Convert cm to mm and flip Y
    const w = penetration.width * 1000; // Convert meters to mm
    const h = penetration.height * 1000;
    
    // Calculate rectangle corners from center point (same as canvas)
    const x = centerX - w / 2; // Top-left X
    const y = centerY + h / 2; // Top-left Y (remember Y is flipped)
    
    // Draw 4 lines for rectangle
    dxf += `0
LINE
8
Penetrations
10
${x}
20
${y}
11
${x + w}
21
${y}
0
LINE
8
Penetrations
10
${x + w}
20
${y}
11
${x + w}
21
${y - h}
0
LINE
8
Penetrations
10
${x + w}
20
${y - h}
11
${x}
21
${y - h}
0
LINE
8
Penetrations
10
${x}
20
${y - h}
11
${x}
21
${y}
`;
  });

  dxf += `0
ENDSEC
0
EOF`;

  return dxf;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    })
  }

  try {
    const { outline, outlets, penetrations, projectDetails }: RequestBody = await req.json()

    if (!RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required')
    }

    // Generate DXF content
    const dxfContent = generateDXF(outline, outlets, penetrations)
    
    // Encode DXF as base64 for email attachment
    const dxfBase64 = btoa(dxfContent)

    // Prepare email content
    const emailHtml = `
      <h2>New Roof Design Project: ${projectDetails.projectName}</h2>
      
      <h3>Contact Information</h3>
      <ul>
        <li><strong>Name:</strong> ${projectDetails.name}</li>
        <li><strong>Company:</strong> ${projectDetails.company}</li>
        <li><strong>Email:</strong> ${projectDetails.email}</li>
      </ul>
      
      <h3>Project Details</h3>
      <ul>
        <li><strong>Project Name:</strong> ${projectDetails.projectName}</li>
        <li><strong>Project Address:</strong> ${projectDetails.projectAddress || 'Not specified'}</li>
        <li><strong>Target U-Value:</strong> ${projectDetails.targetUValue}</li>
        <li><strong>Product Type:</strong> ${projectDetails.productType}</li>
        <li><strong>Deck Type:</strong> ${projectDetails.deckType}</li>
      </ul>
      
      <h3>Design Summary</h3>
      <ul>
        <li><strong>Roof Outline Segments:</strong> ${outline.segments.length}</li>
        <li><strong>Outlets:</strong> ${outlets.length}</li>
        <li><strong>Penetrations:</strong> ${penetrations.length}</li>
      </ul>
      
      ${projectDetails.additionalNotes ? `
      <h3>Additional Notes</h3>
      <p>${projectDetails.additionalNotes}</p>
      ` : ''}
      
      <p>Please find the DWG file attached for import into your CAD software.</p>
    `

    // Send email using Resend
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Roof Designer <onboarding@resend.dev>',
        to: ['nick@taperedplus.co.uk'],
        cc: [projectDetails.email],
        subject: `New Roof Design Project: ${projectDetails.projectName}`,
        html: emailHtml,
        attachments: [
          {
            filename: `${projectDetails.projectName.replace(/[^a-zA-Z0-9]/g, '_')}_roof_design.dwg`,
            content: dxfBase64,
            content_type: 'application/acad'
          }
        ]
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Resend API error: ${error}`)
    }

    const result = await response.json()
    
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Email sent successfully',
        emailId: result.id 
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        },
        status: 200 
      }
    )

  } catch (error) {
    console.error('Error sending email:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message 
      }),
      { 
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        },
        status: 500 
      }
    )
  }
})