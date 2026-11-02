import { describe, expect, it } from "vitest";
import { emptyProjectDetails } from "@/lib/projectDetailsFields";
import { csvCell, enteredFieldCount, projectDetailsCsv } from "./projectDetailsCsv";

describe("project details CSV", () => {
  it("lists every form field in form order with display labels and blanks kept", () => {
    const csv = projectDetailsCsv({ ...emptyProjectDetails(), name: "Sam Ojuri", projectName: "Third floor terrace",
      maxInsulationHeight: "200mm", fallType: "1:80", buildMethod: "multilayer" });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const rows = csv.slice(1).trimEnd().split("\r\n");
    expect(rows[0]).toBe("field_key,field_label,value");
    expect(rows).toHaveLength(11);
    expect(rows).toContain("name,Name,Sam Ojuri");
    expect(rows).toContain("maxInsulationHeight,Max Insulation Height Allowable,200mm");
    expect(rows).toContain("fallType,Fall Type,1:80");
    expect(rows).toContain("buildMethod,Build Method,MultiLayer");
    expect(rows).toContain("email,Email Address,");
    expect(rows).toContain('projectAddress,Project Address (Including Postcode),');
    expect(rows[rows.length - 1]).toBe("additionalNotes,Additional Notes,");
  });

  it("omits fields covered by the performance specification", () => {
    const csv = projectDetailsCsv(emptyProjectDetails());
    for (const key of ["targetUValue", "productType", "deckType", "waterproofingType"]) expect(csv).not.toContain(key);
  });

  it("quotes separators, quotes and line breaks, and neutralises spreadsheet formulas", () => {
    expect(csvCell('Roof "A", north')).toBe('"Roof ""A"", north"');
    expect(csvCell("Line one\nLine two")).toBe('"Line one\nLine two"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+44 1234")).toBe("'+44 1234");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell(" padded")).toBe('" padded"');
    expect(csvCell("0.18")).toBe("0.18");
  });

  it("keeps unknown select values verbatim and counts entered fields", () => {
    const details = { ...emptyProjectDetails(), fallType: "1:100", additionalNotes: "  " , company: "TaperedPlus" };
    expect(projectDetailsCsv(details)).toContain("fallType,Fall Type,1:100\r\n");
    expect(enteredFieldCount(details)).toBe(2);
  });
});
