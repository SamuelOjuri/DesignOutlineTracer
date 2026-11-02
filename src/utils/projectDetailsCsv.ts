import type { ProjectDetails } from "@/types/roof";
import { PROJECT_DETAIL_FIELDS, displayValue } from "@/lib/projectDetailsFields";

export const PROJECT_DETAILS_CSV_HEADER = ["field_key", "field_label", "value"] as const;

/** Spreadsheet apps evaluate these leading characters as formulas (CSV injection). */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]|^\s|\s$/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Serialises only what was typed or selected in the Project Details form. The uploaded
 * performance specification is packaged separately and never merged into these rows.
 * Blank fields are kept so the receiver can see what was not entered.
 */
export function projectDetailsCsv(details: ProjectDetails): string {
  const rows = [
    [...PROJECT_DETAILS_CSV_HEADER],
    ...PROJECT_DETAIL_FIELDS.map(field => [field.key, field.label, displayValue(field, details[field.key] ?? "")]),
  ];
  return `\uFEFF${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function enteredFieldCount(details: ProjectDetails): number {
  return PROJECT_DETAIL_FIELDS.filter(field => (details[field.key] ?? "").trim() !== "").length;
}
