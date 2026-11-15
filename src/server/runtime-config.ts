export function readinessResponse(state: {
  configurationValid: boolean;
  databaseAvailable: boolean;
  ownership: "unavailable" | "lost" | "ready";
  generation?: bigint;
}) {
  if (!state.configurationValid)
    return { ready: false as const, code: "configuration_invalid" as const };
  if (!state.databaseAvailable)
    return { ready: false as const, code: "database_unavailable" as const };
  if (state.ownership === "unavailable")
    return {
      ready: false as const,
      code: "writer_ownership_unavailable" as const,
    };
  if (state.ownership === "lost")
    return { ready: false as const, code: "writer_ownership_lost" as const };
  return { ready: true as const, generation: state.generation?.toString() };
}
