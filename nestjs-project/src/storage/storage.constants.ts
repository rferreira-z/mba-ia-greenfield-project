/** S3 client bound to S3_ENDPOINT — server-side calls inside the Compose network. */
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

/**
 * S3 client bound to S3_PUBLIC_ENDPOINT — used only to presign URLs handed to
 * clients. SigV4 signs the Host header, so these URLs must carry the host the
 * client will actually reach (phase-03-videos/TD-03).
 */
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');
