import { canonicalDirectory, ToolError } from "./desk";
import type { DirectoryLookup } from "./ports";

export const CATALOG_KINDS = ["models", "skills", "mcp", "subagents", "plugins"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export interface CatalogModel {
  /** `provider/modelId`, the form `pi_new_session` takes. */
  readonly ref: string;
  readonly name: string;
  readonly providerName: string;
}

export interface CatalogSkill {
  readonly name: string;
  readonly description: string;
  readonly scope: string | null;
  /** The package that brought it. */
  readonly fromPackage: string | null;
  readonly modelInvocation: boolean;
}

export interface CatalogMcpServer {
  readonly name: string;
  readonly scope: "global" | "project";
  readonly enabled: boolean;
  readonly invalid: boolean;
  readonly transport: string | null;
  readonly exposure: string | null;
  readonly description: string | null;
  /** A global entry the project's entry of its name replaces, or a project entry that only changes the global one. */
  readonly relation: "replaced-by-project" | "project-override" | null;
}

export interface CatalogProfile {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly enabled: boolean;
}

export interface CatalogPackage {
  readonly source: string;
  readonly scope: "global" | "project";
  readonly status: string;
  readonly version: string | null;
  readonly description: string | null;
  readonly counts: { readonly extensions: number; readonly skills: number; readonly prompts: number; readonly themes: number };
}

export interface CatalogExtension {
  readonly name: string;
  readonly scope: "global" | "project";
  readonly enabled: boolean;
}

/** Each variant holds only what a reply shows, narrowed from its source at the port. Never a secret. */
export type CatalogSection =
  | {
    readonly kind: "models";
    readonly models: readonly CatalogModel[];
    readonly defaultModel: string | null;
    readonly defaultThinkingLevel: string | null;
    readonly scoped: boolean;
    readonly warnings: readonly string[];
    readonly error: string | null;
  }
  | { readonly kind: "skills"; readonly skills: readonly CatalogSkill[]; readonly diagnostics: number; readonly projectLoaded: boolean }
  | {
    readonly kind: "mcp";
    readonly unavailable: string | null;
    readonly servers: readonly CatalogMcpServer[];
    /** pi connects the project file's servers only once the person trusts the folder. */
    readonly projectUntrusted: boolean;
    readonly fileProblems: readonly { readonly path: string; readonly count: number }[];
  }
  | { readonly kind: "subagents"; readonly enabled: boolean; readonly profiles: readonly CatalogProfile[]; readonly projectLoaded: boolean }
  | {
    readonly kind: "plugins";
    readonly packages: readonly CatalogPackage[];
    readonly extensions: readonly CatalogExtension[];
    readonly diagnostics: number;
    readonly projectLoaded: boolean;
  };

export type SectionOf<K extends CatalogKind> = Extract<CatalogSection, { readonly kind: K }>;

export type CatalogLoaders = { readonly [K in CatalogKind]: (cwd: string) => Promise<SectionOf<K>> };

export interface CatalogSource {
  directory(path: string): Promise<DirectoryLookup>;
  readonly load: CatalogLoaders;
}

/** A source refused the folder: its HTTP status (403: outside pi-web's roots) and its `error` text. */
export class CatalogSourceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface CatalogResult {
  readonly cwd: string;
  readonly sections: readonly CatalogSection[];
}

export async function readCatalog(source: CatalogSource, input: string, kind: CatalogKind | undefined): Promise<CatalogResult> {
  const cwd = await canonicalDirectory(source, input);
  const load = async (each: CatalogKind): Promise<CatalogSection> => {
    try {
      return await source.load[each](cwd);
    } catch (error) {
      if (!(error instanceof CatalogSourceError)) throw error;
      throw new ToolError(error.status === 403
        ? `${cwd} is outside the folders pi-web may read. A folder becomes known once a session or terminal uses it (pi_new_session, pi_terminal_open).`
        : `pi-web could not read the ${each} of ${cwd}: ${error.message}`);
    }
  };
  return { cwd, sections: await Promise.all((kind ? [kind] : CATALOG_KINDS).map(load)) };
}
