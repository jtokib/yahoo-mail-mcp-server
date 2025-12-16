#!/usr/bin/env node

/**
 * Yahoo Mail MCP Server with OAuth2 - A beginner-friendly introduction to MCP
 * This server provides read-only access to Yahoo Mail via OAuth2 and IMAP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file (for local development)
dotenv.config();

class YahooMailMCPServer {
    constructor() {
        this.server = new Server(
            {
                name: 'yahoo-mail-mcp',
                version: '1.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        // OAuth2 credentials - these would typically come from Yahoo Developer Console
        this.clientId = process.env.YAHOO_CLIENT_ID;
        this.clientSecret = process.env.YAHOO_CLIENT_SECRET;
        this.redirectUri = 'http://localhost:8080/callback';

        // Store tokens (in production, you'd use persistent storage)
        this.accessToken = null;
        this.refreshToken = null;

        this.setupToolHandlers();
        this.setupErrorHandling();
    }

    /**
     * Setup MCP tool handlers
     */
    setupToolHandlers() {
        // Handle tool listing
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'list_emails',
                        description: 'List recent emails from Yahoo Mail inbox',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                count: {
                                    type: 'number',
                                    description: 'Number of emails to retrieve (default: 10, max: 50)',
                                    default: 10
                                }
                            }
                        }
                    },
                    {
                        name: 'read_email',
                        description: 'Read the content of a specific email by its sequence number',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                sequenceNumber: {
                                    type: 'number',
                                    description: 'The sequence number of the email to read'
                                }
                            },
                            required: ['sequenceNumber']
                        }
                    },
                    {
                        name: 'search_emails',
                        description: 'Search emails by subject or sender',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Search term for subject or sender'
                                },
                                count: {
                                    type: 'number',
                                    description: 'Number of results to return (default: 10)',
                                    default: 10
                                }
                            },
                            required: ['query']
                        }
                    }
                ]
            };
        });

        // Handle tool execution
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'list_emails':
                        return await this.listEmails(args?.count || 10);

                    case 'read_email':
                        return await this.readEmail(args.sequenceNumber);

                    case 'search_emails':
                        return await this.searchEmails(args.query, args?.count || 10);

                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error.message}`
                        }
                    ]
                };
            }
        });
    }

    /**
     * Start OAuth2 flow
     */
    async startOAuthFlow() {
        if (!this.clientId || !this.clientSecret) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `🔐 OAuth2 Setup Required!\n\nTo use Yahoo Mail OAuth2, you need to:\n\n1. Go to https://developer.yahoo.com/apps/\n2. Create a new app\n3. Set redirect URI to: ${this.redirectUri}\n4. Get your Client ID and Client Secret\n5. Set environment variables:\n   YAHOO_CLIENT_ID=your_client_id\n   YAHOO_CLIENT_SECRET=your_client_secret\n\nFor now, let's use a simpler approach with Gmail API or enable IMAP in Yahoo Mail settings.`
                    }
                ]
            };
        }

        const authUrl = `https://api.login.yahoo.com/oauth2/request_auth?` +
            `client_id=${this.clientId}&` +
            `redirect_uri=${encodeURIComponent(this.redirectUri)}&` +
            `response_type=code&` +
            `scope=mail-r`;

        return {
            content: [
                {
                    type: 'text',
                    text: `🔐 Yahoo Mail OAuth2 Login\n\n1. Open this URL in your browser:\n${authUrl}\n\n2. Authorize the app\n3. Copy the authorization code from the callback URL\n4. Use the 'oauth_callback' tool with the code`
                }
            ]
        };
    }

    /**
     * Create IMAP connection using app-specific password (like the working test script)
     */
    async createImapConnection() {
        return new Promise((resolve, reject) => {
            // Log environment check (without exposing credentials)
            console.error('[IMAP] Attempting connection...');
            console.error('[IMAP] Email configured:', !!process.env.YAHOO_EMAIL);
            console.error('[IMAP] Password configured:', !!process.env.YAHOO_APP_PASSWORD);
            console.error('[IMAP] Email value:', process.env.YAHOO_EMAIL ? process.env.YAHOO_EMAIL.substring(0, 3) + '***' : 'undefined');

            if (!process.env.YAHOO_EMAIL || !process.env.YAHOO_APP_PASSWORD) {
                const error = new Error('YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variables are not set');
                console.error('[IMAP] Configuration error:', error.message);
                reject(error);
                return;
            }

            const imap = new Imap({
                user: process.env.YAHOO_EMAIL,
                password: process.env.YAHOO_APP_PASSWORD,
                host: 'imap.mail.yahoo.com',
                port: 993,
                tls: true,
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: true,  // Changed to true for production
                    servername: 'imap.mail.yahoo.com',
                    minVersion: 'TLSv1.2'
                },
                debug: console.error  // Enable IMAP debug logging
            });

            imap.once('ready', () => {
                console.error('[IMAP] Connection successful');
                resolve(imap);
            });

            imap.once('error', (err) => {
                console.error('[IMAP] Connection error:', err.message);
                console.error('[IMAP] Error details:', JSON.stringify(err, null, 2));
                reject(err);
            });

            imap.once('end', () => {
                console.error('[IMAP] Connection ended');
            });

            console.error('[IMAP] Initiating connection to imap.mail.yahoo.com:993');
            imap.connect();
        });
    }

    /**
     * List recent emails
     */
    async listEmails(count = 10) {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox('INBOX', true, (err, box) => {
                if (err) {
                    reject(err);
                    return;
                }

                // Get the most recent emails
                const total = box.messages.total;
                const start = Math.max(1, total - count + 1);
                const end = total;

                if (total === 0) {
                    imap.end();
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: `📧 No emails found in your inbox`
                            }
                        ]
                    });
                    return;
                }

                const fetch = imap.seq.fetch(`${start}:${end}`, {
                    bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                    struct: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    let header = '';

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            header += chunk.toString('ascii');
                        });
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(header);
                        emails.push({
                            sequenceNumber: seqno,
                            from: parsed.from?.[0] || 'Unknown',
                            subject: parsed.subject?.[0] || 'No Subject',
                            date: parsed.date?.[0] || 'Unknown Date'
                        });
                    });
                });

                fetch.once('error', reject);

                fetch.once('end', () => {
                    imap.end();

                    // Sort by sequence number (newest first)
                    emails.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

                    const emailList = emails.map(email =>
                        `📧 [${email.sequenceNumber}] From: ${email.from}\n` +
                        `   Subject: ${email.subject}\n` +
                        `   Date: ${email.date}\n`
                    ).join('\n');

                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: `📧 Recent ${emails.length} emails from your Yahoo Mail inbox:\n\n${emailList}\n\nUse read_email with a sequence number to read the full content.`
                            }
                        ]
                    });
                });
            });
        });
    }

    /**
     * Read a specific email by sequence number
     */
    async readEmail(sequenceNumber) {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox('INBOX', true, (err, box) => {
                if (err) {
                    reject(err);
                    return;
                }

                const fetch = imap.seq.fetch(sequenceNumber, { bodies: '' });

                fetch.on('message', (msg, seqno) => {
                    let buffer = '';

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('ascii');
                        });
                    });

                    msg.once('end', () => {
                        simpleParser(buffer, (err, parsed) => {
                            if (err) {
                                reject(err);
                                return;
                            }

                            const emailContent =
                                `📧 Email #${sequenceNumber}\n\n` +
                                `From: ${parsed.from?.text || 'Unknown'}\n` +
                                `To: ${parsed.to?.text || 'Unknown'}\n` +
                                `Subject: ${parsed.subject || 'No Subject'}\n` +
                                `Date: ${parsed.date || 'Unknown Date'}\n\n` +
                                `--- Content ---\n` +
                                `${parsed.text || parsed.html || 'No content available'}`;

                            imap.end();
                            resolve({
                                content: [
                                    {
                                        type: 'text',
                                        text: emailContent
                                    }
                                ]
                            });
                        });
                    });
                });

                fetch.once('error', reject);
            });
        });
    }

    /**
     * Search emails by subject or sender
     */
    async searchEmails(query, count = 10) {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox('INBOX', true, (err, box) => {
                if (err) {
                    reject(err);
                    return;
                }

                // Search for emails with query in subject or from field
                imap.search([
                    ['OR',
                        ['HEADER', 'SUBJECT', query],
                        ['HEADER', 'FROM', query]
                    ]
                ], (err, results) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: `🔍 No emails found matching "${query}"`
                                }
                            ]
                        });
                        return;
                    }

                    // Get the most recent results
                    const limitedResults = results.slice(-count);

                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                        struct: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        let header = '';

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                header += chunk.toString('ascii');
                            });
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(header);
                            emails.push({
                                sequenceNumber: seqno,
                                from: parsed.from?.[0] || 'Unknown',
                                subject: parsed.subject?.[0] || 'No Subject',
                                date: parsed.date?.[0] || 'Unknown Date'
                            });
                        });
                    });

                    fetch.once('error', reject);

                    fetch.once('end', () => {
                        imap.end();

                        const emailList = emails.map(email =>
                            `📧 [${email.sequenceNumber}] From: ${email.from}\n` +
                            `   Subject: ${email.subject}\n` +
                            `   Date: ${email.date}\n`
                        ).join('\n');

                        resolve({
                            content: [
                                {
                                    type: 'text',
                                    text: `🔍 Found ${emails.length} emails matching "${query}":\n\n${emailList}`
                                }
                            ]
                        });
                    });
                });
            });
        });
    }

    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error);
        };

        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    async run() {
        // Check if we should use SSE (HTTP) or stdio transport
        const transportMode = process.env.TRANSPORT_MODE || 'stdio';

        if (transportMode === 'sse') {
            await this.runSSE();
        } else {
            await this.runStdio();
        }
    }

    async runStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Yahoo Mail MCP server running on stdio');
    }

    async runSSE() {
        const app = express();
        const port = process.env.PORT || 3000;

        // Log startup configuration
        console.error('[Server] Starting in SSE mode');
        console.error('[Server] Port:', port);
        console.error('[Server] Node version:', process.version);
        console.error('[Server] Environment:', process.env.NODE_ENV || 'development');
        console.error('[Server] Email configured:', !!process.env.YAHOO_EMAIL);
        console.error('[Server] Password configured:', !!process.env.YAHOO_APP_PASSWORD);

        // Enable CORS for Claude.ai and remote MCP connections
        app.use(cors({
            origin: true,  // Allow all origins (Render's proxy may modify origin headers)
            credentials: true,
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
            exposedHeaders: ['Content-Type'],
            maxAge: 86400  // Cache preflight for 24 hours
        }));

        app.use(express.json());

        // Request logging middleware
        app.use((req, res, next) => {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            next();
        });

        // OAuth discovery endpoints for MCP (authless server)
        // These endpoints are queried by Claude Desktop to discover OAuth capabilities

        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            console.error('[OAuth] Authorization server metadata requested');
            res.status(404).json({
                error: 'not_supported',
                error_description: 'This server does not support OAuth authentication'
            });
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp/sse requested');
            res.status(404).json({
                error: 'not_supported',
                error_description: 'This server does not support OAuth authentication'
            });
        });

        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            console.error('[OAuth] Protected resource metadata requested');
            res.status(404).json({
                error: 'not_supported',
                error_description: 'This server does not support OAuth authentication'
            });
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            res.status(404).json({
                error: 'not_supported',
                error_description: 'This server does not support OAuth authentication'
            });
        });

        // Dynamic client registration endpoint (not supported)
        app.post('/register', (req, res) => {
            console.error('[OAuth] Client registration attempted');
            res.status(404).json({
                error: 'not_supported',
                error_description: 'This server does not support dynamic client registration'
            });
        });

        // Health check endpoint (enhanced with environment info)
        app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                service: 'yahoo-mail-mcp',
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    emailConfigured: !!process.env.YAHOO_EMAIL,
                    passwordConfigured: !!process.env.YAHOO_APP_PASSWORD,
                    transportMode: process.env.TRANSPORT_MODE || 'stdio'
                }
            });
        });

        // SSE endpoint for MCP
        app.get('/mcp/sse', async (req, res) => {
            try {
                console.error('[SSE] New connection established from:', req.ip);
                console.error('[SSE] Origin:', req.headers.origin);
                console.error('[SSE] User-Agent:', req.headers['user-agent']);

                // Set SSE-specific headers
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const transport = new SSEServerTransport('/mcp/message', res);
                await this.server.connect(transport);
                console.error('[SSE] MCP server connected to transport');
            } catch (error) {
                console.error('[SSE] Error connecting transport:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // Message endpoint for SSE
        app.post('/mcp/message', async (req, res) => {
            console.error('[SSE] Received message on /mcp/message');
            console.error('[SSE] Message body:', JSON.stringify(req.body).substring(0, 200));
            // The SSEServerTransport handles this internally
            res.status(200).end();
        });

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('[Express] Error:', err);
            res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        });

        // Root endpoint
        app.get('/', (req, res) => {
            res.json({
                name: 'Yahoo Mail MCP Server',
                version: '1.0.0',
                description: 'MCP server for Yahoo Mail access via IMAP',
                endpoints: {
                    health: '/health',
                    sse: '/mcp/sse',
                    message: '/mcp/message'
                },
                tools: [
                    'list_emails',
                    'read_email',
                    'search_emails'
                ]
            });
        });

        app.listen(port, () => {
            console.error(`Yahoo Mail MCP server running on port ${port}`);
            console.error(`SSE endpoint: http://localhost:${port}/mcp/sse`);
            console.error(`Health check: http://localhost:${port}/health`);
        });
    }
}

// Start the server
const server = new YahooMailMCPServer();
server.run().catch(console.error);