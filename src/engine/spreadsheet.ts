import * as XLSX from "xlsx";
import type { RawRecord } from "../adapters/source/types.js";

export interface ParsedSheet {
  rows: RawRecord[];
  columns: string[];
}

/** Reads an uploaded .xlsx or .csv into plain rows keyed by the header names. */
export function parseSpreadsheet(buffer: ArrayBuffer): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], columns: [] };

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return { rows: [], columns: [] };

  const rows = XLSX.utils.sheet_to_json<RawRecord>(sheet, { defval: "" });
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return { rows, columns };
}

/**
 * Guesses the field map from the header names, so a straightforward export needs no
 * manual mapping. Anything it cannot place is left for the user to correct.
 */
export function guessFieldMap(columns: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const find = (re: RegExp) => columns.find((c) => re.test(c.trim()));

  const email = find(/^e-?mail|email.?address|work.?email$/i);
  if (email) map.email = email;

  const name = find(/^(full.?)?name$|^contact$/i) ?? find(/first.?name/i);
  if (name) map.name = name;

  const role = find(/title|role|position|designation/i);
  if (role) map.role = role;

  // A website column says more than a company name: the site is what gets read for the
  // opening line, and a name in company_domain resolves to no site at all.
  const company = find(/website|domain|^url$/i) ?? find(/company|organi[sz]ation|account/i);
  if (company) map.company_domain = company;

  const tz = find(/time.?zone|^tz$/i);
  if (tz) map.timezone = tz;

  const phone = find(/phone|mobile|cell|whats.?app|contact.?(no|num)|^tel/i);
  if (phone) map.phone = phone;

  // A LinkedIn profile URL (or bare slug) is the one input the LinkedIn channel needs; the
  // engine resolves it to a provider id on its own.
  const linkedin = find(/linked.?in|li.?(url|profile)/i);
  if (linkedin) map.linkedin = linkedin;

  // Lead-form answers. Ingest keeps anything mapped beyond the person fields under
  // enrichment.form, where the lead planner reads it.
  const answers: Array<[string, RegExp]> = [
    ["team_size", /team.?size|head.?count|employees/i],
    ["timeline", /timeline|when.?(are|looking)/i],
    ["main_problem", /problem|challenge|help.?you/i],
    ["business_type", /business.?type|industry|type.?of.?business/i],
    ["city", /^city$|location/i],
    // When they actually filled the form. An upload happens today; the lead may be months
    // old, and nothing else on the row says so.
    ["submitted_at", /submitted|form.?date|enquir|^date$/i],
  ];
  for (const [key, re] of answers) {
    const column = find(re);
    if (column) map[key] = column;
  }

  return map;
}
