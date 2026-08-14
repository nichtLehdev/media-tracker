import type { z } from 'zod';

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...init.headers },
  });
}

export function problem(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error, ...extra }, { status });
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/**
 * Parses a JSON body against a Zod schema. Zod is the single source of truth
 * for these wire formats (S6), so validation failures are reported with the
 * field paths the plugin author needs to fix their DTO.
 */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: problem(400, 'invalid_json') };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: problem(400, 'invalid_body', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      }),
    };
  }
  return { ok: true, data: parsed.data };
}
