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

        // Store active SSE transports (for routing messages)
        this.transports = new Map();

        // Store valid OAuth access tokens (in-memory)
        // In production, use Redis or a database with TTL
        this.validTokens = new Set();

        // Store authorization codes for OAuth authorization code flow
        // In production, use Redis with short TTL (60 seconds)
        this.authCodes = new Map();

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

        // Parse JSON for all routes EXCEPT /mcp/message (which needs raw body for SSE)
        app.use((req, res, next) => {
            if (req.path === '/mcp/message') {
                next();
            } else {
                express.json()(req, res, next);
            }
        });

        // Request logging middleware
        app.use((req, res, next) => {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            next();
        });

        // Authentication middleware for MCP endpoints
        const authenticateMCP = (req, res, next) => {
            // Skip auth for health check, OAuth endpoints, and discovery endpoints
            if (req.path === '/health' ||
                req.path === '/' ||
                req.path.startsWith('/.well-known/') ||
                req.path === '/register' ||
                req.path.startsWith('/oauth/')) {
                return next();
            }

            // Check if OAuth is configured
            const oauthConfigured = process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET;

            if (!oauthConfigured) {
                console.error('[Auth] WARNING: OAuth not configured - server is UNSECURED!');
                console.error('[Auth] Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET to secure your server');
                return next();
            }

            // Validate OAuth Bearer token
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.error('[Auth] Missing or invalid Authorization header');
                return res.status(401).json({
                    error: 'unauthorized',
                    error_description: 'Bearer token required'
                });
            }

            const token = authHeader.substring(7); // Remove 'Bearer ' prefix

            // Validate token (check if it's in our valid tokens set)
            if (!this.validTokens || !this.validTokens.has(token)) {
                console.error('[Auth] Invalid or expired access token');
                return res.status(401).json({
                    error: 'invalid_token',
                    error_description: 'The access token is invalid or has expired'
                });
            }

            console.error('[Auth] OAuth authentication successful');
            next();
        };

        // Apply authentication to all MCP endpoints
        app.use(authenticateMCP);

        // OpenID Configuration (superset of OAuth authorization server metadata)
        app.get('/.well-known/openid-configuration', (req, res) => {
            console.error('[OAuth] OpenID configuration requested');
            const baseUrl = `https://${req.get('host')}`;
            res.json({
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['authorization_code', 'client_credentials'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp']
            });
        });

        // OAuth 2.0 Authorization Server Metadata (RFC 8414)
        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            console.error('[OAuth] Authorization server metadata requested');
            const baseUrl = `https://${req.get('host')}`;
            res.json({
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['authorization_code', 'client_credentials'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp']
            });
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp/sse requested');
            const baseUrl = `https://${req.get('host')}`;
            res.json({
                issuer: baseUrl,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['client_credentials'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                response_types_supported: ['token'],
                scopes_supported: ['mcp']
            });
        });

        // OAuth Protected Resource Metadata
        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            console.error('[OAuth] Protected resource metadata requested');
            const baseUrl = `https://${req.get('host')}`;
            res.json({
                resource: baseUrl,
                authorization_servers: [baseUrl],
                scopes_supported: ['mcp']
            });
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            const baseUrl = `https://${req.get('host')}`;
            res.json({
                resource: `${baseUrl}/mcp/sse`,
                authorization_servers: [baseUrl],
                scopes_supported: ['mcp']
            });
        });

        // OAuth Authorization Endpoint (Authorization Code Flow)
        app.get('/oauth/authorize', (req, res) => {
            console.error('[OAuth] Authorization request received');
            console.error('[OAuth] Query params:', JSON.stringify(req.query).substring(0, 200));

            const clientId = process.env.OAUTH_CLIENT_ID;
            const {
                response_type,
                client_id,
                redirect_uri,
                state,
                code_challenge,
                code_challenge_method,
                scope
            } = req.query;

            // Validate client_id
            if (client_id !== clientId) {
                console.error('[OAuth] Invalid client_id in authorize request');
                return res.status(400).send('Invalid client_id');
            }

            // Validate response_type
            if (response_type !== 'code') {
                console.error('[OAuth] Unsupported response_type:', response_type);
                return res.status(400).send('Unsupported response_type');
            }

            // Validate redirect_uri (must be Claude's callback)
            if (!redirect_uri || (!redirect_uri.includes('claude.ai') && !redirect_uri.includes('claude.com') && !redirect_uri.includes('localhost'))) {
                console.error('[OAuth] Invalid redirect_uri:', redirect_uri);
                return res.status(400).send('Invalid redirect_uri');
            }

            // Generate authorization code
            const authCode = Buffer.from(`${client_id}:${Date.now()}:${Math.random()}`).toString('base64');

            // Store auth code with PKCE challenge (in-memory - use Redis/DB in production)
            if (!this.authCodes) this.authCodes = new Map();
            this.authCodes.set(authCode, {
                client_id,
                redirect_uri,
                code_challenge,
                code_challenge_method,
                scope,
                created_at: Date.now()
            });

            console.error('[OAuth] Authorization code generated, redirecting to:', redirect_uri);

            // Redirect back to Claude with authorization code
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.append('code', authCode);
            if (state) redirectUrl.searchParams.append('state', state);

            res.redirect(redirectUrl.toString());
        });

        // OAuth Token Endpoint (supports both Authorization Code and Client Credentials flows)
        app.post('/oauth/token', (req, res) => {
            console.error('[OAuth] Token request received');

            const clientId = process.env.OAUTH_CLIENT_ID;
            const clientSecret = process.env.OAUTH_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
                console.error('[OAuth] OAuth not configured - missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET');
                return res.status(500).json({
                    error: 'server_error',
                    error_description: 'OAuth not configured on server'
                });
            }

            // Extract credentials from Authorization header (Basic Auth) or request body
            let reqClientId, reqClientSecret;

            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Basic ')) {
                const credentials = Buffer.from(authHeader.substring(6), 'base64').toString();
                [reqClientId, reqClientSecret] = credentials.split(':');
            } else {
                reqClientId = req.body?.client_id;
                reqClientSecret = req.body?.client_secret;
            }

            // Validate credentials
            if (reqClientId !== clientId || reqClientSecret !== clientSecret) {
                console.error('[OAuth] Invalid client credentials');
                return res.status(401).json({
                    error: 'invalid_client',
                    error_description: 'Invalid client credentials'
                });
            }

            const grantType = req.body?.grant_type;

            // Handle Authorization Code Grant (with PKCE)
            if (grantType === 'authorization_code') {
                const { code, redirect_uri, code_verifier } = req.body;

                console.error('[OAuth] Authorization code grant - validating code');

                // Validate authorization code
                if (!this.authCodes || !this.authCodes.has(code)) {
                    console.error('[OAuth] Invalid or expired authorization code');
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'Invalid or expired authorization code'
                    });
                }

                const authData = this.authCodes.get(code);

                // Validate PKCE code verifier
                if (authData.code_challenge) {
                    const crypto = await import('crypto');
                    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
                    if (hash !== authData.code_challenge) {
                        console.error('[OAuth] PKCE validation failed');
                        return res.status(400).json({
                            error: 'invalid_grant',
                            error_description: 'PKCE validation failed'
                        });
                    }
                }

                // Delete used auth code (one-time use)
                this.authCodes.delete(code);

                // Generate access token
                const accessToken = Buffer.from(`${reqClientId}:${Date.now()}:${Math.random()}`).toString('base64');
                this.validTokens.add(accessToken);

                console.error('[OAuth] Access token generated from authorization code');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope: authData.scope || 'mcp'
                });
            }

            // Handle Client Credentials Grant
            if (grantType === 'client_credentials') {
                // Generate access token
                const accessToken = Buffer.from(`${clientId}:${Date.now()}:${Math.random()}`).toString('base64');
                this.validTokens.add(accessToken);

                console.error('[OAuth] Access token generated via client credentials');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope: 'mcp'
                });
            }

            // Unsupported grant type
            console.error('[OAuth] Unsupported grant type:', grantType);
            res.status(400).json({
                error: 'unsupported_grant_type',
                error_description: 'Supported grant types: authorization_code, client_credentials'
            });
        });

        // Dynamic client registration endpoint (not supported)
        app.post('/register', (req, res) => {
            console.error('[OAuth] Client registration attempted - not supported');
            res.status(404).json({
                error: 'unsupported_operation',
                error_description: 'Dynamic client registration is not supported. Use static OAuth credentials.'
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

                const transport = new SSEServerTransport('/mcp/message', res);

                // Get session ID from transport
                const sessionId = transport.sessionId;
                console.error('[SSE] Session ID:', sessionId);

                // Store the transport for message routing
                this.transports.set(sessionId, transport);

                // Clean up on disconnect
                transport.onclose = () => {
                    console.error('[SSE] Connection closed, cleaning up session:', sessionId);
                    this.transports.delete(sessionId);
                };

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
            console.error('[SSE] Active transports:', this.transports.size);

            // Extract session ID from query or headers (body not parsed yet)
            const sessionId = req.query?.sessionId || req.headers['x-session-id'];
            console.error('[SSE] Session ID from request:', sessionId);

            if (sessionId && this.transports.has(sessionId)) {
                const transport = this.transports.get(sessionId);
                console.error('[SSE] Routing message to transport:', sessionId);
                // Let the transport handle the message
                transport.handlePostMessage(req, res);
            } else {
                // If no session ID or transport not found, try the first available transport
                // (for backwards compatibility with single-connection scenario)
                const firstTransport = Array.from(this.transports.values())[0];
                if (firstTransport) {
                    console.error('[SSE] No session ID, using first available transport');
                    firstTransport.handlePostMessage(req, res);
                } else {
                    console.error('[SSE] No active transport found');
                    res.status(404).json({ error: 'No active SSE connection found' });
                }
            }
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