import { request, type IncomingHttpHeaders } from 'node:http';

export interface PresignedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface PresignedRequestOptions {
  method?: 'GET' | 'PUT' | 'HEAD';
  body?: Buffer;
  headers?: Record<string, string>;
}

/**
 * Performs an HTTP request against a presigned URL from inside the Compose
 * network. Client-facing URLs are signed for S3_PUBLIC_ENDPOINT (e.g.
 * localhost:9000), which is not reachable from a container; SigV4 signs the
 * Host header, so the request is sent to S3_ENDPOINT while preserving the
 * URL's original Host — exactly what a browser on the host machine would send.
 */
export function requestPresigned(
  url: string,
  options: PresignedRequestOptions = {},
): Promise<PresignedResponse> {
  const target = new URL(url);
  const internal = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');
  const { method = 'GET', body, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: internal.hostname,
        port: internal.port || 80,
        method,
        path: `${target.pathname}${target.search}`,
        headers: {
          ...headers,
          host: target.host,
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
