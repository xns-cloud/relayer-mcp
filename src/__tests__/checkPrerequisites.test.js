'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');

describe('check_prerequisites', () => {
    let server;
    let registeredTools;

    beforeEach(() => {
        server = {
            tool: jest.fn(),
        };
        registeredTools = {};
    });

    function registerWithOptions(opts) {
        const register = require('../tools/checkPrerequisites');
        register(server, opts);
        const [name, desc, schema, handler] = server.tool.mock.calls[0];
        registeredTools[name] = handler;
        return handler;
    }

    // TP-4: check_prerequisites registered with correct name
    test('registers tool with name check_prerequisites', () => {
        const register = require('../tools/checkPrerequisites');
        register(server);
        expect(server.tool).toHaveBeenCalledTimes(1);
        expect(server.tool.mock.calls[0][0]).toBe('check_prerequisites');
    });

    // TP-5: all checks pass → success: true
    test('returns success when all prerequisites pass', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(true);
        expect(parsed.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'docker', passed: true }),
                expect.objectContaining({ name: 'port_8888', passed: true }),
                expect.objectContaining({ name: 'port_9000', passed: true }),
            ]),
        );
    });

    // TP-6: Docker missing → failure + remediation (AC-4)
    test('reports Docker failure with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockRejectedValue(new Error('not found')),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const dockerCheck = parsed.checks.find((c) => c.name === 'docker');
        expect(dockerCheck.passed).toBe(false);
        expect(dockerCheck.remediation).toBeDefined();
        expect(dockerCheck.remediation).toContain('Install Docker');
    });

    // TP-7: port in use → failure + remediation (AC-4)
    test('reports port 8888 in use with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockImplementation(async (port) => {
                return port !== 8888;
            }),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const portCheck = parsed.checks.find((c) => c.name === 'port_8888');
        expect(portCheck.passed).toBe(false);
        expect(portCheck.remediation).toContain('Port 8888');
    });

    // TP-8: connectivity failure → remediation (AC-4)
    test('reports connectivity failure with remediation hint', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
            },
            httpClient: {
                get: jest.fn().mockRejectedValue(new Error('ENOTFOUND')),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.success).toBe(false);
        const consoleCheck = parsed.checks.find((c) => c.name === 'connectivity_console');
        expect(consoleCheck.passed).toBe(false);
        expect(consoleCheck.remediation).toContain('HTTPS');
    });

    // AC-3: plain English descriptions
    test('all checks have human-readable detail strings', async () => {
        const handler = registerWithOptions({
            dockerUtil: {
                docker: jest.fn().mockResolvedValue({ stdout: '24.0.0', stderr: '' }),
            },
            httpClient: {
                get: jest.fn().mockResolvedValue({ status: 200, data: {} }),
                post: jest.fn(),
            },
            checkPort: jest.fn().mockResolvedValue(true),
        });

        const result = await handler({});
        const parsed = JSON.parse(result.content[0].text);

        for (const check of parsed.checks) {
            expect(typeof check.detail).toBe('string');
            expect(check.detail.length).toBeGreaterThan(0);
        }
    });
});
