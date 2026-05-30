'use strict';
// Driver: loads the real MCP tool handlers and calls them in onboarding order.
const { z } = require('zod');
const handlers = {};
const stub = { tool: (name, desc, shape, fn) => { handlers[name] = { shape, fn }; } };

// Register the tools we want to exercise.
require('./src/tools/checkPrerequisites')(stub, {});
require('./src/tools/installRelayer')(stub, {});
require('./src/tools/checkRelayerHealth')(stub, {});

async function call(name, args = {}) {
    const h = handlers[name];
    if (!h) throw new Error(`no tool ${name}`);
    const parsed = z.object(h.shape).parse(args);
    const res = await h.fn(parsed);
    const text = res.content[0].text;
    console.log(`\n=== ${name} ===`);
    console.log(text);
    return JSON.parse(text);
}

(async () => {
    const step = process.argv[2] || 'prereq';
    if (step === 'prereq') {
        await call('check_prerequisites');
    } else if (step === 'install') {
        await call('install_relayer', { install_path: '/home/xns/xns-relayer-mcp-test' });
    } else if (step === 'health') {
        await call('check_relayer_health');
    }
})().catch((e) => { console.error('DRIVER ERROR:', e.message); process.exit(1); });
