#!/usr/bin/env node
/**
 * Email MCP Server — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   http      Run as MCP server over Streamable HTTP
 *   setup     Interactive account setup wizard
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init)
 *   scheduler Email scheduling management
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config/loader.js';
import ConnectionManager from './connections/manager.js';
import { bindServer, markInitialized, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';

const HELP = `
email-mcp — Email MCP Server (IMAP + SMTP)

Usage:
  email-mcp [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  http        Run as MCP server over Streamable HTTP (requires MCP_EMAIL_HTTP_TOKEN)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, path, init)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Environment variables (http mode):
  MCP_EMAIL_HTTP_TOKEN   Required. Shared secret for HTTP transport authentication.
  MCP_EMAIL_HTTP_PORT    Optional. Port to listen on (default: 3000).

Examples:
  email-mcp                         # Start MCP server (stdio)
  email-mcp http                     # Start MCP server (HTTP, requires MCP_EMAIL_HTTP_TOKEN)
  email-mcp account list             # List configured accounts
  email-mcp account add              # Add a new email account
  email-mcp account edit personal    # Edit an account
  email-mcp account delete work      # Delete an account
  email-mcp setup                    # Alias for account add
  email-mcp test                     # Test all accounts
  email-mcp test personal            # Test specific account
  email-mcp install                  # Register with detected MCP clients
  email-mcp install status           # Show client registration status
  email-mcp install remove           # Unregister from MCP clients
  email-mcp config show              # Show config (passwords masked)
  email-mcp config edit              # Edit global settings
  email-mcp config path              # Print config file path
  email-mcp config init              # Create template config
  email-mcp scheduler check          # Send overdue scheduled emails
  email-mcp scheduler install        # Install OS periodic check
  email-mcp notify test              # Send a test notification
  email-mcp notify status            # Check notification platform support
`.trim();

async function runServer(): Promise<void> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  const server = createServer();
  bindServer(server);

  registerAllTools(
    server,
    connections,
    imapService,
    smtpService,
    config,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
  );
  registerAllResources(server, connections, imapService, templateService, schedulerService);
  registerAllPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Post-handshake initialization ----------------------------------------
  // Everything below is deferred until the client completes the MCP
  // `initialize` / `initialized` handshake.  This prevents notifications
  // from being written to stdout before the client is ready, which would
  // crash clients like Vibe, and ensures `getClientCapabilities()` returns
  // the real capabilities (including `sampling` support).
  // --------------------------------------------------------------------------

  let schedulerInterval: ReturnType<typeof setInterval> | undefined;

  const lowLevelServer = server.server;

  lowLevelServer.oninitialized = () => {
    markInitialized();

    // eslint-disable-next-line no-void
    void (async () => {
      try {
        const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
        hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });

        await watcherService.start();

        await mcpLog('info', 'server', 'Email MCP server started');

        // Check for overdue scheduled emails on startup
        try {
          const result = await schedulerService.checkAndSend();
          if (result.sent > 0) {
            await mcpLog('info', 'scheduler', `Sent ${result.sent} overdue email(s) on startup`);
          }
        } catch {
          // Non-fatal: scheduler check failure shouldn't prevent server start
        }

        // Periodic scheduler check every 60 seconds
        schedulerInterval = setInterval(async () => {
          try {
            await schedulerService.checkAndSend();
          } catch {
            // Silent — don't spam logs
          }
        }, 60_000);
      } catch (err) {
        // Log to stderr — mcpLog may not be safe if init itself errored
        process.stderr.write(
          `[email-mcp] post-init error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  };

  // Graceful shutdown
  const shutdown = async () => {
    if (schedulerInterval) clearInterval(schedulerInterval);
    hooksService.stop();
    await watcherService.stop();
    await connections.closeAll();
    await server.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// HTTP transport helpers
// ---------------------------------------------------------------------------

/**
 * Validate the `token` query-parameter against the server secret.
 *
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @returns `true` when the token is present and matches.
 */
// eslint-disable-next-line import-x/prefer-default-export
export function validateToken(url: string | undefined, expectedToken: string): boolean {
  if (!url) return false;
  const parsed = new URL(url, 'http://localhost');
  const provided = parsed.searchParams.get('token') ?? '';
  if (provided.length === 0) return false;

  // Constant-time comparison
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expectedToken);
  if (a.byteLength !== b.byteLength) return false;

  // Use a simple constant-time comparison loop
  let mismatch = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    // eslint-disable-next-line no-bitwise
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------------
// HTTP transport mode
// ---------------------------------------------------------------------------

async function runHttpServer(): Promise<void> {
  const token = process.env.MCP_EMAIL_HTTP_TOKEN;
  if (!token || token.length === 0) {
    throw new Error(
      'MCP_EMAIL_HTTP_TOKEN environment variable is required for HTTP transport.\n' +
        'Set it to a secret string that clients must pass as ?token=<secret>.',
    );
  }

  const port = parseInt(process.env.MCP_EMAIL_HTTP_PORT ?? '3000', 10);

  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  // -- Express app -------------------------------------------------------------
  // Pass host: '::' to disable the SDK's localhost-only DNS rebinding
  // protection AND enable dual-stack (IPv4 + IPv6) listening.  Without this
  // the Host-header validation middleware rejects every request whose Host is
  // not localhost / 127.0.0.1 / [::1], silently blocking remote MCP clients.
  // Security is already provided by the token query-parameter check below.
  const { createMcpExpressApp } = await import('@modelcontextprotocol/sdk/server/express.js');
  // Suppress the SDK's "binding to :: without DNS rebinding protection"
  // warning — we intentionally accept remote hosts and rely on token auth.
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('DNS rebinding protection')) return;
    origWarn.apply(console, args as Parameters<typeof console.warn>);
  };
  const app = createMcpExpressApp({ host: '::' });
  console.warn = origWarn;

  // -- CORS -------------------------------------------------------------------
  // Allow browser-based and remote MCP clients (e.g. Claude.ai) to connect.
  const cors = (await import('cors')).default;
  type RouteFn = (path: string, ...handlers: unknown[]) => void;
  const expressApp = app as unknown as {
    use: (...handlers: unknown[]) => void;
    post: RouteFn;
    get: RouteFn;
    delete: RouteFn;
    options: RouteFn;
  };
  expressApp.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-Id', 'Accept'],
      exposedHeaders: ['mcp-session-id'],
    }),
  );

  // -- Session → transport map ------------------------------------------------
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // -- JSON-RPC error helper --------------------------------------------------
  type NextFn = (err?: unknown) => void;
  type ExpressRes = ServerResponse & {
    status: (code: number) => ExpressRes;
    json: (body: unknown) => ExpressRes;
    send: (body: string) => ExpressRes;
    headersSent: boolean;
  };

  function sendJsonRpcError(
    res: ServerResponse,
    statusCode: number,
    code: number,
    message: string,
  ): void {
    (res as ExpressRes).status(statusCode).json({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    });
  }

  // -- Token-checking middleware (applies to /mcp only) -----------------------
  const requireToken = (req: IncomingMessage, res: ServerResponse, next: NextFn): void => {
    if (!validateToken(req.url, token)) {
      process.stderr.write(
        `[email-mcp] 401 ${req.method} ${req.url?.split('?')[0]} — invalid or missing token\n`,
      );
      sendJsonRpcError(res, 401, -32000, 'Unauthorized: invalid or missing token');
      return;
    }
    next();
  };

  // -- MCP POST handler -------------------------------------------------------
  const mcpPostHandler = async (
    req: IncomingMessage & { body?: unknown },
    res: ServerResponse,
  ): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const server = createServer();
        bindServer(server);

        registerAllTools(
          server,
          connections,
          imapService,
          smtpService,
          config,
          templateService,
          calendarService,
          localCalendarService,
          remindersService,
          schedulerService,
          watcherService,
          hooksService,
        );
        registerAllResources(server, connections, imapService, templateService, schedulerService);
        registerAllPrompts(server);

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
            process.stderr.write(`[email-mcp] session created: ${sid}\n`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            process.stderr.write(`[email-mcp] session closed: ${sid}\n`);
          }
        };

        transport.onerror = (err: Error) => {
          const sid = transport.sessionId ?? 'unknown';
          process.stderr.write(`[email-mcp] transport error (session ${sid}): ${err.message}\n`);
        };

        await server.connect(transport);

        // Post-handshake: start hooks/watcher/scheduler per session
        const lowLevelServer = server.server;
        lowLevelServer.oninitialized = () => {
          markInitialized();
          // eslint-disable-next-line no-void
          void (async () => {
            try {
              const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
              hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });
              await watcherService.start();
            } catch {
              // non-fatal
            }
          })();
        };

        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!(res as ExpressRes).headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal server error');
      }
    }
  };

  // -- MCP GET handler (SSE streams) ------------------------------------------
  const mcpGetHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      (res as ExpressRes).status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  // -- MCP DELETE handler (session termination) -------------------------------
  const mcpDeleteHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      (res as ExpressRes).status(400).send('Invalid or missing session ID');
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch {
      if (!(res as ExpressRes).headersSent) {
        (res as ExpressRes).status(500).send('Error processing session termination');
      }
    }
  };

  // -- Register routes --------------------------------------------------------
  expressApp.post('/mcp', requireToken, mcpPostHandler);
  expressApp.get('/mcp', requireToken, mcpGetHandler);
  expressApp.delete('/mcp', requireToken, mcpDeleteHandler);

  // Health-check endpoint (no token required) — useful for load-balancer probes.
  expressApp.get('/health', (_req: unknown, res: unknown) => {
    (res as ExpressRes).status(200).json({ status: 'ok', version: PKG_VERSION });
  });

  // -- Scheduler (runs regardless of active sessions) -------------------------
  try {
    const result = await schedulerService.checkAndSend();
    if (result.sent > 0) {
      process.stderr.write(`[email-mcp] Sent ${result.sent} overdue email(s) on startup\n`);
    }
  } catch {
    // Non-fatal
  }

  const schedulerInterval = setInterval(async () => {
    try {
      await schedulerService.checkAndSend();
    } catch {
      // Silent
    }
  }, 60_000);

  // -- Start HTTP server ------------------------------------------------------
  // Express app is a callable (req, res) => void compatible with Node's http.createServer,
  // but its TypeScript type doesn't directly match Node's RequestListener signature.
  const httpServer = createHttpServer(
    app as unknown as (req: IncomingMessage, res: ServerResponse) => void,
  );

  // Increase timeouts for long-lived SSE connections.  The Node.js defaults
  // (keepAliveTimeout 5 s, headersTimeout 60 s, requestTimeout 5 min) are far
  // too short for MCP SSE streams that may stay open for the entire session.
  // Setting to 0 disables the timeout so the connections stay open until the
  // client disconnects or the server shuts down.
  httpServer.keepAliveTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;

  // Log server-level errors so that they're not silently swallowed.
  httpServer.on('error', (err: Error) => {
    process.stderr.write(`[email-mcp] HTTP server error: ${err.message}\n`);
  });

  // Listen on '::' for dual-stack IPv4 + IPv6 support (important when
  // connecting via DNS which may resolve to either protocol).
  httpServer.listen(port, '::', () => {
    process.stderr.write(`[email-mcp] Streamable HTTP server listening on [::]:${port}\n`);
    process.stderr.write(`[email-mcp] Endpoint: http://<host>:${port}/mcp?token=<secret>\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(schedulerInterval);
    hooksService.stop();
    await watcherService.stop();

    await Promise.allSettled(
      Object.keys(transports).map(async (sid) => {
        await transports[sid].close();
        delete transports[sid];
      }),
    );

    await connections.closeAll();
    httpServer.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';

  switch (command) {
    case 'stdio':
      await runServer();
      break;

    case 'http':
      await runHttpServer();
      break;

    case 'setup': {
      const { default: runSetup } = await import('./cli/setup.js');
      await runSetup();
      break;
    }

    case 'account': {
      const { default: runAccountCommand } = await import('./cli/account-commands.js');
      await runAccountCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'test': {
      const { default: runTest } = await import('./cli/test.js');
      await runTest(process.argv[3]);
      break;
    }

    case 'config': {
      const { default: runConfigCommand } = await import('./cli/config-commands.js');
      await runConfigCommand(process.argv[3]);
      break;
    }

    case 'install': {
      const { default: runInstallCommand } = await import('./cli/install-commands.js');
      await runInstallCommand(process.argv[3]);
      break;
    }

    case 'scheduler': {
      const { default: runSchedulerCommand } = await import('./cli/scheduler.js');
      await runSchedulerCommand(process.argv[3]);
      break;
    }

    case 'notify': {
      const { default: runNotifyCommand } = await import('./cli/notify.js');
      await runNotifyCommand(process.argv[3]);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
