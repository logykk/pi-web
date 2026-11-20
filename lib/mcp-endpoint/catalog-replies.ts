import { type CatalogKind, type CatalogResult, type CatalogSection, type SectionOf } from "./catalog";
import type { ToolText } from "./jsonrpc";
import { BUDGETS, callExample, clip, oneLine, plural } from "./replies";

const NAMES_BUDGET = 1_500;
const ENTRY_BUDGET = 1_000;
const UNTRUSTED = "until the person trusts the folder in pi-web";

interface Summary {
  readonly line: string;
  readonly names: readonly string[];
}

interface Full {
  readonly head: readonly string[];
  readonly entries: readonly string[];
  readonly tail: readonly string[];
}

interface Renderer<K extends CatalogKind> {
  summary(section: SectionOf<K>): Summary;
  full(section: SectionOf<K>, cwd: string): Full;
}

function described(name: string, description: string | null): string {
  const text = description ? oneLine(description, 240) : "";
  return text ? `${name}: ${text}` : name;
}

function counts(parts: Readonly<Record<string, number>>): string {
  return Object.entries(parts).filter(([, count]) => count > 0).map(([noun, count]) => plural(count, noun)).join(", ") || "nothing loaded";
}

const RENDERERS: { readonly [K in CatalogKind]: Renderer<K> } = {
  models: {
    summary: (section) => ({
      line: `Models: ${section.models.length}${section.scoped ? " (enabledModels limits the list)" : ""}; default ${section.defaultModel ?? "none"}, thinking ${section.defaultThinkingLevel ?? "off"}.${section.error ? ` ${oneLine(section.error, 300)}` : ""}`,
      names: section.models.map((model) => model.ref),
    }),
    full: (section, cwd) => ({
      head: [
        `Models pi offers in ${cwd}: ${section.models.length}${section.scoped ? " (the enabledModels setting limits the list)" : ""}.`,
        `Default: ${section.defaultModel ?? "none"}, thinking ${section.defaultThinkingLevel ?? "off"}. pi_new_session takes model as provider/modelId, and starts on the default without one.`,
        ...section.warnings.map((warning) => `Warning: ${oneLine(warning, 300)}`),
        ...(section.error ? [`pi could not load every model: ${oneLine(section.error, 500)}`] : []),
      ],
      entries: section.models.map((model) =>
        `- ${model.ref} "${oneLine(model.name, 120)}" (${model.providerName})${model.ref === section.defaultModel ? ", the default" : ""}`),
      tail: [],
    }),
  },

  skills: {
    summary: (section) => ({
      line: `Skills: ${section.skills.length}${section.projectLoaded ? "" : ` (the folder's own are off ${UNTRUSTED})`}.`,
      names: section.skills.map((skill) => skill.name),
    }),
    full: (section, cwd) => ({
      head: [
        `Skills pi loads in ${cwd}: ${section.skills.length}.`,
        ...(section.projectLoaded ? [] : [`The folder's own skills are off ${UNTRUSTED}.`]),
      ],
      entries: section.skills.map((skill) => {
        const where = [skill.scope, skill.fromPackage].filter(Boolean).join(", ");
        const invoked = skill.modelInvocation ? "" : " (only by /skill:name; pi does not invoke it)";
        return `- ${described(`${skill.name}${where ? ` [${where}]` : ""}${invoked}`, skill.description)}`;
      }),
      tail: section.diagnostics > 0 ? [`${plural(section.diagnostics, "diagnostic")}: pi-web's Settings › Skills shows them.`] : [],
    }),
  },

  mcp: {
    summary: (section) => ({
      line: `MCP servers: ${section.servers.length}, ${section.servers.filter((server) => server.enabled).length} enabled.${section.unavailable ? ` pi-web's MCP is off: ${oneLine(section.unavailable, 300)}` : ""}`,
      names: section.servers.map((server) => server.name),
    }),
    full: (section, cwd) => ({
      head: [
        `MCP servers for ${cwd}: ${section.servers.length}, ${section.servers.filter((server) => server.enabled).length} enabled. Their settings and values are not shown.`,
        ...(section.unavailable ? [`pi-web's MCP is off: ${oneLine(section.unavailable, 500)}`] : []),
        ...(section.projectUntrusted && section.servers.some((server) => server.scope === "project")
          ? [`pi connects the project's servers only ${UNTRUSTED}.`] : []),
      ],
      entries: section.servers.map((server) => {
        const state = [
          server.enabled ? "enabled" : "disabled",
          ...(server.invalid ? ["invalid (Settings › MCP says why)"] : []),
          ...(server.transport ? [server.transport] : []),
          ...(server.exposure ? [`exposure ${server.exposure}`] : []),
          ...(server.relation === "replaced-by-project" ? ["the project's entry replaces it"] : []),
          ...(server.relation === "project-override" ? ["changes the global entry of its name"] : []),
        ].join(", ");
        return `- ${described(`${server.name} [${server.scope}] ${state}`, server.description)}`;
      }),
      tail: section.fileProblems.map((file) => `${file.path}: ${plural(file.count, "problem")}; pi-web's Settings › MCP shows them.`),
    }),
  },

  subagents: {
    summary: (section) => ({
      line: `Subagents: pi-web's Agent tool is ${section.enabled ? "on" : "off"}; ${plural(section.profiles.length, "profile")}, ${section.profiles.filter((profile) => profile.enabled).length} enabled.`,
      names: section.profiles.map((profile) => profile.name),
    }),
    full: (section, cwd) => ({
      head: [
        `Subagents in ${cwd}: pi-web's Agent tool is ${section.enabled ? "on" : "off (Settings › Agents turns it on)"}. ${plural(section.profiles.length, "profile")}, ${section.profiles.filter((profile) => profile.enabled).length} enabled:`,
        ...(section.projectLoaded ? [] : [`The folder's own profiles are off ${UNTRUSTED}.`]),
      ],
      entries: section.profiles.map((profile) =>
        `- ${described(`${profile.name} [${profile.scope}] ${profile.enabled ? "enabled" : "disabled"}`, profile.description)}`),
      tail: [],
    }),
  },

  plugins: {
    summary: (section) => ({
      line: `Plugins: ${plural(section.packages.length, "package")}, ${plural(section.extensions.length, "standalone extension")}${section.projectLoaded ? "" : ` (the folder's own are off ${UNTRUSTED})`}.`,
      names: [...section.packages.map((pkg) => pkg.source), ...section.extensions.map((extension) => extension.name)],
    }),
    full: (section, cwd) => ({
      head: [
        `pi packages in ${cwd}: ${section.packages.length}; standalone extensions: ${section.extensions.length}.`,
        ...(section.projectLoaded ? [] : [`The folder's own packages and extensions are off ${UNTRUSTED}.`]),
      ],
      entries: [
        ...section.packages.map((pkg) => {
          const version = pkg.version ? `, version ${pkg.version}` : "";
          return `- ${described(`${pkg.source} [${pkg.scope}] ${pkg.status}${version}: ${counts({ ...pkg.counts })}`, pkg.description)}`;
        }),
        ...section.extensions.map((extension) => `- extension ${extension.name} [${extension.scope}] ${extension.enabled ? "enabled" : "disabled"}`),
      ],
      tail: section.diagnostics > 0 ? [`${plural(section.diagnostics, "diagnostic")}: pi-web's Settings › Plugins shows them.`] : [],
    }),
  },
};

function rendererOf<K extends CatalogKind>(kind: K): Renderer<K> {
  return RENDERERS[kind];
}

function summaryOf(section: CatalogSection): Summary {
  return rendererOf(section.kind).summary(section as never);
}

function fullOf(section: CatalogSection, cwd: string): Full {
  return rendererOf(section.kind).full(section as never, cwd);
}

function nameList(names: readonly string[]): string {
  const shown: string[] = [];
  let size = 0;
  for (const name of names) {
    const item = oneLine(name, 160);
    if (size + item.length + 2 > NAMES_BUDGET) break;
    shown.push(item);
    size += item.length + 2;
  }
  const left = names.length - shown.length;
  return `${shown.join(", ")}${left > 0 ? `, and ${left} more` : ""}`;
}

/** Whole entries, as many as the budget holds, and how many were left out. */
function fitted({ head, entries, tail }: Full, budget: number): string {
  let size = [...head, ...tail].reduce((sum, line) => sum + line.length + 1, 0) + 100;
  const kept: string[] = [];
  for (const entry of entries) {
    const line = clip(entry, ENTRY_BUDGET);
    if (size + line.length + 1 > budget) break;
    kept.push(line);
    size += line.length + 1;
  }
  const left = entries.length - kept.length;
  return [...head, ...kept, ...(left > 0 ? [`(${left} more not shown: a reply holds ${budget} characters.)`] : []), ...tail].join("\n");
}

export function renderCatalog({ cwd, sections }: CatalogResult): ToolText {
  if (sections.length === 1) return { text: fitted(fullOf(sections[0], cwd), BUDGETS.read.total) };
  const lines = [`What pi has in ${cwd}:`];
  for (const section of sections) {
    const { line, names } = summaryOf(section);
    lines.push(line);
    if (names.length > 0) lines.push(`  ${nameList(names)}`);
    lines.push(`  In full: ${callExample("pi_catalog", { cwd, kind: section.kind })}`);
  }
  return { text: clip(lines.join("\n"), BUDGETS.report.total) };
}
