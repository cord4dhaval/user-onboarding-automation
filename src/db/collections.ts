export const COLLECTIONS = {
  organizations: "organizations",
  users: "users",
  memberships: "memberships",
  products: "products",

  connections: "connections",
  credentials: "credentials",
  mcpBindings: "mcp_bindings",
  sources: "sources",
  channels: "channels",

  people: "people",
  goals: "goals",
  goalInstances: "goal_instances",
  plans: "plans",
  /** A plan with no person attached: the sequence for a segment, written once. */
  playbooks: "playbooks",
  actions: "actions",
  templates: "templates",
  /** Everything we can show a person that is not sentences. See schemas/asset.ts. */
  assets: "assets",

  brandKits: "brand_kits",
  brandSources: "brand_sources",

  routines: "routines",
  routineRuns: "routine_runs",
  routineCalls: "routine_calls",

  events: "events",
  /** Cross-tenant structural priors. Carries no org, no angle, no person — see outcomes.ts. */
  outcomePriors: "outcome_priors",
  /** What Maintain concluded from results across leads, shown on the next lead's card. See engine/rolling.ts. */
  learningNotes: "learning_notes",
  workQueue: "work_queue",
  suppressions: "suppressions",
  audit: "audit",
  notifications: "notifications",
  audiences: "audiences",

  /** One CRM record and who of ours it is, with a snapshot so nothing needs the CRM to answer. See engine/crm/sync.ts. */
  crmLinks: "crm_links",
  /** Everything the sales team's CRM logged on our people, kept here read-only. */
  crmActivity: "crm_activity",

  oauthClients: "oauth_clients",
  oauthCodes: "oauth_codes",
  oauthTokens: "oauth_tokens",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
