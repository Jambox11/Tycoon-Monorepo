import { RequestIdMiddleware } from './request-id.middleware';

/**
 * Minimal fakes so the middleware can be exercised without booting Nest.
 * Only the surface the middleware touches is implemented.
 */
function createRequest(headers: Record<string, unknown> = {}): any {
  return { headers };
}

function createResponse(): any {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
  };
}

const VALID_REQUEST_ID = 'abc12345-6789-4def-8abc-1234567890ab';
const REQUEST_ID_PATTERN = /^[\w-]{8,128}$/;

describe('RequestIdMiddleware', () => {
  let middleware: RequestIdMiddleware;

  beforeEach(() => {
    middleware = new RequestIdMiddleware();
  });

  it('echoes a valid inbound X-Request-Id unchanged on the response', () => {
    const req = createRequest({ 'x-request-id': VALID_REQUEST_ID });
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', VALID_REQUEST_ID);
    expect(res.headers['x-request-id']).toBe(VALID_REQUEST_ID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a fresh id when the inbound header is missing', () => {
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    const generated = res.headers['x-request-id'];
    expect(generated).toBeDefined();
    expect(generated).toMatch(REQUEST_ID_PATTERN);
    expect(generated).not.toBe(VALID_REQUEST_ID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a fresh id when the inbound header is malformed', () => {
    const req = createRequest({ 'x-request-id': 'bad id!' });
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    const generated = res.headers['x-request-id'];
    expect(generated).toBeDefined();
    expect(generated).toMatch(REQUEST_ID_PATTERN);
    expect(generated).not.toBe('bad id!');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
