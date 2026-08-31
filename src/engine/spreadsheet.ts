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

  const company = find(/company|organi[sz]ation|account|domain/i);
  if (company) map.company_domain = company;

  const tz = find(/time.?zone|^tz$/i);
  if (tz) map.timezone = tz;

  return map;
}
