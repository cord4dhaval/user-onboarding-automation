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

  brandKits: "brand_kits",
  brandSources: "brand_sources",

  routines: "routines",
  routineRuns: "routine_runs",
  routineCalls: "routine_calls",

  events: "events",
  /** Cross-tenant structural priors. Carries no org, no angle, no person — see outcomes.ts. */
  outcomePriors: "outcome_priors",
  workQueue: "work_queue",
  suppressions: "suppressions",
  audit: "audit",
  notifications: "notifications",
  audiences: "audiences",

  oauthClients: "oauth_clients",
  oauthCodes: "oauth_codes",
  oauthTokens: "oauth_tokens",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
