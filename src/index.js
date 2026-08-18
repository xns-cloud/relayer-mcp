#!/usr/bin/env node
'use strict';

// Node 20+ guard — runs BEFORE the SDK loads so users on older runtimes get a
// remediation message instead of a SyntaxError from a dependency.
const { checkNodeVersion } = require('./lib/nodeVersion');
const nodeCheck = checkNodeVersion(process.versions.node);
if (!nodeCheck.ok) {
    process.stderr.write(nodeCheck.message);
    process.exit(1);
}

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

// Name and version both derive from package.json so the runtime server, the npm
// package, and the registry card cannot drift apart (CONTRACT-1, E-A2 review).
// package.json mcpName is the immutable registry identity, pinned by
// registryIdentity.test.js.
const server = new McpServer({
    name: require('../package.json').mcpName,
    version: require('../package.json').version,
});

// Register all 15 tools
require('./tools/checkPrerequisites')(server);
require('./tools/startRegistration')(server);
require('./tools/checkEmailVerified')(server);
require('./tools/installRelayer')(server);
require('./tools/checkRelayerHealth')(server);
require('./tools/startClaim')(server);
require('./tools/checkClaimStatus')(server);
require('./tools/getHostTags')(server);
require('./tools/configureVpd')(server);
require('./tools/verifyStorage')(server);
require('./tools/setupCliCredentials')(server);
require('./tools/describeSettings')(server);
require('./tools/updateSettings')(server);
require('./tools/restartService')(server);
require('./tools/manageBackups')(server);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    process.stderr.write(`relayer-mcp fatal: ${err.stack || err.message}\n`);
    process.exit(1);
});

module.exports = { server };
