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

  events: "events",
  workQueue: "work_queue",
  suppressions: "suppressions",
  audit: "audit",
  notifications: "notifications",

  oauthClients: "oauth_clients",
  oauthCodes: "oauth_codes",
  oauthTokens: "oauth_tokens",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
