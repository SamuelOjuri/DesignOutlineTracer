import type { ProjectDetails } from "@/types/roof";

export interface FieldOption {
  value: string;
  label: string;
}

export const ACCOUNT_OPTIONS: FieldOption[] = [
  { value: "axter-limited", label: "Axter Limited" },
  { value: "taperedplus-limited", label: "TaperedPlus Limited" },
];

export const FALL_TYPE_OPTIONS: FieldOption[] = [
  { value: "1:80", label: "1:80" },
  { value: "1:60", label: "1:60" },
  { value: "1:40", label: "1:40" },
];

export const BUILD_METHOD_OPTIONS: FieldOption[] = [
  { value: "multilayer", label: "MultiLayer" },
  { value: "prebonded", label: "Prebonded" },
];

export interface ProjectDetailField {
  key: keyof ProjectDetails;
  label: string;
  options?: FieldOption[];
}

/**
 * Form order; labels match the visible form labels without required markers. Fields covered by the
 * CRM performance specification (U-values, tapered insulation, decking, membrane) are deliberately absent.
 */
export const PROJECT_DETAIL_FIELDS: ProjectDetailField[] = [
  { key: "name", label: "Name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email Address" },
  { key: "account", label: "Account", options: ACCOUNT_OPTIONS },
  { key: "projectName", label: "Project Name" },
  { key: "projectAddress", label: "Project Address (Including Postcode)" },
  { key: "maxInsulationHeight", label: "Max Insulation Height Allowable" },
  { key: "fallType", label: "Fall Type", options: FALL_TYPE_OPTIONS },
  { key: "buildMethod", label: "Build Method", options: BUILD_METHOD_OPTIONS },
  { key: "additionalNotes", label: "Additional Notes" },
];

export function displayValue(field: ProjectDetailField, value: string): string {
  return field.options?.find(option => option.value === value)?.label ?? value;
}

export function emptyProjectDetails(): ProjectDetails {
  return {
    name: "", company: "", email: "", account: "", projectName: "", projectAddress: "",
    maxInsulationHeight: "", fallType: "", buildMethod: "", additionalNotes: "",
  };
}
