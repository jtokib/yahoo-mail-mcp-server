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
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
                version: '3.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

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
                        description: 'List recent emails from a Yahoo Mail folder. Returns UIDs (permanent identifiers) and enriched metadata including size, flags, and attachment status.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                count: {
                                    type: 'number',
                                    description: 'Number of emails to retrieve (default: 10, max: 50)',
                                    default: 10
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to list emails from (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                offset: {
                                    type: 'number',
                                    description: 'Number of emails to skip (for pagination, default: 0)',
                                    default: 0
                                }
                            }
                        }
                    },
                    {
                        name: 'read_email',
                        description: 'Read email content using UIDs (permanent identifiers). UIDs don\'t change when emails are deleted. Get UIDs from list_emails or search_emails.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to read. UIDs are permanent identifiers from list_emails.',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                maxChars: {
                                    type: 'number',
                                    description: 'Maximum characters of body text returned per email (default: 20000, 0 for unlimited). Long newsletters are truncated with a marker so a single read cannot exhaust the context budget.',
                                    default: 20000
                                },
                                format: {
                                    type: 'string',
                                    enum: ['full', 'summary', 'headers'],
                                    description: 'full = headers plus body (default); summary = headers plus the first 500 characters; headers = metadata only, no body.',
                                    default: 'full'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'search_emails',
                        description: 'Search emails using UIDs with advanced filters. Returns UIDs which are permanent identifiers that don\'t change when emails are deleted. Get UIDs from results for subsequent operations.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Search term for subject or sender (can be empty for date-only searches)',
                                    default: ''
                                },
                                count: {
                                    type: 'number',
                                    description: 'Number of results to return (default: 10, max: 50)',
                                    default: 10
                                },
                                dateFrom: {
                                    type: 'string',
                                    description: 'Filter emails from this date onwards (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                dateTo: {
                                    type: 'string',
                                    description: 'Filter emails up to this date (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                sender: {
                                    type: 'string',
                                    description: 'Filter by specific sender email address or name',
                                    default: null
                                },
                                unreadOnly: {
                                    type: 'boolean',
                                    description: 'Only return unread emails (default: false)',
                                    default: false
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to search in (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                folders: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Search several folders in one call, for example ["INBOX","_Tax","_Trust","_Work Expense"]. Overrides "folder". Each result carries the folder it came from.'
                                },
                                bodyQuery: {
                                    type: 'string',
                                    description: 'Search the full message text (body as well as headers) for this term, using the IMAP TEXT criterion.',
                                    default: null
                                },
                                flaggedOnly: {
                                    type: 'boolean',
                                    description: 'Only return flagged (starred) emails.',
                                    default: false
                                },
                                unansweredOnly: {
                                    type: 'boolean',
                                    description: 'Only return emails without the \\Answered flag - the standing signal for mail from priority senders that still needs a reply.',
                                    default: false
                                },
                                hasAttachment: {
                                    type: 'boolean',
                                    description: 'Only return emails carrying an attachment. IMAP has no attachment criterion, so this is applied AFTER the search, over the most recent scanLimit results. The response always reports scanned, totalMatches and complete - check complete before treating the result as exhaustive.',
                                    default: false
                                },
                                scanLimit: {
                                    type: 'number',
                                    description: 'How many of the most recent matches to inspect when hasAttachment is set (default: 200). Raise it to widen coverage at the cost of speed, or narrow the search with dateFrom/sender/folder instead, which is exact.',
                                    default: 200
                                }
                            },
                            required: []
                        }
                    },
                    {
                        name: 'delete_emails',
                        description: 'Move emails to Trash folder using UIDs (soft delete, recoverable). UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to delete',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'archive_emails',
                        description: 'Move emails to Archive folder using UIDs for long-term storage. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to archive',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_read',
                        description: 'Mark emails as read using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as read',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_unread',
                        description: 'Mark emails as unread using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as unread',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'flag_emails',
                        description: 'Flag emails as important/starred using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to flag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'unflag_emails',
                        description: 'Remove flag/star from emails using UIDs. UIDs are permanent identifiers.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to unflag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'move_emails',
                        description: 'Move emails to a specified folder using UIDs. UIDs are permanent identifiers. Use list_folders to see available folders.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to move',
                                    minItems: 1
                                },
                                folderName: {
                                    type: 'string',
                                    description: 'Name of the destination folder (e.g., "Work", "Personal"). Use list_folders to see available folders.'
                                },
                                sourceFolder: {
                                    type: 'string',
                                    description: 'Source folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids', 'folderName']
                        }
                    },
                    {
                        name: 'list_folders',
                        description: 'List all available IMAP folders/mailboxes in your Yahoo Mail account',
                        inputSchema: {
                            type: 'object',
                            properties: {}
                        }
                    },
                    {
                        name: 'list_attachments',
                        description: 'List the attachments on one or more emails: filename, MIME type, size, and whether the part is inline. Use this to judge whether a message is a genuine receipt or invoice before acting on it - read_email only reports a yes/no flag.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to inspect.',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'save_attachment',
                        description: 'Save one or all attachments from an email to disk and return the absolute paths. Defaults to the YAHOO_ATTACHMENT_DIR directory, or ~/Downloads.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: {
                                    type: 'number',
                                    description: 'UID of the email holding the attachment.'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                filename: {
                                    type: 'string',
                                    description: 'Save only the attachment with this filename. Omit to use index, or set all=true.',
                                    default: null
                                },
                                index: {
                                    type: 'number',
                                    description: 'Save only the attachment at this zero-based index (order as returned by list_attachments).',
                                    default: null
                                },
                                all: {
                                    type: 'boolean',
                                    description: 'Save every attachment on the message (default: false).',
                                    default: false
                                },
                                outputDir: {
                                    type: 'string',
                                    description: 'Directory to write into. Defaults to YAHOO_ATTACHMENT_DIR or ~/Downloads.',
                                    default: null
                                }
                            },
                            required: ['uid']
                        }
                    },
                    {
                        name: 'send_email',
                        description: 'Send a new email from the connected Yahoo account over SMTP. SAFETY: without confirm=true this sends nothing and returns a preview of exactly what would go out. Call once to preview, show the preview to the user, then call again with confirm=true.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                to: {
                                    type: 'string',
                                    description: 'Recipient address, or several separated by commas.'
                                },
                                subject: { type: 'string', description: 'Subject line.' },
                                body: { type: 'string', description: 'Plain text body.' },
                                html: { type: 'string', description: 'Optional HTML body.', default: null },
                                cc: { type: 'string', description: 'Optional CC recipients, comma separated.', default: null },
                                bcc: { type: 'string', description: 'Optional BCC recipients, comma separated.', default: null },
                                confirm: {
                                    type: 'boolean',
                                    description: 'Must be true to actually send. False or absent returns a preview only.',
                                    default: false
                                },
                                saveToSent: {
                                    type: 'boolean',
                                    description: 'Append a copy to the Sent folder over IMAP (default: true). Yahoo does not do this automatically for SMTP submissions.',
                                    default: true
                                }
                            },
                            required: ['to', 'subject', 'body']
                        }
                    },
                    {
                        name: 'forward_email',
                        description: 'Forward an existing email, attachments preserved, to another address. Built for receipt routing: forward a receipt that landed in Yahoo to an expense inbox without leaving the tool. SAFETY: without confirm=true nothing is sent and a preview is returned, listing every attachment that would travel with it.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: { type: 'number', description: 'UID of the email to forward.' },
                                to: { type: 'string', description: 'Recipient address, or several separated by commas.' },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                note: {
                                    type: 'string',
                                    description: 'Optional text placed above the forwarded message.',
                                    default: ''
                                },
                                mode: {
                                    type: 'string',
                                    enum: ['attachments', 'eml'],
                                    description: 'attachments (default) re-attaches each original attachment and inlines the original text. eml attaches the whole original message as a .eml file, which preserves it byte for byte.',
                                    default: 'attachments'
                                },
                                confirm: {
                                    type: 'boolean',
                                    description: 'Must be true to actually send. False or absent returns a preview only.',
                                    default: false
                                },
                                saveToSent: { type: 'boolean', description: 'Append a copy to the Sent folder (default: true).', default: true }
                            },
                            required: ['uid', 'to']
                        }
                    },
                    {
                        name: 'reply_to_email',
                        description: 'Reply to an email, threading correctly via In-Reply-To and References, and setting the \\Answered flag on the original so unansweredOnly searches stay accurate. SAFETY: without confirm=true nothing is sent and a preview is returned.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: { type: 'number', description: 'UID of the email to reply to.' },
                                body: { type: 'string', description: 'Plain text reply body.' },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                replyAll: {
                                    type: 'boolean',
                                    description: 'Include the original To and Cc recipients (default: false).',
                                    default: false
                                },
                                quoteOriginal: {
                                    type: 'boolean',
                                    description: 'Append the quoted original message below the reply (default: true).',
                                    default: true
                                },
                                confirm: {
                                    type: 'boolean',
                                    description: 'Must be true to actually send. False or absent returns a preview only.',
                                    default: false
                                },
                                saveToSent: { type: 'boolean', description: 'Append a copy to the Sent folder (default: true).', default: true }
                            },
                            required: ['uid', 'body']
                        }
                    },
                    {
                        name: 'move_by_search',
                        description: 'Find every message matching a search and move it to a folder in one call - the bulk filing operation the Yahoo web client cannot express. Runs on a single IMAP connection with batched, range-compressed UID sets, so thousands of messages cost a handful of commands rather than one per message. SAFETY: without confirm=true nothing moves and a dry run is returned, reporting how many matched, the date span, and a sample. At least one search criterion is required, so a bare call cannot empty a folder. Moving out of a capped mailbox uncovers older messages as it frees room at the cap, so repeat the call until it reports nothing to move.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                destinationFolder: {
                                    type: 'string',
                                    description: 'Folder to move the messages into. Must already exist - use list_folders to check.'
                                },
                                sourceFolder: {
                                    type: 'string',
                                    description: 'Folder to move them out of (default: INBOX)',
                                    default: 'INBOX'
                                },
                                sender: { type: 'string', description: 'Match this sender address or name.', default: null },
                                query: { type: 'string', description: 'Match this term in the subject or the sender.', default: null },
                                bodyQuery: { type: 'string', description: 'Match this term anywhere in the message text.', default: null },
                                dateFrom: { type: 'string', description: 'Only messages on or after this date.', default: null },
                                dateTo: { type: 'string', description: 'Only messages before this date. Pair with nothing else to sweep everything older than a cutoff.', default: null },
                                unreadOnly: { type: 'boolean', description: 'Only unread messages.', default: false },
                                unansweredOnly: { type: 'boolean', description: 'Only messages without the \\Answered flag.', default: false },
                                excludeFlagged: {
                                    type: 'boolean',
                                    description: 'Leave flagged (starred) messages where they are (default: true). A star is the clearest signal the message was worth keeping in place.',
                                    default: true
                                },
                                maxMessages: {
                                    type: 'number',
                                    description: 'Ceiling for one call (default: 1000). The response reports how many remain; call again to continue. Keeps a single call inside the tool timeout.',
                                    default: 1000
                                },
                                confirm: {
                                    type: 'boolean',
                                    description: 'Must be true to actually move. False or absent returns a dry run only.',
                                    default: false
                                }
                            },
                            required: ['destinationFolder']
                        }
                    },
                    {
                        name: 'test_connection',
                        description: 'Check that IMAP and SMTP both authenticate with the configured Yahoo app password, and report the resolved Sent folder. Run this first when the mail tools misbehave.',
                        inputSchema: {
                            type: 'object',
                            properties: {}
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
                        return await this.listEmails(args?.count || 10, args?.folder || 'INBOX', args?.offset || 0);

                    case 'read_email':
                        return await this.readEmail(args.uids, args.folder, {
                            maxChars: args?.maxChars === undefined ? 20000 : args.maxChars,
                            format: args?.format || 'full'
                        });

                    case 'search_emails': {
                        const searchOptions = {
                            count: args?.count || 10,
                            dateFrom: args?.dateFrom || null,
                            dateTo: args?.dateTo || null,
                            sender: args?.sender || null,
                            unreadOnly: args?.unreadOnly || false,
                            folder: args?.folder || 'INBOX',
                            bodyQuery: args?.bodyQuery || null,
                            flaggedOnly: args?.flaggedOnly || false,
                            unansweredOnly: args?.unansweredOnly || false,
                            hasAttachment: args?.hasAttachment || false,
                            scanLimit: args?.scanLimit || 200
                        };
                        if (Array.isArray(args?.folders) && args.folders.length > 0) {
                            return await this.searchEmailsMulti(args?.query || '', args.folders, searchOptions);
                        }
                        return await this.searchEmails(args?.query || '', searchOptions);
                    }

                    case 'delete_emails':
                        return await this.deleteEmails(args.uids, args.folder);

                    case 'archive_emails':
                        return await this.archiveEmails(args.uids, args.folder);

                    case 'mark_as_read':
                        return await this.markAsRead(args.uids, args.folder);

                    case 'mark_as_unread':
                        return await this.markAsUnread(args.uids, args.folder);

                    case 'flag_emails':
                        return await this.flagEmails(args.uids, args.folder);

                    case 'unflag_emails':
                        return await this.unflagEmails(args.uids, args.folder);

                    case 'move_emails':
                        return await this.moveEmails(args.uids, args.folderName, args.sourceFolder);

                    case 'list_folders':
                        return await this.listFolders();

                    case 'list_attachments':
                        return await this.listAttachments(args.uids, args?.folder || 'INBOX');

                    case 'save_attachment':
                        return await this.saveAttachment(args);

                    case 'send_email':
                        return await this.sendEmail(args);

                    case 'forward_email':
                        return await this.forwardEmail(args);

                    case 'reply_to_email':
                        return await this.replyToEmail(args);

                    case 'move_by_search':
                        return await this.moveBySearch(args);

                    case 'test_connection':
                        return await this.testConnection();

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
     * Create IMAP connection using app-specific password (like the working test script)
     */
    /**
     * Open an IMAP connection, retrying when Yahoo rate-limits the login.
     *
     * Yahoo permits roughly three concurrent IMAP connections and answers further
     * logins with "NO [LIMIT] ... Rate limit hit" before dropping the socket. That
     * is a transient condition, not a failure, so it is worth a short backoff
     * rather than surfacing as an error to the caller.
     */
    async createImapConnection(attempt = 0) {
        const maxAttempts = Number(process.env.YAHOO_IMAP_RETRIES || 3);
        try {
            return await this.openImapConnection();
        } catch (err) {
            if (this.isRateLimitError(err) && attempt < maxAttempts - 1) {
                const waitMs = 1500 * Math.pow(2, attempt);
                console.error(`[IMAP] Rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
                await new Promise(r => setTimeout(r, waitMs));
                return this.createImapConnection(attempt + 1);
            }
            throw err;
        }
    }

    /**
     * Helper: is this Yahoo telling us to slow down rather than go away?
     */
    isRateLimitError(err) {
        const message = String((err && err.message) || err || '').toLowerCase();
        return message.includes('rate limit') ||
               message.includes('[limit]') ||
               message.includes('too many connections');
    }

    /**
     * Helper: run tasks with a bounded number in flight.
     *
     * Unbounded concurrency across folders is what provokes the rate limiter -
     * eighteen folders opened at once had eleven rejected. Results keep the input
     * order regardless of completion order.
     */
    async runBounded(items, worker, limit) {
        const results = new Array(items.length);
        let cursor = 0;

        const runner = async () => {
            while (cursor < items.length) {
                const index = cursor++;
                results[index] = await worker(items[index], index);
            }
        };

        const width = Math.max(1, Math.min(limit, items.length));
        await Promise.all(Array.from({ length: width }, runner));
        return results;
    }

    async openImapConnection() {
        return new Promise((resolve, reject) => {
            if (!process.env.YAHOO_EMAIL || !process.env.YAHOO_APP_PASSWORD) {
                const error = new Error('YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variables are not set');
                console.error('[IMAP] Configuration error:', error.message);
                reject(error);
                return;
            }

            const imap = new Imap({
                user: process.env.YAHOO_EMAIL,
                password: process.env.YAHOO_APP_PASSWORD,
                host: process.env.YAHOO_IMAP_HOST || 'imap.mail.yahoo.com',
                port: Number(process.env.YAHOO_IMAP_PORT || 993),
                tls: true,
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: true,
                    servername: process.env.YAHOO_IMAP_HOST || 'imap.mail.yahoo.com',
                    minVersion: 'TLSv1.2'
                }
            });

            // Add connection timeout handler (35 seconds)
            const connectionTimeout = setTimeout(() => {
                console.error('[IMAP] Connection timeout after 35 seconds');
                imap.end();
                reject(new Error('Connection timed out. Service may have been sleeping (Render spindown). Please try again.'));
            }, 35000);

            imap.once('ready', () => {
                clearTimeout(connectionTimeout);
                resolve(imap);
            });

            imap.once('error', (err) => {
                clearTimeout(connectionTimeout);
                console.error('[IMAP] Connection error:', err.message);

                // Provide enhanced error messages based on error type
                let errorMessage = err.message;

                // Authentication errors
                if (err.message.includes('Invalid credentials') ||
                    err.message.includes('authentication failed') ||
                    err.message.includes('AUTHENTICATIONFAILED')) {
                    errorMessage = `Authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
                }
                // Network/connection errors
                else if (err.message.includes('ENOTFOUND') ||
                         err.message.includes('ECONNREFUSED') ||
                         err.message.includes('ETIMEDOUT') ||
                         err.message.includes('getaddrinfo')) {
                    errorMessage = `Cannot connect to Yahoo Mail servers: ${err.message}. Check internet connection.`;
                }
                // Timeout errors
                else if (err.message.includes('Timed out') ||
                         err.message.includes('timeout')) {
                    errorMessage = `Connection timed out: ${err.message}. Service may have been sleeping (Render spindown). Please try again.`;
                }

                reject(new Error(errorMessage));
            });

            imap.connect();
        });
    }

    /**
     * List recent emails with enriched metadata
     */
    async listEmails(count = 10, folder = 'INBOX', offset = 0) {
        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (use search or filters for larger results)'
                }]
            };
        }

        // Validate offset
        if (offset < 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: offset must be non-negative'
                }]
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const total = box.messages.total;

                if (total === 0) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: 0,
                                offset: 0,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Calculate range with offset
                // If total=100, offset=10, count=10: fetch messages 81-90 (reversed for newest first)
                const startSeq = Math.max(1, total - offset - count + 1);
                const endSeq = Math.max(1, total - offset);

                if (startSeq > endSeq) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder,
                                message: 'Offset exceeds available messages'
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Fetch with struct for attachments and size
                const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, {
                    bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                    struct: true,
                    size: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    let header = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            header += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(header);

                        emails.push({
                            uid: attrs.uid,                          // NEW: Permanent UID
                            sequenceNumber: seqno,                   // Legacy reference
                            from: parsed.from?.[0] || 'Unknown',
                            subject: parsed.subject?.[0] || 'No Subject',
                            date: parsed.date?.[0] || 'Unknown Date',
                            size: attrs.size || 0,                   // NEW: Message size in bytes
                            flags: attrs.flags || [],                // NEW: IMAP flags
                            hasAttachments: this.hasAttachments(attrs.struct) // NEW
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    // Sort by sequence number (newest first)
                    emails.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: emails,
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                });
            });
        });
    }

    /**
     * Read specific emails by UIDs (supports batch reading)
     */
    async readEmail(uids, folder = 'INBOX', options = {}) {
        // Support both single number and array for backward compatibility
        if (!Array.isArray(uids)) {
            uids = [uids];
        }

        return this.readEmails(uids, folder, options);
    }

    /**
     * Search emails with advanced filters
     */
    async searchEmails(query, options = {}) {
        const {
            count = 10,
            dateFrom = null,
            dateTo = null,
            sender = null,
            unreadOnly = false,
            folder = 'INBOX',
            bodyQuery = null,
            flaggedOnly = false,
            unansweredOnly = false,
            hasAttachment = false,
            scanLimit = 200
        } = options;

        // Validate query parameter (allow empty for date-only searches)
        if (query === undefined || query === null) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: query is required (use empty string "" for searches without text criteria)'
                }]
            };
        }

        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Build search criteria
                const criteria = [];

                // Text search (subject or from)
                if (query && query.trim().length > 0) {
                    criteria.push([
                        'OR',
                        ['HEADER', 'SUBJECT', query],
                        ['HEADER', 'FROM', query]
                    ]);
                }

                // Sender filter
                if (sender && sender.trim().length > 0) {
                    criteria.push(['HEADER', 'FROM', sender]);
                }

                // Date range filters
                if (dateFrom) {
                    try {
                        const fromDate = new Date(dateFrom);
                        if (!isNaN(fromDate.getTime())) {
                            criteria.push(['SINCE', fromDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateFrom format: ${dateFrom}. Use ISO 8601 format.`));
                        return;
                    }
                }

                if (dateTo) {
                    try {
                        const toDate = new Date(dateTo);
                        if (!isNaN(toDate.getTime())) {
                            criteria.push(['BEFORE', toDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateTo format: ${dateTo}. Use ISO 8601 format.`));
                        return;
                    }
                }

                // Full-text body search
                if (bodyQuery && bodyQuery.trim().length > 0) {
                    criteria.push(['TEXT', bodyQuery]);
                }

                // Unread only filter
                if (unreadOnly) {
                    criteria.push('UNSEEN');
                }

                // Flagged (starred) only
                if (flaggedOnly) {
                    criteria.push('FLAGGED');
                }

                // Unanswered only - the standing reply-needed signal
                if (unansweredOnly) {
                    criteria.push('UNANSWERED');
                }

                // If no criteria, search all
                if (criteria.length === 0) {
                    criteria.push('ALL');
                }

                // CRITICAL: imap.search() returns UIDs by default (NOT sequence numbers)
                imap.search(criteria, (err, results) => {
                    if (err) {
                        imap.end();
                        reject(err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: [],
                                    totalMatches: 0,
                                    scanned: 0,
                                    returned: 0,
                                    complete: true,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                        return;
                    }

                    // Get the most recent results (UIDs are already sorted).
                    // When filtering on attachments the IMAP search cannot help, so widen
                    // the scan window and filter after the fetch.
                    const effectiveScanLimit = Math.max(Number(scanLimit) || 200, count);
                    const scanWindow = hasAttachment ? Math.min(results.length, effectiveScanLimit) : count;
                    const limitedResults = results.slice(-scanWindow);

                    // Fetch details for these UIDs
                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                        struct: true,
                        size: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        let header = '';
                        let attrs = null;

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                header += chunk.toString('ascii');
                            });
                        });

                        msg.once('attributes', (attributes) => {
                            attrs = attributes;
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(header);
                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,
                                from: parsed.from?.[0] || 'Unknown',
                                subject: parsed.subject?.[0] || 'No Subject',
                                date: parsed.date?.[0] || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct)
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        imap.end();

                        // Sort by UID (newest first typically)
                        emails.sort((a, b) => b.uid - a.uid);

                        let output = emails;
                        if (hasAttachment) {
                            output = emails.filter(e => e.hasAttachments).slice(0, count);
                        }

                        // Coverage is reported on every search, not just the partial
                        // ones, so a caller never has to infer whether the result set
                        // is exhaustive. complete === false means matches were not
                        // looked at; narrow the search or raise scanLimit.
                        const complete = emails.length >= results.length;
                        const payload = {
                            emails: output,
                            totalMatches: results.length,
                            scanned: emails.length,
                            returned: output.length,
                            complete,
                            query: query,
                            filters: options,
                            folder: folder
                        };
                        if (!complete && hasAttachment) {
                            payload.coverageWarning =
                                `Only the ${emails.length} most recent of ${results.length} matches were inspected for attachments. ` +
                                `Raise scanLimit, or narrow with dateFrom/sender/folder for an exact answer.`;
                        }

                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify(payload, null, 2)
                            }]
                        });
                    });
                });
            });
        });
    }

    /**
     * Validate sequence numbers array for all email operations
     * @returns {string|null} Error message if invalid, null if valid
     */
    validateSequenceNumbers(sequenceNumbers) {
        if (!sequenceNumbers) {
            return 'sequenceNumbers is required';
        }

        if (!Array.isArray(sequenceNumbers)) {
            return 'sequenceNumbers must be an array';
        }

        if (sequenceNumbers.length === 0) {
            return 'sequenceNumbers cannot be empty';
        }

        const invalidValues = sequenceNumbers.filter(n => n === undefined || n === null || typeof n !== 'number');
        if (invalidValues.length > 0) {
            return 'sequenceNumbers contains invalid values (must be numbers)';
        }

        return null;
    }

    /**
     * Helper method for batch email modification operations using UIDs
     */
    async modifyEmails(uids, operation, operationName, folder = 'INBOX') {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, false, (err, box) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Establish which UIDs actually exist BEFORE operating on them.
                // A UID STORE against a UID that is not in the mailbox is a silent
                // no-op under RFC 3501 - the server answers OK and node-imap reports
                // no error - so without this check a deleted or moved message would
                // be reported as successfully modified.
                imap.search([['UID', uids.join(',')]], (searchErr, existingUIDs) => {
                    if (searchErr) {
                        imap.end();
                        reject(new Error(`Failed to verify UIDs in "${folder}": ${searchErr.message}`));
                        return;
                    }

                    const present = new Set(existingUIDs || []);
                    const targets = uids.filter(uid => present.has(uid));
                    const missingUIDs = uids.filter(uid => !present.has(uid));

                    if (targets.length === 0) {
                        imap.end();
                        reject(new Error(
                            `No emails were ${operationName}. None of the requested UIDs exist in "${folder}": ` +
                            `${missingUIDs.join(', ')}. They may have been deleted, or they may live in another folder ` +
                            `- UIDs are folder-scoped.`
                        ));
                        return;
                    }

                    const successfulUIDs = [];
                    const failedUIDs = [];
                    let processedCount = 0;

                    // Process each UID individually to ensure all are processed
                    const processNextUID = () => {
                        if (processedCount >= targets.length) {
                            imap.end();

                            if (successfulUIDs.length === 0) {
                                reject(new Error(
                                    `Failed to ${operationName} any emails. Attempted: ${targets.join(', ')}`
                                ));
                                return;
                            }

                            const parts = [
                                `Successfully ${operationName} ${successfulUIDs.length} email(s) with UIDs: ${successfulUIDs.join(', ')}`
                            ];
                            if (failedUIDs.length > 0) {
                                parts.push(`Failed: ${failedUIDs.join(', ')}`);
                            }
                            if (missingUIDs.length > 0) {
                                parts.push(
                                    `Not found in "${folder}" and therefore untouched: ${missingUIDs.join(', ')} ` +
                                    `(deleted, or in another folder - UIDs are folder-scoped)`
                                );
                            }

                            resolve({
                                content: [{
                                    type: 'text',
                                    text: parts.join('. ')
                                }]
                            });
                            return;
                        }

                        const uid = targets[processedCount];
                        processedCount++;

                        // Execute the UID-based operation for this single UID
                        operation(imap, uid.toString(), (opErr) => {
                            if (opErr) {
                                console.error(`[UID ${uid}] Failed to ${operationName}:`, opErr.message);
                                failedUIDs.push(uid);
                            } else {
                                successfulUIDs.push(uid);
                            }

                            // Continue to next UID (don't stop on errors)
                            processNextUID();
                        });
                    };

                    processNextUID();
                });
            });
        });
    }

    /**
     * Helper method for reading multiple emails using UIDs
     */
    async readEmails(uids, folder = 'INBOX', options = {}) {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const source = uids.join(',');

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(source, {
                    bodies: '',
                    struct: true,
                    size: true
                });

                const emails = [];
                const foundUIDs = new Set();
                const parsePromises = [];

                fetch.on('message', (msg, seqno) => {
                    const chunks = [];
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                        foundUIDs.add(attributes.uid);
                    });

                    msg.once('end', () => {
                        // simpleParser is async; collect the promise so fetch 'end'
                        // can await it before resolving (otherwise bodies come back empty).
                        // Concatenate raw Buffers (do NOT force ascii) to preserve UTF-8.
                        const raw = Buffer.concat(chunks);
                        const parsePromise = simpleParser(raw)
                            .then((parsed) => {
                                const htmlAsText = parsed.html
                                    ? parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
                                    : null;

                                emails.push({
                                    uid: attrs.uid,
                                    sequenceNumber: seqno,  // Still include for reference
                                    from: parsed.from?.text || 'Unknown',
                                    to: parsed.to?.text || 'Unknown',
                                    subject: parsed.subject || 'No Subject',
                                    date: parsed.date || 'Unknown Date',
                                    size: attrs.size || 0,
                                    flags: attrs.flags || [],
                                    hasAttachments: this.hasAttachments(attrs.struct),
                                    attachmentNames: (parsed.attachments || []).map(a => a.filename || '(unnamed)'),
                                    content: parsed.text || htmlAsText || 'No content available'
                                });
                            })
                            .catch((err) => {
                                console.error('Error parsing email:', err);
                            });
                        parsePromises.push(parsePromise);
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', async () => {
                    // Wait for all async body parses to complete before building output
                    await Promise.all(parsePromises);
                    imap.end();

                    // Check for missing UIDs
                    const missingUIDs = uids.filter(uid => !foundUIDs.has(uid));
                    if (missingUIDs.length > 0) {
                        reject(new Error(
                            `UIDs not found: ${missingUIDs.join(', ')}. ` +
                            `Found ${emails.length} of ${uids.length} requested emails. ` +
                            `Missing UIDs may have been deleted or moved to another folder.`
                        ));
                        return;
                    }

                    // Sort by UID for consistent output
                    emails.sort((a, b) => a.uid - b.uid);

                    // Format output
                    const format = options.format || 'full';
                    const rawMax = options.maxChars === undefined ? 20000 : Number(options.maxChars);
                    const limit = format === 'summary' ? 500 : (rawMax > 0 ? rawMax : Infinity);

                    const emailContent = emails.map(email => {
                        const attachLine = email.hasAttachments
                            ? `Yes (${email.attachmentNames.join(', ') || 'names unavailable'}) - use list_attachments for types and sizes`
                            : 'No';
                        const head =
                            `📧 Email UID: ${email.uid} (Seq #${email.sequenceNumber})\n\n` +
                            `From: ${email.from}\n` +
                            `To: ${email.to}\n` +
                            `Subject: ${email.subject}\n` +
                            `Date: ${email.date}\n` +
                            `Size: ${email.size} bytes\n` +
                            `Flags: ${email.flags.join(', ') || 'None'}\n` +
                            `Answered: ${email.flags.includes('\\Answered') ? 'Yes' : 'No'}\n` +
                            `Has Attachments: ${attachLine}`;

                        if (format === 'headers') {
                            return head;
                        }

                        const full = email.content || '';
                        const shown = full.length > limit ? full.slice(0, limit) : full;
                        const truncNote = full.length > limit
                            ? `\n\n[... truncated: showing ${shown.length} of ${full.length} characters. Re-read with a higher maxChars, or maxChars=0 for the whole body ...]`
                            : '';

                        return head + `\n\n--- Content ---\n` + shown + truncNote;
                    }).join('\n\n' + '='.repeat(80) + '\n\n');

                    resolve({
                        content: [{
                            type: 'text',
                            text: emailContent
                        }]
                    });
                });
            });
        });
    }

    /**
     * Mark emails as read
     */
    async markAsRead(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Seen', callback),  // NO .seq
            'marked as read',
            folder
        );
    }

    /**
     * Mark emails as unread
     */
    async markAsUnread(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Seen', callback),  // NO .seq
            'marked as unread',
            folder
        );
    }

    /**
     * Flag emails as important/starred
     */
    async flagEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Flagged', callback),  // NO .seq
            'flagged',
            folder
        );
    }

    /**
     * Remove flag/star from emails
     */
    async unflagEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Flagged', callback),  // NO .seq
            'unflagged',
            folder
        );
    }

    /**
     * Delete emails (move to Trash)
     */
    async deleteEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Trash', callback),  // NO .seq
            'moved to Trash',
            folder
        );
    }

    /**
     * Archive emails
     */
    async archiveEmails(uids, folder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Archive', callback),  // NO .seq
            'archived',
            folder
        );
    }

    /**
     * Move emails to a specific folder
     */
    async moveEmails(uids, folderName, sourceFolder = 'INBOX') {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, folderName, callback),  // NO .seq
            `moved to ${folderName}`,
            sourceFolder
        );
    }

    /**
     * Helper: Detect if email has attachments from BODYSTRUCTURE
     */
    hasAttachments(struct) {
        return this.extractAttachmentParts(struct).some(p => !p.inline);
    }

    /**
     * Helper: walk an IMAP BODYSTRUCTURE and pull out every part that looks like
     * a file. Handles case-insensitive disposition types and parts that carry only
     * a name parameter, both of which the earlier disposition==='attachment' check
     * missed - which mattered because receipt detection depends on it.
     */
    extractAttachmentParts(struct) {
        const found = [];

        const walk = (node) => {
            if (!node) return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (typeof node !== 'object') return;

            const type = node.type ? String(node.type).toLowerCase() : '';
            if (type === 'multipart') return;

            const disp = node.disposition || null;
            const dispType = disp && disp.type ? String(disp.type).toLowerCase() : null;
            const dispParams = (disp && disp.params) || {};
            const partParams = node.params || {};
            const filename = dispParams.filename || dispParams.FILENAME ||
                             partParams.name || partParams.NAME || null;

            const isAttachment = dispType === 'attachment' || (filename && dispType !== null) ||
                                 (filename && type !== 'text');
            if (!isAttachment) return;

            found.push({
                filename: filename || '(unnamed)',
                contentType: node.subtype ? `${type}/${String(node.subtype).toLowerCase()}` : type,
                size: node.size || 0,
                inline: dispType === 'inline'
            });
        };

        walk(struct);
        return found;
    }

    /**
     * Helper: Flatten nested folder structure for list_folders
     */
    flattenFolders(boxes, parent = null) {
        const result = [];

        for (const [name, box] of Object.entries(boxes)) {
            const fullName = parent ? `${parent}/${name}` : name;

            // Skip NOSELECT folders (can't select them)
            const isNoSelect = box.attribs && box.attribs.includes('\\Noselect');

            result.push({
                name: fullName,
                delimiter: box.delimiter || '/',
                flags: box.attribs || [],
                selectable: !isNoSelect
            });

            // Recursively process children
            if (box.children) {
                result.push(...this.flattenFolders(box.children, fullName));
            }
        }

        return result;
    }

    /**
     * Helper: Validate UIDs array
     */
    validateUIDs(uids) {
        if (!uids) {
            return 'uids is required';
        }

        if (!Array.isArray(uids)) {
            return 'uids must be an array';
        }

        if (uids.length === 0) {
            return 'uids cannot be empty';
        }

        const invalidValues = uids.filter(n =>
            n === undefined ||
            n === null ||
            typeof n !== 'number' ||
            n <= 0 ||
            !Number.isInteger(n)
        );

        if (invalidValues.length > 0) {
            return 'uids contains invalid values (must be positive integers)';
        }

        return null;
    }

    /**
     * List all available IMAP folders
     */
    async listFolders() {
        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => {
                imap.end();

                if (err) {
                    reject(new Error(`Failed to retrieve folders: ${err.message}`));
                    return;
                }

                const folders = this.flattenFolders(boxes);

                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            folders: folders,
                            count: folders.length
                        }, null, 2)
                    }]
                });
            });
        });
    }


    // =====================================================================
    // Shared helpers for the send, forward, reply and attachment tools
    // =====================================================================

    /**
     * Helper: wrap plain text in the MCP tool result envelope
     */
    textResult(text) {
        return { content: [{ type: 'text', text }] };
    }

    /**
     * Helper: resolve SMTP configuration from the environment.
     * Yahoo accepts the same app-specific password on SMTP as on IMAP.
     */
    getSmtpConfig() {
        const user = process.env.YAHOO_EMAIL;
        const pass = process.env.YAHOO_APP_PASSWORD;
        if (!user || !pass) {
            throw new Error('YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variables are not set');
        }
        return {
            host: process.env.YAHOO_SMTP_HOST || 'smtp.mail.yahoo.com',
            port: Number(process.env.YAHOO_SMTP_PORT || 465),
            secure: true,
            auth: { user, pass },
            connectionTimeout: 30000,
            greetingTimeout: 30000,
            socketTimeout: 60000,
            tls: { minVersion: 'TLSv1.2' }
        };
    }

    createSmtpTransport() {
        return nodemailer.createTransport(this.getSmtpConfig());
    }

    /**
     * Helper: build the complete RFC822 message up front.
     * Building first, then sending the built bytes, means the copy appended to
     * Sent is byte-identical to what the recipient receives.
     */
    async buildRawMessage(message) {
        const builder = nodemailer.createTransport({
            streamTransport: true,
            buffer: true,
            newline: 'windows'
        });
        const info = await builder.sendMail(message);
        return {
            raw: info.message,
            envelope: info.envelope,
            messageId: info.messageId
        };
    }

    /**
     * Helper: build, submit and file a message.
     *
     * The message is built twice whenever a Bcc is present. Nodemailer keeps the
     * Bcc header in raw output, so submitting that raw copy would show every blind
     * recipient to everyone on the message. The wire copy therefore carries no Bcc
     * header while the envelope still routes to the blind recipients, and the copy
     * filed in Sent keeps the Bcc header so the record stays complete. A single
     * Message-ID is fixed up front so both copies match.
     */
    async deliverMessage(message, saveToSent = true) {
        const domain = String(message.from || '').split('@')[1] || 'yahoo.com';
        if (!message.messageId) {
            message.messageId = `<${globalThis.crypto.randomUUID()}@${domain}>`;
        }

        const archiveCopy = await this.buildRawMessage(message);
        const wireCopy = message.bcc
            ? await this.buildRawMessage({ ...message, bcc: undefined })
            : archiveCopy;

        const transport = this.createSmtpTransport();
        let info;
        try {
            info = await transport.sendMail({ raw: wireCopy.raw, envelope: archiveCopy.envelope });
        } finally {
            transport.close();
        }

        const sentNote = saveToSent === false
            ? 'Sent copy skipped'
            : await this.appendToSent(archiveCopy.raw);

        return {
            messageId: archiveCopy.messageId,
            response: info.response || 'accepted',
            recipients: (archiveCopy.envelope.to || []).join(', '),
            sentNote
        };
    }

    /**
     * Helper: append a sent message to the Sent folder.
     * Yahoo does not file SMTP submissions automatically, so without this a
     * message sent through the tool would be invisible in the web client.
     * Never throws - a failed copy must not look like a failed send.
     */
    async appendToSent(raw) {
        const configured = process.env.YAHOO_SENT_FOLDER || null;
        const candidates = configured ? [configured] : ['Sent', 'Sent Items', 'INBOX.Sent'];

        for (const mailbox of candidates) {
            try {
                const imap = await this.createImapConnection();
                const result = await new Promise((resolve) => {
                    imap.append(raw, { mailbox, flags: ['\\Seen'] }, (err) => {
                        imap.end();
                        resolve(err ? { ok: false, error: err.message } : { ok: true, mailbox });
                    });
                });
                if (result.ok) return `copy saved to "${result.mailbox}"`;
            } catch (err) {
                return `copy not saved (${err.message})`;
            }
        }
        return `copy not saved (no writable Sent folder found; set YAHOO_SENT_FOLDER)`;
    }

    /**
     * Helper: fetch and parse a single message by UID
     */
    async fetchMessage(uid, folder = 'INBOX') {
        if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
            throw new Error('uid must be a positive integer');
        }

        const imap = await this.createImapConnection();

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const fetch = imap.fetch(String(uid), { bodies: '', struct: true, size: true });
                const chunks = [];
                let attrs = null;
                let found = false;

                fetch.on('message', (msg) => {
                    found = true;
                    msg.on('body', (stream) => {
                        stream.on('data', (chunk) => chunks.push(chunk));
                    });
                    msg.once('attributes', (attributes) => { attrs = attributes; });
                });

                fetch.once('error', (fetchErr) => {
                    imap.end();
                    reject(fetchErr);
                });

                fetch.once('end', async () => {
                    imap.end();
                    if (!found) {
                        reject(new Error(`UID ${uid} not found in folder "${folder}". It may have been moved or deleted.`));
                        return;
                    }
                    try {
                        const raw = Buffer.concat(chunks);
                        const parsed = await simpleParser(raw);
                        resolve({ uid, attrs, raw, parsed });
                    } catch (parseErr) {
                        reject(new Error(`Failed to parse UID ${uid}: ${parseErr.message}`));
                    }
                });
            });
        });
    }

    /**
     * Helper: human readable byte size
     */
    formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }

    /**
     * Helper: strip any directory component from an attachment filename.
     * Attachment filenames arrive from outside and must never steer a write.
     */
    safeFilename(name, fallback = 'attachment.bin') {
        const base = path.basename(String(name || '').replace(/[\\/]/g, '_')).trim();
        const cleaned = base.replace(/[^A-Za-z0-9 ._()+,#&@'\[\]{}-]/g, '_');
        return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
    }

    /**
     * Helper: render a send preview. Every send tool returns one of these when
     * confirm is not true, so nothing leaves the mailbox unreviewed.
     */
    previewResult(action, fields, attachments = []) {
        const lines = [
            `PREVIEW ONLY - nothing has been sent.`,
            ``,
            `Action: ${action}`,
            ...Object.entries(fields)
                .filter(([, v]) => v !== null && v !== undefined && v !== '')
                .map(([k, v]) => `${k}: ${v}`)
        ];

        if (attachments.length > 0) {
            lines.push(``, `Attachments that would travel with it (${attachments.length}):`);
            attachments.forEach((a, i) => {
                lines.push(`  ${i + 1}. ${a.filename} - ${a.contentType} - ${this.formatBytes(a.size)}`);
            });
        } else {
            lines.push(``, `Attachments: none`);
        }

        lines.push(``, `To send this, call the same tool again with confirm: true.`);
        return this.textResult(lines.join('\n'));
    }

    /**
     * Helper: address list to a comma separated string, dropping our own address
     */
    addressListToString(addressObject, exclude = []) {
        if (!addressObject || !Array.isArray(addressObject.value)) return '';
        const excludeLower = exclude.filter(Boolean).map(e => String(e).toLowerCase());
        return addressObject.value
            .filter(a => a.address && !excludeLower.includes(String(a.address).toLowerCase()))
            .map(a => (a.name ? `"${a.name}" <${a.address}>` : a.address))
            .join(', ');
    }

    /**
     * Helper: quote an original message under a reply or forward
     */
    quoteOriginalText(parsed, style = 'reply') {
        const header = [
            `From: ${parsed.from?.text || 'Unknown'}`,
            `Date: ${parsed.date ? new Date(parsed.date).toString() : 'Unknown'}`,
            `Subject: ${parsed.subject || '(no subject)'}`,
            `To: ${parsed.to?.text || 'Unknown'}`
        ];
        if (parsed.cc?.text) header.push(`Cc: ${parsed.cc.text}`);

        const bodyText = parsed.text ||
            (parsed.html ? parsed.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '') ||
            '(no text content)';

        if (style === 'forward') {
            return [
                '',
                '---------- Forwarded message ----------',
                ...header,
                '',
                bodyText
            ].join('\n');
        }

        const quoted = bodyText.split('\n').map(l => `> ${l}`).join('\n');
        return ['', `On ${parsed.date ? new Date(parsed.date).toString() : 'an earlier date'}, ${parsed.from?.text || 'the sender'} wrote:`, quoted].join('\n');
    }

    // =====================================================================
    // Attachment tools
    // =====================================================================

    /**
     * List attachments on one or more emails
     */
    async listAttachments(uids, folder = 'INBOX') {
        if (!Array.isArray(uids)) uids = [uids];
        const validationError = this.validateUIDs(uids);
        if (validationError) return this.textResult(`Error: ${validationError}`);

        const results = [];
        for (const uid of uids) {
            try {
                const { parsed, attrs } = await this.fetchMessage(uid, folder);
                const attachments = (parsed.attachments || []).map((a, index) => {
                    const contentType = (a.contentType || 'application/octet-stream').toLowerCase();
                    const size = a.size || (a.content ? a.content.length : 0);
                    const inline = a.contentDisposition === 'inline';
                    const isImage = contentType.startsWith('image/');

                    // A signature logo is a small image the message references by
                    // Content-ID. Scanned receipts and photographed invoices are
                    // larger and are not referenced from the body, so this keeps the
                    // is-this-a-receipt hint from firing on every corporate footer.
                    const isSignatureLogo = isImage && Boolean(a.cid) && size < 100 * 1024;

                    const looksLikeDocument =
                        /^(application\/pdf|application\/vnd\.|application\/msword|application\/rtf|application\/zip|text\/csv)/.test(contentType) ||
                        (isImage && !inline && !isSignatureLogo);

                    return {
                        index,
                        filename: a.filename || '(unnamed)',
                        contentType: a.contentType || 'application/octet-stream',
                        size,
                        sizeHuman: this.formatBytes(size),
                        inline,
                        contentId: a.cid || null,
                        isSignatureLogo,
                        looksLikeDocument
                    };
                });

                results.push({
                    uid,
                    folder,
                    subject: parsed.subject || '(no subject)',
                    from: parsed.from?.text || 'Unknown',
                    date: parsed.date || null,
                    flags: attrs?.flags || [],
                    attachmentCount: attachments.length,
                    documentCount: attachments.filter(a => a.looksLikeDocument && !a.inline).length,
                    attachments
                });
            } catch (err) {
                results.push({ uid, folder, error: err.message });
            }
        }

        return this.textResult(JSON.stringify({ results, count: results.length }, null, 2));
    }

    /**
     * Save attachments to disk
     */
    async saveAttachment(args = {}) {
        const {
            uid,
            folder = 'INBOX',
            filename = null,
            index = null,
            all = false,
            outputDir = null
        } = args;

        if (typeof uid !== 'number') {
            return this.textResult('Error: uid is required and must be a number');
        }
        if (!all && filename === null && index === null) {
            return this.textResult('Error: provide filename, index, or all=true. Use list_attachments to see what is available.');
        }

        const targetDir = outputDir || process.env.YAHOO_ATTACHMENT_DIR || path.join(os.homedir(), 'Downloads');

        let message;
        try {
            message = await this.fetchMessage(uid, folder);
        } catch (err) {
            return this.textResult(`Error: ${err.message}`);
        }

        const attachments = message.parsed.attachments || [];
        if (attachments.length === 0) {
            return this.textResult(`UID ${uid} has no attachments.`);
        }

        let selected;
        if (all) {
            selected = attachments.map((a, i) => ({ a, i }));
        } else if (index !== null) {
            if (index < 0 || index >= attachments.length) {
                return this.textResult(`Error: index ${index} out of range - UID ${uid} has ${attachments.length} attachment(s).`);
            }
            selected = [{ a: attachments[index], i: index }];
        } else {
            const matchIndex = attachments.findIndex(a => a.filename === filename);
            if (matchIndex === -1) {
                const names = attachments.map(a => a.filename || '(unnamed)').join(', ');
                return this.textResult(`Error: no attachment named "${filename}" on UID ${uid}. Available: ${names}`);
            }
            selected = [{ a: attachments[matchIndex], i: matchIndex }];
        }

        try {
            fs.mkdirSync(targetDir, { recursive: true });
        } catch (err) {
            return this.textResult(`Error: cannot create output directory "${targetDir}": ${err.message}`);
        }

        const saved = [];
        for (const { a, i } of selected) {
            const base = this.safeFilename(a.filename, `uid${uid}-attachment${i}.bin`);
            let target = path.join(targetDir, base);
            let counter = 1;
            const ext = path.extname(base);
            const stem = base.slice(0, base.length - ext.length);
            while (fs.existsSync(target)) {
                target = path.join(targetDir, `${stem} (${counter})${ext}`);
                counter += 1;
            }
            try {
                fs.writeFileSync(target, a.content);
                saved.push({ index: i, filename: a.filename || '(unnamed)', path: target, bytes: a.content.length, contentType: a.contentType });
            } catch (err) {
                saved.push({ index: i, filename: a.filename || '(unnamed)', error: err.message });
            }
        }

        return this.textResult(JSON.stringify({ uid, folder, outputDir: targetDir, saved }, null, 2));
    }

    // =====================================================================
    // Send, forward and reply
    // =====================================================================

    async sendEmail(args = {}) {
        const {
            to,
            subject,
            body,
            html = null,
            cc = null,
            bcc = null,
            confirm = false,
            saveToSent = true
        } = args;

        if (!to || String(to).trim() === '') return this.textResult('Error: "to" is required');
        if (subject === undefined || subject === null) return this.textResult('Error: "subject" is required');
        if ((!body || String(body).trim() === '') && !html) return this.textResult('Error: "body" (or "html") is required');

        const from = process.env.YAHOO_EMAIL;
        if (!from) return this.textResult('Error: YAHOO_EMAIL environment variable is not set');

        if (confirm !== true) {
            return this.previewResult('send_email', {
                From: from,
                To: to,
                Cc: cc,
                Bcc: bcc,
                Subject: subject,
                Body: `\n${body || '(HTML only)'}`
            });
        }

        const message = { from, to, subject, text: body };
        if (html) message.html = html;
        if (cc) message.cc = cc;
        if (bcc) message.bcc = bcc;

        const sent = await this.deliverMessage(message, saveToSent);

        return this.textResult(
            `Sent.\n\nTo: ${to}\nEnvelope recipients: ${sent.recipients}\nSubject: ${subject}\nMessage-ID: ${sent.messageId}\nSMTP response: ${sent.response}\n${sent.sentNote}`
        );
    }

    async forwardEmail(args = {}) {
        const {
            uid,
            to,
            folder = 'INBOX',
            note = '',
            mode = 'attachments',
            confirm = false,
            saveToSent = true
        } = args;

        if (typeof uid !== 'number') return this.textResult('Error: uid is required and must be a number');
        if (!to || String(to).trim() === '') return this.textResult('Error: "to" is required');

        const from = process.env.YAHOO_EMAIL;
        if (!from) return this.textResult('Error: YAHOO_EMAIL environment variable is not set');

        const { parsed, raw } = await this.fetchMessage(uid, folder);

        const originalSubject = parsed.subject || '(no subject)';
        const subject = /^fwd?:/i.test(originalSubject) ? originalSubject : `Fwd: ${originalSubject}`;

        let attachments;
        let bodyText;

        if (mode === 'eml') {
            const emlName = this.safeFilename(`${originalSubject}.eml`, `forwarded-uid${uid}.eml`);
            attachments = [{ filename: emlName, content: raw, contentType: 'message/rfc822' }];
            bodyText = `${note ? note + '\n\n' : ''}The original message is attached in full as ${emlName}.\n\nFrom: ${parsed.from?.text || 'Unknown'}\nDate: ${parsed.date ? new Date(parsed.date).toString() : 'Unknown'}\nSubject: ${originalSubject}`;
        } else {
            attachments = (parsed.attachments || []).map((a, i) => ({
                filename: this.safeFilename(a.filename, `attachment${i}.bin`),
                content: a.content,
                contentType: a.contentType || 'application/octet-stream',
                cid: a.cid || undefined
            }));
            bodyText = `${note ? note + '\n' : ''}${this.quoteOriginalText(parsed, 'forward')}`;
        }

        const previewAttachments = attachments.map(a => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.content ? a.content.length : 0
        }));

        if (confirm !== true) {
            return this.previewResult('forward_email', {
                From: from,
                To: to,
                Subject: subject,
                'Original UID': `${uid} in "${folder}"`,
                'Original from': parsed.from?.text || 'Unknown',
                Mode: mode,
                Body: `\n${bodyText.slice(0, 1500)}${bodyText.length > 1500 ? '\n[... preview truncated ...]' : ''}`
            }, previewAttachments);
        }

        const message = { from, to, subject, text: bodyText };
        if (attachments.length > 0) message.attachments = attachments;

        const sent = await this.deliverMessage(message, saveToSent);

        return this.textResult(
            `Forwarded UID ${uid}.\n\nTo: ${to}\nSubject: ${subject}\nMode: ${mode}\nAttachments carried: ${previewAttachments.length}\nMessage-ID: ${sent.messageId}\nSMTP response: ${sent.response}\n${sent.sentNote}`
        );
    }

    async replyToEmail(args = {}) {
        const {
            uid,
            body,
            folder = 'INBOX',
            replyAll = false,
            quoteOriginal = true,
            confirm = false,
            saveToSent = true
        } = args;

        if (typeof uid !== 'number') return this.textResult('Error: uid is required and must be a number');
        if (!body || String(body).trim() === '') return this.textResult('Error: "body" is required');

        const from = process.env.YAHOO_EMAIL;
        if (!from) return this.textResult('Error: YAHOO_EMAIL environment variable is not set');

        const { parsed } = await this.fetchMessage(uid, folder);

        const replyTarget = parsed.replyTo && parsed.replyTo.value?.length ? parsed.replyTo : parsed.from;
        const to = this.addressListToString(replyTarget);
        if (!to) return this.textResult(`Error: could not determine a reply address for UID ${uid}`);

        let cc = '';
        if (replyAll) {
            const others = [];
            const toList = this.addressListToString(parsed.to, [from]);
            const ccList = this.addressListToString(parsed.cc, [from]);
            if (toList) others.push(toList);
            if (ccList) others.push(ccList);
            cc = others.join(', ');
        }

        const originalSubject = parsed.subject || '(no subject)';
        const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
        const bodyText = quoteOriginal === false ? body : `${body}\n${this.quoteOriginalText(parsed, 'reply')}`;

        if (confirm !== true) {
            return this.previewResult('reply_to_email', {
                From: from,
                To: to,
                Cc: cc,
                Subject: subject,
                'In reply to': `UID ${uid} in "${folder}" - ${parsed.from?.text || 'Unknown'}`,
                'Reply all': replyAll ? 'yes' : 'no',
                Body: `\n${bodyText.slice(0, 1500)}${bodyText.length > 1500 ? '\n[... preview truncated ...]' : ''}`
            });
        }

        const references = []
            .concat(parsed.references || [])
            .concat(parsed.messageId ? [parsed.messageId] : [])
            .filter(Boolean);

        const message = {
            from,
            to,
            subject,
            text: bodyText,
            inReplyTo: parsed.messageId || undefined,
            references: references.length > 0 ? references : undefined
        };
        if (cc) message.cc = cc;

        const sent = await this.deliverMessage(message, saveToSent);

        // Set \Answered on the original so unansweredOnly searches stay truthful
        let answeredNote;
        try {
            await this.modifyEmails(
                [uid],
                (imap, source, callback) => imap.addFlags(source, '\\Answered', callback),
                'marked answered',
                folder
            );
            answeredNote = `Original UID ${uid} flagged \\Answered`;
        } catch (err) {
            answeredNote = `Could not flag the original as answered (${err.message})`;
        }

        return this.textResult(
            `Replied to UID ${uid}.\n\nTo: ${to}\n${cc ? `Cc: ${cc}\n` : ''}Subject: ${subject}\nMessage-ID: ${sent.messageId}\nSMTP response: ${sent.response}\n${sent.sentNote}\n${answeredNote}`
        );
    }

    // =====================================================================
    // Multi-folder search and diagnostics
    // =====================================================================

    /**
     * Run the same search across several folders and merge the results.
     * A sweep that checks INBOX plus the filing folders otherwise pays a full
     * round trip per tool call.
     */
    async searchEmailsMulti(query, folders, options = {}) {
        // Folders are searched concurrently but with a BOUNDED width. Sequential
        // searching blew the 60 second tool timeout; unbounded searching blew
        // Yahoo's connection limit, which permits roughly three at once and answers
        // the rest with "Rate limit hit" - eighteen folders at once had eleven
        // rejected. A small pool satisfies both constraints.
        const concurrency = Number(process.env.YAHOO_IMAP_CONCURRENCY || 3);
        const settled = await this.runBounded(folders, async (folder) => {
            try {
                const result = await this.searchEmails(query, { ...options, folder });
                const payload = JSON.parse(result.content[0].text);
                const emails = (payload.emails || []).map(e => ({ ...e, folder }));
                return {
                    emails,
                    summary: {
                        folder,
                        totalMatches: payload.totalMatches || 0,
                        scanned: payload.scanned || 0,
                        returned: emails.length,
                        complete: payload.complete !== false,
                        ...(payload.coverageWarning ? { coverageWarning: payload.coverageWarning } : {})
                    }
                };
            } catch (err) {
                return {
                    emails: [],
                    summary: {
                        folder,
                        error: err.message,
                        ...(this.isRateLimitError(err)
                            ? { hint: 'Yahoo rate-limited this connection. Search fewer folders per call, or lower YAHOO_IMAP_CONCURRENCY.' }
                            : {})
                    }
                };
            }
        }, concurrency);

        const merged = settled.flatMap(r => r.emails);
        const perFolder = settled.map(r => r.summary);

        merged.sort((a, b) => {
            const da = new Date(a.date).getTime() || 0;
            const db = new Date(b.date).getTime() || 0;
            return db - da;
        });

        const count = options.count || 10;
        const incomplete = perFolder.filter(f => f.complete === false).map(f => f.folder);
        const failed = perFolder.filter(f => f.error).map(f => f.folder);
        const rateLimited = perFolder.filter(f => f.hint).map(f => f.folder);

        return this.textResult(JSON.stringify({
            emails: merged.slice(0, count * folders.length),
            perFolder,
            foldersSearched: folders,
            complete: incomplete.length === 0 && failed.length === 0,
            ...(incomplete.length > 0 ? {
                coverageWarning: `Partial coverage in: ${incomplete.join(', ')}. Raise scanLimit or narrow the search before treating this as exhaustive.`
            } : {}),
            ...(failed.length > 0 ? { failedFolders: failed } : {}),
            ...(rateLimited.length > 0 ? {
                rateLimitWarning: `Yahoo rate-limited ${rateLimited.length} folder(s): ${rateLimited.join(', ')}. ` +
                    `Yahoo allows about three concurrent IMAP connections. Search in batches of four folders or fewer.`
            } : {}),
            query,
            filters: options
        }, null, 2));
    }

    /**
     * Helper: compress a sorted UID list into IMAP set notation.
     * [1,2,3,7,9,10,11] becomes [ "1:3", 7, "9:11" ]. Mail filed in bulk is
     * usually contiguous, so this turns a command that would run to tens of
     * kilobytes into one that fits comfortably inside a line.
     *
     * Returns an ARRAY, never a joined string. node-imap validates each element
     * of a UID list separately: a lone "a:b" range passes, but a comma-joined
     * string like "1:29,31:59" fails the range test and is then silently
     * parseInt-ed down to 1 - so the command would act on the wrong message and
     * report success. Passing the array lets node-imap do the joining safely.
     */
    compressUidSet(uids) {
        if (!uids.length) return [];
        const sorted = [...uids].sort((a, b) => a - b);
        const parts = [];
        let start = sorted[0];
        let prev = sorted[0];

        for (let i = 1; i <= sorted.length; i++) {
            const uid = sorted[i];
            if (uid === prev + 1) { prev = uid; continue; }
            parts.push(start === prev ? start : `${start}:${prev}`);
            start = uid;
            prev = uid;
        }
        return parts;
    }

    /**
     * Find every message matching a search and move it in bulk.
     *
     * The existing move_emails walks one UID at a time through modifyEmails,
     * which is fine for a handful and hopeless for thousands. This runs the
     * search and the moves on ONE connection - Yahoo allows about three, so
     * spending them carefully matters - and moves in range-compressed batches.
     */
    async moveBySearch(args = {}) {
        const {
            destinationFolder,
            sourceFolder = 'INBOX',
            sender = null,
            query = null,
            bodyQuery = null,
            dateFrom = null,
            dateTo = null,
            unreadOnly = false,
            unansweredOnly = false,
            excludeFlagged = true,
            maxMessages = 1000,
            confirm = false
        } = args;

        if (!destinationFolder || !String(destinationFolder).trim()) {
            return this.textResult('Error: destinationFolder is required');
        }
        if (String(destinationFolder).toLowerCase() === String(sourceFolder).toLowerCase()) {
            return this.textResult(`Error: destinationFolder and sourceFolder are both "${sourceFolder}"`);
        }

        const criteriaGiven = [sender, query, bodyQuery, dateFrom, dateTo].some(v => v && String(v).trim()) ||
                              unreadOnly || unansweredOnly;
        if (!criteriaGiven) {
            return this.textResult(
                'Error: give at least one of sender, query, bodyQuery, dateFrom, dateTo, unreadOnly or unansweredOnly. ' +
                'Refusing to move an entire folder on an empty search.'
            );
        }

        const batchSize = 500;
        const imap = await this.createImapConnection();

        const run = (fn) => new Promise((resolve, reject) => fn(resolve, reject));

        try {
            // Confirm the destination exists before touching anything. A typo here
            // would otherwise scatter mail into a folder nobody looks at.
            const boxes = await run((resolve, reject) =>
                imap.getBoxes((err, b) => err ? reject(err) : resolve(b)));
            const names = this.flattenFolders(boxes).map(f => f.name);
            if (!names.some(n => n.toLowerCase() === String(destinationFolder).toLowerCase())) {
                imap.end();
                return this.textResult(
                    `Error: destination folder "${destinationFolder}" does not exist. Create it first, or pick one of: ${names.slice(0, 25).join(', ')}...`
                );
            }

            await run((resolve, reject) =>
                imap.openBox(sourceFolder, false, (err) =>
                    err ? reject(new Error(`Failed to open folder "${sourceFolder}": ${err.message}`)) : resolve()));

            const criteria = [];
            if (query && query.trim()) {
                criteria.push(['OR', ['HEADER', 'SUBJECT', query], ['HEADER', 'FROM', query]]);
            }
            if (sender && sender.trim()) criteria.push(['HEADER', 'FROM', sender]);
            if (bodyQuery && bodyQuery.trim()) criteria.push(['TEXT', bodyQuery]);
            if (dateFrom) {
                const d = new Date(dateFrom);
                if (isNaN(d.getTime())) { imap.end(); return this.textResult(`Error: invalid dateFrom "${dateFrom}"`); }
                criteria.push(['SINCE', d]);
            }
            if (dateTo) {
                const d = new Date(dateTo);
                if (isNaN(d.getTime())) { imap.end(); return this.textResult(`Error: invalid dateTo "${dateTo}"`); }
                criteria.push(['BEFORE', d]);
            }
            if (unreadOnly) criteria.push('UNSEEN');
            if (unansweredOnly) criteria.push('UNANSWERED');

            const matched = await run((resolve, reject) =>
                imap.search(criteria, (err, r) => err ? reject(err) : resolve(r || [])));

            let candidates = matched;
            let flaggedHeld = 0;
            if (excludeFlagged && matched.length) {
                const flagged = await run((resolve, reject) =>
                    imap.search([...criteria, 'FLAGGED'], (err, r) => err ? reject(err) : resolve(r || [])));
                const starred = new Set(flagged);
                candidates = matched.filter(uid => !starred.has(uid));
                flaggedHeld = matched.length - candidates.length;
            }

            if (candidates.length === 0) {
                imap.end();
                return this.textResult(JSON.stringify({
                    matched: matched.length, flaggedHeldBack: flaggedHeld, toMove: 0,
                    moved: 0, remaining: 0, sourceFolder, destinationFolder,
                    note: 'Nothing to move.'
                }, null, 2));
            }

            // Oldest first: those are the messages closest to sliding out of the
            // 10,000-message window, so they are the ones worth filing first.
            candidates.sort((a, b) => a - b);
            const selection = candidates.slice(0, Math.max(1, maxMessages));
            const remaining = candidates.length - selection.length;

            if (confirm !== true) {
                const sampleUids = selection.slice(0, 5);
                // The fetch 'end' event can fire before every message's own 'end'
                // has run, so resolving on it alone under-reports the sample - the
                // same async race that once returned empty bodies from read_email.
                // Count the messages in and wait for them out.
                const sample = await new Promise((resolve) => {
                    const out = [];
                    let started = 0;
                    let finished = 0;
                    let fetchDone = false;
                    const expected = sampleUids.length;
                    const settle = () => {
                        if (finished >= expected || (fetchDone && finished >= started)) resolve(out);
                    };
                    const f = imap.fetch(this.compressUidSet(sampleUids), {
                        bodies: 'HEADER.FIELDS (FROM SUBJECT DATE)', struct: false
                    });
                    f.on('message', (msg) => {
                        started++;
                        let hdr = '';
                        msg.on('body', (stream) => stream.on('data', c => hdr += c.toString('ascii')));
                        msg.once('end', () => {
                            const p = Imap.parseHeader(hdr);
                            out.push({ from: p.from?.[0] || '?', subject: p.subject?.[0] || '?', date: p.date?.[0] || '?' });
                            finished++;
                            settle();
                        });
                    });
                    f.once('error', () => { fetchDone = true; resolve(out); });
                    // Give any in-flight message a tick to finish before settling.
                    f.once('end', () => { fetchDone = true; setTimeout(settle, 150); });
                    // Never hang the dry run on a sample that will not arrive.
                    setTimeout(() => resolve(out), 8000);
                });
                imap.end();

                return this.textResult(JSON.stringify({
                    dryRun: true,
                    note: 'PREVIEW ONLY - nothing has been moved. Re-run with confirm: true.',
                    sourceFolder, destinationFolder,
                    matched: matched.length,
                    flaggedHeldBack: flaggedHeld,
                    wouldMoveNow: selection.length,
                    wouldRemainAfter: remaining,
                    batches: Math.ceil(selection.length / batchSize),
                    sample
                }, null, 2));
            }

            let moved = 0;
            const batches = [];
            for (let i = 0; i < selection.length; i += batchSize) {
                const chunk = selection.slice(i, i + batchSize);
                const set = this.compressUidSet(chunk);
                try {
                    await run((resolve, reject) =>
                        imap.move(set, destinationFolder, (err) => err ? reject(err) : resolve()));
                    moved += chunk.length;
                    batches.push({ batch: batches.length + 1, count: chunk.length, ok: true });
                } catch (err) {
                    batches.push({ batch: batches.length + 1, count: chunk.length, ok: false, error: err.message });
                    break;
                }
            }
            imap.end();

            return this.textResult(JSON.stringify({
                sourceFolder, destinationFolder,
                matched: matched.length,
                flaggedHeldBack: flaggedHeld,
                moved,
                remaining: candidates.length - moved,
                batches,
                note: candidates.length - moved > 0
                    ? `${candidates.length - moved} still match. Call again with the same arguments to continue.`
                    : 'Everything that was VISIBLE has been filed. If the source is a capped mailbox - Yahoo exposes only the most recent 10,000 messages per folder - then filing frees room at the cap and older messages slide into view, some of which may also match. Run again until this reports "Nothing to move".'
            }, null, 2));

        } catch (err) {
            try { imap.end(); } catch (_) {}
            return this.textResult(`Error: ${err.message}`);
        }
    }

    /**
     * Verify IMAP and SMTP credentials and report the Sent folder in use
     */
    async testConnection() {
        const report = { imap: null, smtp: null, sentFolder: null, account: process.env.YAHOO_EMAIL || '(not set)' };

        try {
            const imap = await this.createImapConnection();
            const boxes = await new Promise((resolve, reject) => {
                imap.getBoxes((err, b) => {
                    imap.end();
                    if (err) reject(err); else resolve(b);
                });
            });
            const folders = this.flattenFolders(boxes).map(f => f.name);
            report.imap = {
                ok: true,
                host: process.env.YAHOO_IMAP_HOST || 'imap.mail.yahoo.com',
                folderCount: folders.length,
                concurrency: Number(process.env.YAHOO_IMAP_CONCURRENCY || 3),
                note: 'imap.mail.yahoo.com exposes only the most recent 10,000 messages per folder. Mail older than that is invisible to IMAP even though the web client still shows it.'
            };
            const configured = process.env.YAHOO_SENT_FOLDER || null;
            report.sentFolder = configured ||
                folders.find(f => ['sent', 'sent items'].includes(f.toLowerCase())) ||
                '(none found - set YAHOO_SENT_FOLDER)';
        } catch (err) {
            report.imap = { ok: false, error: err.message };
        }

        try {
            const transport = this.createSmtpTransport();
            await transport.verify();
            transport.close();
            const cfg = this.getSmtpConfig();
            report.smtp = { ok: true, host: cfg.host, port: cfg.port };
        } catch (err) {
            report.smtp = {
                ok: false,
                error: err.message,
                hint: 'Yahoo accepts the IMAP app password on SMTP. If this fails, regenerate the app password at https://login.yahoo.com/account/security and update YAHOO_APP_PASSWORD.'
            };
        }

        return this.textResult(JSON.stringify(report, null, 2));
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

        // Parse request bodies for different content types
        // Skip /mcp/message which needs raw body for SSE
        app.use((req, res, next) => {
            if (req.path === '/mcp/message') {
                return next();
            }

            // OAuth token endpoint needs both JSON and URL-encoded support
            if (req.path === '/oauth/token') {
                // Parse both JSON and URL-encoded bodies
                express.json()(req, res, (err) => {
                    if (err) return next(err);
                    express.urlencoded({ extended: true })(req, res, next);
                });
            } else {
                // All other endpoints just need JSON
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

        // Helper function to generate OAuth metadata
        const getOAuthMetadata = (req) => {
            const baseUrl = `https://${req.get('host')}`;
            return {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['authorization_code', 'client_credentials'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp']
            };
        };

        // Helper function to generate protected resource metadata
        const getProtectedResourceMetadata = (req, resourcePath = '') => {
            const baseUrl = `https://${req.get('host')}`;
            return {
                resource: resourcePath ? `${baseUrl}${resourcePath}` : baseUrl,
                authorization_servers: [baseUrl],
                scopes_supported: ['mcp']
            };
        };

        // OpenID Configuration (superset of OAuth authorization server metadata)
        app.get('/.well-known/openid-configuration', (req, res) => {
            console.error('[OAuth] OpenID configuration requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth 2.0 Authorization Server Metadata (RFC 8414)
        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            console.error('[OAuth] Authorization server metadata requested');
            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp/sse requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth Protected Resource Metadata
        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            console.error('[OAuth] Protected resource metadata requested');
            res.json(getProtectedResourceMetadata(req));
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            res.json(getProtectedResourceMetadata(req, '/mcp/sse'));
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
        app.post('/oauth/token', async (req, res) => {
            console.error('[OAuth] Token request - grant type:', req.body?.grant_type || 'unknown');

            const clientId = process.env.OAUTH_CLIENT_ID;
            const clientSecret = process.env.OAUTH_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
                console.error('[OAuth] Server misconfigured - OAuth credentials not set');
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
                console.error('[OAuth] Authentication failed - invalid client credentials');
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
                version: '3.0.0',
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
                version: '3.0.0',
                description: 'MCP server for Yahoo Mail access via IMAP',
                endpoints: {
                    health: '/health',
                    sse: '/mcp/sse',
                    message: '/mcp/message'
                },
                tools: [
                    'list_emails',
                    'read_email',
                    'search_emails',
                    'delete_emails',
                    'archive_emails',
                    'mark_as_read',
                    'mark_as_unread',
                    'flag_emails',
                    'unflag_emails',
                    'move_emails'
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