# Yahoo Mail MCP Server Update Prompt

## Complete Prompt for Claude Code

I need to update my Yahoo Mail MCP server with the following improvements:

**PRIMARY OBJECTIVE:** Migrate from IMAP sequence numbers to UIDs for stable email identification

**BACKGROUND:**
- Current implementation uses sequence numbers which change when emails are deleted
- Need to use UIDs (permanent identifiers that don't change)
- Server runs on Render.com free tier (15-minute inactivity timeout)
- Used with Claude.ai for email analysis and management

---

## PART 1: CORE UID MIGRATION

### 1. Replace all sequenceNumbers with uids

- Update all tool parameters from `sequenceNumbers: number[]` to `uids: number[]`
- Add `byUid: true` flag to all imap.fetch() operations
- Update parameter descriptions to explain UIDs are permanent identifiers

### 2. Update list_emails response

- Return BOTH `uid` and `sequenceNumber` for each email
- Format: `{ uid: 12345, sequenceNumber: 42, from: "...", subject: "...", date: "..." }`
- This allows clients to use UIDs while maintaining visibility of sequence numbers

### 3. Update all email management tools to use UIDs

Tools to update: read_email, delete_emails, archive_emails, flag_emails, unflag_emails, mark_as_read, mark_as_unread, move_emails

For each tool:
- Change parameter from `sequenceNumbers` to `uids`
- Add `byUid: true` to all imap.fetch/copy/addFlags/delFlags operations
- Update tool descriptions to mention UIDs

### 4. Update search_emails

- Return UIDs in results instead of sequence numbers
- Maintain same output format as list_emails (include both uid and sequenceNumber)
- Add optional parameters:
  * `dateFrom` (ISO 8601 date string)
  * `dateTo` (ISO 8601 date string)
  * `sender` (email address or name)
  * `unreadOnly` (boolean)

### 5. Improve error handling

- Add clear error messages when UIDs don't exist (e.g., "Email with UID 12345 not found")
- Handle authentication errors with descriptive messages
- Add specific error for when Render service was sleeping: "Service was inactive. Please try again."
- Validate that UIDs are valid positive integers
- Handle IMAP timeout errors gracefully

---

## PART 2: ADDITIONAL FEATURES

### 6. Add list_folders tool

```typescript
interface ListFoldersResponse {
  folders: Array<{
    name: string;
    delimiter: string;
    flags: string[];
  }>;
}
```

- Lists all available IMAP folders
- Helps users discover what folders they can move emails to
- Include common folders: INBOX, Sent, Trash, Archive, etc.

### 7. Add simple /health endpoint (CRITICAL)

```javascript
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    version: '1.0.0'  // or from package.json
  });
});
```

- Does NOT require IMAP connection
- Responds immediately with server status
- Used by external ping services to prevent Render spindown
- Should be lightweight and always succeed

### 8. Enrich email metadata in list_emails and search_emails

Add these fields to each email object:
- `size`: number (message size in bytes)
- `hasAttachments`: boolean
- `flags`: string[] (e.g., ["\\Seen", "\\Flagged"])
- `labels`: string[] (if available from IMAP)

### 9. Add pagination support to list_emails

- Add `offset` parameter (default: 0)
- Add `limit` parameter (default: 10, max: 50)
- Return `totalCount` in response
- Format response:

```typescript
{
  emails: [...],
  totalCount: number,
  offset: number,
  limit: number
}
```

### 10. Improve date handling

- Ensure ALL dates are returned in ISO 8601 format
- Include timezone information
- Example: "2025-12-17T13:19:04+00:00"

### 11. Add folder parameter to list_emails

- Default to "INBOX" if not specified
- Allow users to list emails from other folders
- Validate folder exists before attempting to select it

---

## PART 3: TOOL DESCRIPTIONS & DOCUMENTATION

### 12. Update all tool descriptions

For each tool, clearly explain:
- What UIDs are: "UIDs are permanent identifiers that don't change when emails are deleted"
- Difference from sequence numbers: "Unlike sequence numbers, UIDs remain stable"
- Provide usage examples in descriptions

Example for read_email:
```
Read email content using UIDs (permanent identifiers). UIDs don't change when 
emails are deleted, making them reliable for referencing specific emails.

Example: To read emails with UIDs 12345 and 12346:
{ "uids": [12345, 12346] }
```

### 13. Add error response documentation

Document common error scenarios:
- Authentication failed
- UID not found
- Folder doesn't exist
- Connection timeout
- Service was sleeping (Render spindown)

---

## PART 4: README UPDATES

### 14. Add comprehensive "Keeping Your Server Alive" section to README.md

```markdown
# Yahoo Mail MCP Server

[... existing README content ...]

## 🚀 Deployment on Render.com

### Free Tier Limitations

Render.com's free tier is excellent for this project, but has one important limitation:
- **Services spin down after 15 minutes of inactivity**
- **Cold start takes 30-60 seconds** when service wakes up
- **750 free hours per month** (31.25 days of 24/7 uptime)

This means if you don't use the server for 15 minutes, the next request will be slow as Render wakes it up.

### Solution: Keep Your Server Alive 24/7 (Free!)

Use a free external ping service to keep your server awake. This is a common, accepted practice for Render's free tier.

#### Recommended Services (All Free):

**Option 1: UptimeRobot** ⭐ Recommended
1. Sign up at https://uptimerobot.com (free account)
2. Click "Add New Monitor"
3. Configure:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: Yahoo Mail MCP Server
   - **URL**: `https://your-service-name.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
4. Click "Create Monitor"

**Benefits**: Also monitors uptime and alerts you if service goes down!

**Option 2: Cron-job.org**
1. Sign up at https://cron-job.org
2. Create new cron job
3. Configure:
   - **URL**: `https://your-service-name.onrender.com/health`
   - **Schedule**: Every 10 minutes
   - **Method**: GET

**Option 3: Render KeepAlive (Purpose-Built)**
1. Visit https://dashdashhard.com/keepalive
2. Enter your service endpoint: `https://your-service-name.onrender.com/health`
3. Click "Keep Alive"

**Benefits**: Built specifically for Render, no account needed!

#### How It Works

The `/health` endpoint is a lightweight endpoint that:
- ✅ Responds instantly (no IMAP connection needed)
- ✅ Returns server status: `{ status: "ok", uptime: 12345, timestamp: "..." }`
- ✅ Prevents Render from spinning down your service
- ✅ Uses minimal resources (milliseconds per ping)

#### Why External Ping Instead of Self-Ping?

External ping services are better because they:
- Provide monitoring AND keep-alive in one tool
- Alert you if the service actually goes down
- Don't add code complexity to your server
- Can manage multiple services from one dashboard
- Are completely free for hobby projects

#### Free Tier Math

With a ping every 5 minutes:
- 12 pings/hour × 24 hours = 288 pings/day
- Each ping uses ~50ms of compute time
- 288 × 0.05 seconds = 14.4 seconds/day of compute
- Monthly: 14.4s × 31 days = 446 seconds = **7.4 minutes of the 750 hours**

**You'll use less than 1% of your free hours for keep-alive pings!**

### Testing Your Setup

After configuring your ping service:

1. **Wait 20 minutes** (let service spin down naturally)
2. **Make a request** to your MCP server via Claude
3. **Should respond quickly** (not a cold start delay)
4. Check your ping service dashboard to confirm it's working

### Troubleshooting

**Service still spinning down?**
- Verify ping URL is correct: `https://your-service-name.onrender.com/health`
- Check ping interval is under 15 minutes (recommend 5-10 minutes)
- Confirm ping service is actually sending requests (check logs)

**Still experiencing delays?**
- First request after spindown will always take 30-60 seconds
- Subsequent requests should be fast
- Check Render logs to see when service last received traffic

## 🔧 API Endpoints

### Health Check
```
GET /health
```
Returns server status without requiring IMAP connection.

**Response:**
```json
{
  "status": "ok",
  "uptime": 12345,
  "timestamp": "2025-12-17T13:19:04+00:00",
  "version": "1.0.0"
}
```

### MCP Server Endpoint (SSE)
```
/mcp/sse
```
Server-Sent Events endpoint for MCP protocol communication.

[... rest of README ...]
```

### 15. Add Migration Guide section to README

```markdown
## 📦 Migration Guide: Sequence Numbers → UIDs

### What Changed in v2.0?

We migrated from IMAP sequence numbers to UIDs for more reliable email identification.

**Old way (v1.x):**
```json
{
  "sequenceNumbers": [42, 43, 44]
}
```

**New way (v2.0+):**
```json
{
  "uids": [12345, 12346, 12347]
}
```

### Why UIDs?

**Problem with sequence numbers:**
- Email #42 becomes #41 when you delete email #1
- References break after deletions
- Unreliable for async operations

**Solution with UIDs:**
- UID 12345 is always UID 12345
- Never changes, even after deletions
- Stable across sessions

### How to Migrate

**Step 1:** Update your code to use `uids` parameter instead of `sequenceNumbers`

**Step 2:** Get UIDs from `list_emails` or `search_emails`:
```json
{
  "emails": [
    {
      "uid": 12345,           // ← Use this
      "sequenceNumber": 42,   // ← Legacy reference
      "from": "...",
      "subject": "..."
    }
  ]
}
```

**Step 3:** Use UIDs in all operations:
- `read_email({ uids: [12345, 12346] })`
- `delete_emails({ uids: [12345] })`
- `mark_as_read({ uids: [12345, 12346, 12347] })`

### Backward Compatibility

For now, `list_emails` returns BOTH `uid` and `sequenceNumber` for each email. However:
- ⚠️ Only use `uid` for subsequent operations
- ⚠️ `sequenceNumber` is provided for reference only
- ⚠️ Future versions may remove `sequenceNumber` entirely
```

### 16. Add Usage Examples section

```markdown
## 💡 Usage Examples

### Example 1: List and Read Emails
```javascript
// Step 1: List recent emails
const emails = await list_emails({ count: 10 });

// Step 2: Get UIDs from results
const uids = emails.emails.map(e => e.uid);

// Step 3: Read specific emails using UIDs
const content = await read_email({ uids: [uids[0], uids[1]] });
```

### Example 2: Search and Archive
```javascript
// Search for emails from a specific sender
const results = await search_emails({ 
  query: "sender@example.com",
  count: 20 
});

// Archive all matching emails
const uids = results.emails.map(e => e.uid);
await archive_emails({ uids });
```

### Example 3: Find Emails by Date Range
```javascript
// Find emails from last week
const lastWeek = new Date();
lastWeek.setDate(lastWeek.getDate() - 7);

const emails = await search_emails({
  query: "newsletter",
  dateFrom: lastWeek.toISOString(),
  dateTo: new Date().toISOString()
});
```

### Example 4: Batch Process Unread Emails
```javascript
// Get all unread emails
const unread = await search_emails({ 
  query: "",
  unreadOnly: true,
  count: 50 
});

// Process and mark as read
const uids = unread.emails.map(e => e.uid);
await mark_as_read({ uids });
```

### Example 5: Move Emails to Folder
```javascript
// List available folders
const folders = await list_folders();
console.log(folders); // ["INBOX", "Sent", "Archive", "Work", ...]

// Move emails to Work folder
await move_emails({ 
  uids: [12345, 12346], 
  folderName: "Work" 
});
```
```

---

## PART 5: TESTING REQUIREMENTS

### 17. Comprehensive testing checklist

- ✅ list_emails returns both uid and sequenceNumber
- ✅ read_email works with multiple UIDs
- ✅ read_email fails gracefully for non-existent UIDs
- ✅ delete_emails works with UIDs
- ✅ UIDs remain stable after deleting other emails
- ✅ search_emails returns UIDs
- ✅ search_emails date filtering works correctly
- ✅ list_folders returns available folders
- ✅ move_emails works with folder names
- ✅ /health endpoint responds without IMAP connection
- ✅ /health endpoint is fast (<100ms)
- ✅ All dates in ISO 8601 format with timezone
- ✅ Pagination works correctly (offset/limit)
- ✅ Error messages are clear and actionable

---

## FINAL NOTES

- Prioritize stability and clear error messages
- Maintain backward compatibility where reasonable
- All dates MUST be ISO 8601 with timezone
- The /health endpoint should be extremely lightweight
- Document everything clearly in README
- Include practical usage examples
- Test thoroughly before considering complete

**Please implement these changes systematically, testing each section before moving to the next.**