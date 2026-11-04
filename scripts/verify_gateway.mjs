// Run after deployment: AGENTCORE_GATEWAY_URL=... node scripts/verify_gateway.mjs
import { createGatewayClient } from '../agent/src/gateway-client.mjs';

const call = createGatewayClient();
const result = await call('correlation_plot', {
  primaryVariable: 'overall survival',
  secondaryVariable: 'CGS risk category',
});
const counts = result.plot?.counts;
if (result.plot?.type !== 'survival' || !Array.isArray(counts)) {
  throw new Error('Gateway did not return a survival plot');
}
console.log(JSON.stringify({ summary: result.summary, counts, plotBytes: Buffer.byteLength(JSON.stringify(result.plot)) }, null, 2));
