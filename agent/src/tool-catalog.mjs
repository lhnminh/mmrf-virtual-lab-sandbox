import { registeredTools } from './tools/index.mjs';
import { KNOWLEDGE_GRAPH_APP, knowledgeGraphRegistrations } from './knowledge-graph.mjs';

// Snapshot of the pinned frontend's analysisTools.json. An app is a website
// area, not an agent capability until at least one tool is registered below.
export const WEBSITE_APPS = Object.freeze([
  { id: 'Projects', title: 'Projects', section: 'Core Tools' },
  { id: 'CohortBuilder', title: 'Cohort Builder', section: 'Core Tools' },
  { id: 'Repository', title: 'Repository', section: 'Core Tools' },
  { id: 'MutationFrequency', title: 'Mutation Frequency', section: 'Analysis Tools' },
  { id: 'cDave', title: 'Clinical Data Analysis', section: 'Analysis Tools' },
  { id: 'CohortComparison', title: 'Cohort Comparison', section: 'Analysis Tools' },
  { id: 'Correlation', title: 'Correlation Plot', section: 'Analysis Tools' },
  { id: 'GB', title: 'Genome Browser', section: 'Analysis Tools' },
  { id: 'ProteinPaint', title: 'ProteinPaint', section: 'Analysis Tools' },
  { id: 'OncoMatrix', title: 'OncoMatrix', section: 'Analysis Tools' },
  { id: 'GeneExpression', title: 'Gene Expression Clustering', section: 'Analysis Tools' },
  { id: 'DE', title: 'Differential Gene Expression', section: 'Analysis Tools' },
  { id: 'SC', title: 'Single Cell RNA-seq', section: 'Analysis Tools' },
  { id: 'Umap', title: 'Bulk RNA-seq UMAP', section: 'Analysis Tools' },
  { id: 'SetOperations', title: 'Set Operations', section: 'Analysis Tools' },
]);

const REGISTERED_TOOLS = registeredTools.map(item => ({
  appId: item.appId,
  spec: item.spec,
  create: ({ toolFactory, executors, context, calls }) => item.createTool({
    toolFactory, execute: executors[item.spec.name], context, calls,
  }),
}));

export function createToolCatalog({ apps = WEBSITE_APPS, registrations = REGISTERED_TOOLS } = {}) {
  const appIds = new Set();
  for (const app of apps) {
    if (!app.id || !app.title || appIds.has(app.id)) throw new Error(`Invalid or duplicate app ID: ${app.id}`);
    appIds.add(app.id);
  }
  const toolNames = new Set();
  for (const registration of registrations) {
    const name = registration.spec?.name;
    if (!appIds.has(registration.appId)) throw new Error(`Tool ${name} refers to unknown app ${registration.appId}`);
    if (!name || toolNames.has(name) || typeof registration.create !== 'function') {
      throw new Error(`Invalid or duplicate tool registration: ${name}`);
    }
    toolNames.add(name);
  }

  function list({ query = '' } = {}) {
    const term = query.trim().toLowerCase();
    return apps.map(app => {
      const tools = registrations.filter(item => item.appId === app.id).map(item => ({
        name: item.spec.name,
        description: item.spec.description,
        inputSchema: item.spec.inputSchema,
      }));
      return { ...app, registered: tools.length > 0, tools };
    }).filter(app => !term || [app.id, app.title, app.section, ...app.tools.flatMap(tool => [tool.name, tool.description])]
      .some(value => value.toLowerCase().includes(term)));
  }

  function createTools({ toolFactory, executors, context, calls }) {
    return registrations.map(item => {
      const created = item.create({ toolFactory, executors, context, calls });
      if (created.name !== item.spec.name) throw new Error(`Tool registration mismatch: ${item.spec.name}`);
      return created;
    });
  }

  return { list, createTools };
}

export const toolCatalog = createToolCatalog(process.env.KG_GATEWAY_URL ? {
  apps: [...WEBSITE_APPS, KNOWLEDGE_GRAPH_APP],
  registrations: [...REGISTERED_TOOLS, ...knowledgeGraphRegistrations()],
} : {});
