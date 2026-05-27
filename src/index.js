#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({
    name: 'relayer-mcp',
    version: '0.1.0',
});

// Register all 11 tools
require('./tools/checkPrerequisites')(server);
require('./tools/registerAccount')(server);
require('./tools/checkEmailVerified')(server);
require('./tools/installRelayer')(server);
require('./tools/checkRelayerHealth')(server);
require('./tools/startClaim')(server);
require('./tools/checkClaimStatus')(server);
require('./tools/getHostTags')(server);
require('./tools/configureVpd')(server);
require('./tools/verifyStorage')(server);
require('./tools/setupCliCredentials')(server);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    process.stderr.write(`relayer-mcp fatal: ${err.stack || err.message}\n`);
    process.exit(1);
});

module.exports = { server };
