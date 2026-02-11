export { createTeamdClient } from "./teamd-client.js";
export { registerTeamCoordinationExtension as extensionEntrypoint } from "./team-coordination.js";
export { registerTeamCoordinationExtension } from "./team-coordination.js";
export type {
  ExtensionAPILike,
  ExtensionContextLike,
  TeamCoordinationOptions,
  ToolCallEventLike,
} from "./team-coordination.js";

export { registerTeamCoordinationExtension as default } from "./team-coordination.js";
