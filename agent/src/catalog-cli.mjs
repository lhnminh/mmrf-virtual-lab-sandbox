import { toolCatalog } from './tool-catalog.mjs';

const query = process.argv.slice(2).join(' ');
console.log(JSON.stringify(await toolCatalog.list({ query }), null, 2));
