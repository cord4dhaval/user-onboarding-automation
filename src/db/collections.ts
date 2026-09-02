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
  actions: "actions",
  templates: "templates",

  brandKits: "brand_kits",
  brandSources: "brand_sources",

  routines: "routines",
  routineRuns: "routine_runs",
  routineCalls: "routine_calls",

  events: "events",
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
