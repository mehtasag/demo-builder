export * from "./generated/api";
export * from "./generated/types";

/**
 * `GetVideoParams` is generated twice now that /videos/{id} takes a query
 * parameter: as a zod schema for the *path* params in `generated/api`, and as a
 * TypeScript type for the *query* params in `generated/types`. An explicit
 * re-export resolves the ambiguity between the two `export *` above.
 *
 * This package exists to give the server runtime validators, so the zod schema
 * wins. Consumers wanting the query-param type should import it from
 * `@workspace/api-client-react`, which is where requests are built.
 */
export { GetVideoParams } from "./generated/api";
