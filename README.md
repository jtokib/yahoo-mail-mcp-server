# Yahoo Mail MCP Server

A Model Context Protocol (MCP) server that provides read-only access to Yahoo Mail through IMAP. This allows Claude Desktop to list, read, and search your Yahoo Mail emails.

## Features

- **List recent emails** - Get a list of recent emails from your inbox
- **Read email content** - Read the full content of specific emails
- **Search emails** - Search emails by subject line or sender

## Prerequisites

- Node.js (v16 or higher)
- Yahoo Mail account with IMAP enabled
- Claude Desktop

## Setup Instructions

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/yahoo-mail-mcp.git
cd yahoo-mail-mcp
npm install
```

### 2. Configure Yahoo Mail

#### Enable IMAP Access
1. Log into your Yahoo Mail account
2. Go to **Settings** → **More Settings** → **Mailboxes** 
3. Enable **IMAP access**

#### Generate App Password
1. Go to [Yahoo Account Security](https://login.yahoo.com/account/security/app-passwords)
2. Click **Generate app password**
3. Select **Other app** and name it (e.g., "Claude MCP")
4. Copy the 16-character password (no spaces)

### 3. Environment Configuration

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
YAHOO_EMAIL=your.email@yahoo.com
YAHOO_APP_PASSWORD=your16charpassword
```

### 4. Configure Claude Desktop

Add this server to your Claude Desktop configuration:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`  
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "yahoo-mail": {
      "command": "node",
      "args": ["/path/to/yahoo-mail-mcp/server.js"],
      "env": {
        "YAHOO_EMAIL": "your.email@yahoo.com",
        "YAHOO_APP_PASSWORD": "your16charpassword"
      }
    }
  }
}
```

> **Note:** Replace `/path/to/yahoo-mail-mcp/server.js` with the actual path to your server.js file

### 5. Restart Claude Desktop

Completely close and reopen Claude Desktop to load the MCP server.

## Usage

Once configured, you can use these tools in Claude Desktop:

### List Recent Emails
```
List my recent emails
```

### Read Specific Email
```
Read email #5
```

### Search Emails
```
Search for emails from "github"
```

## Available Tools

- `list_emails` - List recent emails (default: 10, max: 50)
- `read_email` - Read full content of an email by sequence number
- `search_emails` - Search emails by subject or sender

## Troubleshooting

### "No supported authentication method" Error

This usually means:
1. IMAP is not enabled in Yahoo Mail settings
2. App password is incorrect or expired
3. Your Yahoo account requires additional security setup

### Server Not Appearing in Claude

1. Check the file path in your configuration is correct
2. Ensure Node.js is installed and accessible
3. Restart Claude Desktop completely
4. Check Claude Desktop logs for errors

### Verification

Test if your server works:

```bash
node server.js
```

Should output: `Yahoo Mail MCP server running on stdio`

## Security Notes

- This server only provides **read-only** access to your emails
- App passwords are more secure than using your main password
- Environment variables keep your credentials separate from code
- The server runs locally - your credentials don't leave your machine

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Verify your Yahoo Mail IMAP settings
3. Test the server independently with `node server.js`
4. Open an issue with error details and your configuration (remove credentials)