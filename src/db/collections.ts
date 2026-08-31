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
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
