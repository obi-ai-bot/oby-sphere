// The Sphere's HTTP API (spec/sphere-api.md section 2): routing and error answers.

import type { Deps, Env } from "./env.ts";
import { ApiError, INTERNAL_MESSAGE, apiError, errorResponse } from "./http.ts";
import { tokenEndpoint } from "./oauth.ts";
import { audit } from "./routes/audit.ts";
import { openChannel } from "./routes/channels.ts";
import { deleteDevice, deleteRelay, openRelay, putDevice, putRelay } from "./routes/relays.ts";
import { deleteRunner, putRunner } from "./routes/runner.ts";
import { getMemberRoute, invite, listInvitations, listMembers, previewInvitation, redeem, revoke, updateCard, withdrawInvitation } from "./routes/members.ts";
import { ack, deliveries, send } from "./routes/messages.ts";
import { getPolicy, putPolicy } from "./routes/policy.ts";
import { post, posts } from "./routes/room.ts";
import { createSphere, deleteAdmin, deleteImage, deleteSphere, getImage, getSphereRoute, health, joinPage, putAdmin, putImage, updateSphere } from "./routes/spheres.ts";
import { finishSignIn, startSignIn } from "./signin.ts";

type Handler = (request: Request, env: Env, deps: Deps, ...params: string[]) => Promise<Response> | Response;

const SEGMENT = "([^/]+)";
const ROUTES: [string, RegExp, Handler][] = [
  ["GET", /^\/v0\.1\/health$/, health],
  ["GET", /^\/join$/, joinPage],
  ["POST", /^\/v0\.1\/spheres$/, createSphere],
  ["POST", /^\/v0\.1\/oauth\/token$/, tokenEndpoint],
  ["POST", /^\/v0\.1\/signin\/google$/, startSignIn],
  ["POST", /^\/v0\.1\/signin\/google\/callback$/, finishSignIn],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}$`), getSphereRoute],
  ["PATCH", new RegExp(`^/v0\\.1/spheres/${SEGMENT}$`), updateSphere],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}$`), deleteSphere],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/image$`), getImage],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/image$`), putImage],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/image$`), deleteImage],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/admins/${SEGMENT}$`), putAdmin],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/admins/${SEGMENT}$`), deleteAdmin],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations$`), listInvitations],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations$`), invite],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations/${SEGMENT}$`), withdrawInvitation],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations/${SEGMENT}/preview$`), previewInvitation],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/invitations/${SEGMENT}/redeem$`), redeem],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members$`), listMembers],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}$`), getMemberRoute],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}/card$`), updateCard],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}$`), revoke],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/policy$`), getPolicy],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/policy$`), putPolicy],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/messages$`), send],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/deliveries$`), deliveries],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/deliveries/ack$`), ack],
  ["POST", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/room/posts$`), post],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/room/posts$`), posts],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/audit$`), audit],
  ["GET", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/channels/${SEGMENT}$`), openChannel],
  ["PUT", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}/runner$`), putRunner],
  ["DELETE", new RegExp(`^/v0\\.1/spheres/${SEGMENT}/members/${SEGMENT}/runner$`), deleteRunner],
  ["PUT", new RegExp(`^/v0\\.1/relay/${SEGMENT}$`), putRelay],
  ["DELETE", new RegExp(`^/v0\\.1/relay/${SEGMENT}$`), deleteRelay],
  ["GET", new RegExp(`^/v0\\.1/relay/${SEGMENT}$`), openRelay],
  ["PUT", new RegExp(`^/v0\\.1/relay/${SEGMENT}/devices/${SEGMENT}$`), putDevice],
  ["DELETE", new RegExp(`^/v0\\.1/relay/${SEGMENT}/devices/${SEGMENT}$`), deleteDevice],
];

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    for (const [method, pattern, handler] of ROUTES) {
      const m = pattern.exec(path);
      if (!m || method !== request.method) continue;
      const params = m.slice(1).map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          throw apiError("not_found", "no such resource");
        }
      });
      return await handler(request, env, deps, ...params);
    }
    throw apiError("not_found", "no such endpoint");
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    // Never echo what failed: it may hold what a client sent. The cause stays in the Worker's own log.
    console.error("sphere: internal error", e instanceof Error ? e.name : typeof e);
    return errorResponse(apiError("internal", INTERNAL_MESSAGE));
  }
}
