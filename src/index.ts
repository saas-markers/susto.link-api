import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { Pool, PoolClient } from 'pg';

interface LinkShareRow {
  id: number;
  base_url: string;
  subdomain: string;
  resource_id: string;
  max_shares: number;
  remaining_shares: number;
  allow_repeat: boolean;
}

interface LinkAccessResult {
  allowed: boolean;
  remainingShares: number;
  maxShares: number;
  repeatAccessAllowed: boolean;
  visitsForToken?: number;
  isNewVisitor?: boolean;
  reason?: string;
  message?: string;
}

class HttpError extends Error {
  public status: number;
  public body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : 'Request failed');
    this.status = status;
    this.body = body;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeRepeatAccess(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable must be set to connect to PostgreSQL.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS link_shares (
      id BIGSERIAL PRIMARY KEY,
      base_url TEXT NOT NULL,
      subdomain TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      max_shares INTEGER NOT NULL,
      remaining_shares INTEGER NOT NULL,
      allow_repeat BOOLEAN NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(base_url, subdomain, resource_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS link_visits (
      link_id BIGINT NOT NULL REFERENCES link_shares(id) ON DELETE CASCADE,
      token TEXT NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (link_id, token)
    );
  `);
}

async function withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const app = express();
app.use(express.json());
app.use(cookieParser());

const asyncHandler = <TRequest extends Request, TResponse extends Response>(
  fn: (req: TRequest, res: TResponse, next: NextFunction) => Promise<void>,
) => {
  return (req: TRequest, res: TResponse, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
};

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.post(
  '/links/access',
  asyncHandler(async (req: Request, res: Response) => {
    const { baseUrl, subdomain, id, maxShares, allowRepeatAccess = true } = req.body ?? {};
    const token: string | undefined = req.cookies?.token;

    if (!token) {
      res.status(401).json({
        allowed: false,
        reason: 'missingToken',
        message: 'A "token" cookie is required to evaluate link access.',
      });
      return;
    }

    if (!isNonEmptyString(baseUrl) || !isNonEmptyString(subdomain) || !isNonEmptyString(id)) {
      res.status(400).json({
        allowed: false,
        reason: 'invalidPayload',
        message: '"baseUrl", "subdomain" and "id" must be non-empty strings.',
      });
      return;
    }

    if (typeof maxShares !== 'number' || !Number.isInteger(maxShares) || maxShares <= 0) {
      res.status(400).json({
        allowed: false,
        reason: 'invalidPayload',
        message: '"maxShares" must be a positive integer.',
      });
      return;
    }

    try {
      const result = await withTransaction<LinkAccessResult>(async (client) => {
        const linkQuery = await client.query<LinkShareRow>(
          `SELECT id, base_url, subdomain, resource_id, max_shares, remaining_shares, allow_repeat
             FROM link_shares
            WHERE base_url = $1 AND subdomain = $2 AND resource_id = $3
            FOR UPDATE`,
          [baseUrl, subdomain, id],
        );

        let linkRecord = linkQuery.rows[0];
        const normalizedRepeat = normalizeRepeatAccess(allowRepeatAccess, linkRecord?.allow_repeat ?? true);

        if (!linkRecord) {
          const inserted = await client.query<LinkShareRow>(
            `INSERT INTO link_shares (base_url, subdomain, resource_id, max_shares, remaining_shares, allow_repeat)
             VALUES ($1, $2, $3, $4, $4, $5)
             RETURNING id, base_url, subdomain, resource_id, max_shares, remaining_shares, allow_repeat`,
            [baseUrl, subdomain, id, maxShares, normalizedRepeat],
          );
          linkRecord = inserted.rows[0];
        } else {
          if (linkRecord.max_shares !== maxShares) {
            throw new HttpError(409, {
              allowed: false,
              reason: 'conflictingLimit',
              message: `Link already registered with a max share count of ${linkRecord.max_shares}.`,
              remainingShares: linkRecord.remaining_shares,
              maxShares: linkRecord.max_shares,
              repeatAccessAllowed: linkRecord.allow_repeat,
            });
          }

          if (linkRecord.allow_repeat !== normalizedRepeat) {
            const updated = await client.query<LinkShareRow>(
              `UPDATE link_shares
                  SET allow_repeat = $1
                WHERE id = $2
                RETURNING id, base_url, subdomain, resource_id, max_shares, remaining_shares, allow_repeat`,
              [normalizedRepeat, linkRecord.id],
            );
            linkRecord = updated.rows[0];
          }
        }

        if (linkRecord.remaining_shares <= 0) {
          throw new HttpError(403, {
            allowed: false,
            reason: 'shareLimitReached',
            message: 'Share limit reached for this link.',
            remainingShares: 0,
            maxShares: linkRecord.max_shares,
            repeatAccessAllowed: linkRecord.allow_repeat,
          });
        }

        const visitQuery = await client.query<{ visit_count: number }>(
          `SELECT visit_count FROM link_visits WHERE link_id = $1 AND token = $2`,
          [linkRecord.id, token],
        );
        const previousVisits = visitQuery.rows[0]?.visit_count ?? 0;

        if (!linkRecord.allow_repeat && previousVisits > 0) {
          throw new HttpError(403, {
            allowed: false,
            reason: 'repeatAccessNotAllowed',
            message: 'Repeat access by the same token is disabled for this link.',
            remainingShares: linkRecord.remaining_shares,
            maxShares: linkRecord.max_shares,
            repeatAccessAllowed: linkRecord.allow_repeat,
            visitsForToken: previousVisits,
          });
        }

        const isFirstAccess = previousVisits === 0;

        if (isFirstAccess && linkRecord.remaining_shares <= 0) {
          throw new HttpError(403, {
            allowed: false,
            reason: 'shareLimitReached',
            message: 'Share limit reached for this link.',
            remainingShares: 0,
            maxShares: linkRecord.max_shares,
            repeatAccessAllowed: linkRecord.allow_repeat,
            visitsForToken: previousVisits,
          });
        }

        const newVisitCount = previousVisits + 1;

        await client.query(
          `INSERT INTO link_visits (link_id, token, visit_count)
           VALUES ($1, $2, $3)
           ON CONFLICT (link_id, token) DO UPDATE
             SET visit_count = EXCLUDED.visit_count`,
          [linkRecord.id, token, newVisitCount],
        );

        if (isFirstAccess) {
          const updateShare = await client.query<LinkShareRow>(
            `UPDATE link_shares
                SET remaining_shares = remaining_shares - 1
              WHERE id = $1 AND remaining_shares > 0
              RETURNING id, base_url, subdomain, resource_id, max_shares, remaining_shares, allow_repeat`,
            [linkRecord.id],
          );

          if (updateShare.rowCount === 0) {
            throw new HttpError(403, {
              allowed: false,
              reason: 'shareLimitReached',
              message: 'Share limit reached for this link.',
              remainingShares: 0,
              maxShares: linkRecord.max_shares,
              repeatAccessAllowed: linkRecord.allow_repeat,
              visitsForToken: previousVisits,
            });
          }

          const updatedLink = updateShare.rows[0];

          return {
            allowed: true,
            remainingShares: updatedLink.remaining_shares,
            maxShares: updatedLink.max_shares,
            repeatAccessAllowed: updatedLink.allow_repeat,
            visitsForToken: newVisitCount,
            isNewVisitor: true,
          };
        }

        return {
          allowed: true,
          remainingShares: linkRecord.remaining_shares,
          maxShares: linkRecord.max_shares,
          repeatAccessAllowed: linkRecord.allow_repeat,
          visitsForToken: newVisitCount,
          isNewVisitor: false,
        };
      });

      res.json(result);
      return;
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json(error.body);
        return;
      }

      throw error;
    }
  }),
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error handling request', err);
  res.status(500).json({
    allowed: false,
    reason: 'serverError',
    message: 'An unexpected error occurred while processing the request.',
  });
});

const port = Number(process.env.PORT ?? 3000);

export async function startServer(): Promise<void> {
  await initDb();
  return new Promise((resolve) => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Share limit API listening on port ${port}`);
      resolve();
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server', err);
    process.exit(1);
  });
}

export default app;
export { pool };
