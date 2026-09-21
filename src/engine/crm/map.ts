import type { McpTool } from "../../mcp/client.js";
import { crmMap, type CrmKind, type CrmMap } from "../../schemas/crm.js";

/**
 * What an event type means when nobody has said. CRMs name the same moments differently
 * (LEAD_WON, deal.won, OpportunityClosedWon), and every one of them carries the word, so
 * the name is read rather than listed. A map can still override any type the name misleads.
 */
const KIND_BY_NAME: Array<[RegExp, CrmKind]> = [
  [/reopen/i, "reopened"],
  [/lost_?reason/i, "field"],
  [/(^|_|\.)won($|_|\.)|closed_?won/i, "won"],
  [/(^|_|\.)lost($|_|\.)|closed_?lost/i, "lost"],
  [/meeting.*cancel|cancel.*meeting/i, "meeting_canceled"],
  [/transcript|meeting.*(held|complet|ended|summary)/i, "meeting_held"],
  [/meeting|appointment|demo/i, "meeting_booked"],
  [/note/i, "note"],
  [/call.*(fail|miss|no_?answer|busy)/i, "call_missed"],
  [/call.*initiat/i, "info"],
  [/call/i, "call"],
  [/email.*(receiv|inbound|incoming)/i, "email_in"],
  [/email.*(sent|repl|outbound|outgoing)/i, "email_out"],
  [/follow|next_?activity|task|reminder/i, "followup"],
  [/owner|assign/i, "owner"],
  [/pipeline|stage/i, "stage"],
  [/status/i, "status"],
  [/delet/i, "deleted"],
  [/creat|copied|import/i, "created"],
  [/updat|changed|edit/i, "field"],
];

export function kindOf(type: string, map: Pick<CrmMap, "eventKinds">): CrmKind {
  const explicit = map.eventKinds[type];
  if (explicit) return explicit;
  for (const [re, kind] of KIND_BY_NAME) if (re.test(type)) return kind;
  return "info";
}

const argNames = (tool: McpTool | undefined): string[] =>
  Object.keys(((tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});

function pick(tools: McpTool[], name: RegExp, needArg?: RegExp): McpTool | undefined {
  return tools.find((t) => name.test(t.name) && (!needArg || argNames(t).some((a) => needArg.test(a))));
}

/** The argument a tool takes a record id in, whatever it is called. */
function recordArg(tool: McpTool | undefined): string | undefined {
  return argNames(tool).find((a) => /^(lead|deal|contact|record|opportunity)_?id$/i.test(a));
}

function pageArgs(tool: McpTool | undefined): { limitArg?: string; cursorArg?: string } {
  const names = argNames(tool);
  return {
    limitArg: names.find((a) => /^(limit|page_?size|per_?page)$/i.test(a)),
    cursorArg: names.find((a) => /^(cursor|after|page_?token|next)$/i.test(a)),
  };
}

/**
 * A first draft of the map from the tool list alone.
 *
 * It is a draft: a person approves it before anything is read, and it can be edited. What
 * it saves is the part nobody should have to type — which tool finds a person, which one
 * lists a record's history — for servers that name their tools the way most CRMs do. When
 * the tools do not look like a CRM it returns nothing, and the connection offers no CRM.
 */
export function proposeCrmMap(tools: McpTool[], scope: Record<string, unknown> = {}): CrmMap | null {
  const find = pick(tools, /^(search|find|list)_(leads|contacts|deals|people|records)$/i, /^(query|q|search|email)$/i);
  const history =
    pick(tools, /(timeline|activit(y|ies)|history|events|audit)/i, /^(lead|deal|contact|record)_?id$/i) ??
    pick(tools, /(timeline|history|events)/i);
  if (!find || !history) return null;

  const record = pick(tools, /^get_(lead|contact|deal|record)$/i);
  const notes = pick(tools, /^(list|get|search)_(lead_|deal_|contact_)?notes$/i);
  const meetings = pick(tools, /^(list|get)_(lead_|deal_)?meetings$/i);
  const queryArg = argNames(find).find((a) => /^(query|q|search)$/i.test(a)) ?? "email";
  const findPage = pageArgs(find);
  const historyPage = pageArgs(history);
  const historyId = recordArg(history) ?? "leadId";
  const fromArg = argNames(history).find((a) => /^(from|since|start|after_date|updated_since)$/i.test(a)) ?? "from";

  const list = (tool: McpTool, args: Record<string, unknown>, page: { limitArg?: string; cursorArg?: string }) => ({
    tool: tool.name,
    args: { ...args, ...(page.limitArg ? { [page.limitArg]: 50 } : {}) },
    items: "data",
    ...(page.cursorArg ? { next: "next_cursor", cursorArg: page.cursorArg } : {}),
  });

  return crmMap.parse({
    scope,
    projects: [],
    findByEmail: list(find, { [queryArg]: "$email" }, findPage),
    findByPhone: list(find, { [queryArg]: "$phone" }, findPage),
    ...(record ? { record: { tool: record.name, args: { [recordArg(record) ?? "leadId"]: "$recordId" }, path: "lead" } } : {}),
    events: list(history, { [historyId]: "$recordId" }, historyPage),
    changes: list(history, { [fromArg]: "$from" }, historyPage),
    ...(notes
      ? { notes: list(notes, { [recordArg(notes) ?? "leadId"]: "$recordId" }, pageArgs(notes)) }
      : {}),
    ...(meetings
      ? { meetings: list(meetings, { [recordArg(meetings) ?? "leadId"]: "$recordId" }, pageArgs(meetings)) }
      : {}),
    fields: {
      id: "leadId",
      name: "title",
      email: "email",
      phone: "phone",
      status: "status",
      owner: "owner",
      source: "source",
      value: "value",
      currency: "currency",
      project: "projectId",
      followUp: "followUpDue",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
      wonAt: "wonAt",
      lostAt: "lostAt",
      lostReason: "lostReason",
      deleted: "isDeleted",
    },
    eventFields: { at: "at", type: "type", recordId: "leadId", text: "description", actor: "by" },
    ...(notes ? { noteFields: { at: "createdAt", text: "body", actor: "author" } } : {}),
    ...(meetings
      ? {
          meetingFields: {
            title: "title",
            start: "scheduledStart",
            end: "scheduledEnd",
            status: "status",
            organizer: "organizer",
            summary: "summary",
            actionItems: "actionItems",
            nextSteps: "nextSteps",
          },
        }
      : {}),
    eventKinds: {},
    noteEventTypes: notes ? ["NOTE_ADDED", "CALL_NOTE_ADDED"] : [],
    fromFormat: "date",
  });
}
