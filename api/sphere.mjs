// The Sphere on Vercel: vercel.json rewrites every path here (as ?__path=), and
// the relay's own request handler answers it, on the Redis store (Upstash).
// There is no single process: each instance replays the log from Redis and
// appends to it with a compare-and-append, so they act as one Sphere.
export { default } from '../server.mjs';
