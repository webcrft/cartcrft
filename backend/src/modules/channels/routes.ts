/**
 * channels/routes.ts — outbound channel sync admin endpoints.
 *
 *   GET    /commerce/stores/:storeId/channels                       (read)  — list channel syncs
 *   PUT    /commerce/stores/:storeId/channels/:channel              (write) — enable/configure a channel
 *   DELETE /commerce/stores/:storeId/channels/:channel              (admin) — remove a channel sync
 *   GET    /commerce/stores/:storeId/channels/:channel/items        (read)  — per-product sync state
 *   POST   /commerce/stores/:storeId/channels/:channel/sync         (admin) — trigger a manual sync
 *
 * Auth mirrors other commerce modules: storeAuthRead/Write/Admin pull the
 * tenant-scoped storeId off request.auth (never the URL param) for the DB calls.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  storeAuthRead,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import { isChannelName } from "./types.js";
import {
  listChannelSyncs,
  getChannelSync,
  upsertChannelSync,
  deleteChannelSync,
  listChannelSyncItems,
  runChannelSync,
} from "./service.js";

const ChannelParam = z.object({ channel: z.string().min(1) });

const UpsertBody = z.object({
  is_active: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const SyncBody = z.object({
  mode: z.enum(["products", "inventory"]).optional(),
});

export const channelsPlugin: FastifyPluginAsync = async (app) => {
  // ── GET /channels ────────────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/channels",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const channels = await listChannelSyncs(storeId);
      return reply.send({ channels });
    }
  );

  // ── PUT /channels/:channel — enable/configure ─────────────────────────────
  app.put(
    "/commerce/stores/:storeId/channels/:channel",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ChannelParam.safeParse(request.params);
      if (!params.success || !isChannelName(params.data.channel)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown channel" },
        });
      }
      const body = UpsertBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid body" },
        });
      }

      const row = await upsertChannelSync(storeId, {
        channel: params.data.channel,
        ...(body.data.is_active !== undefined ? { is_active: body.data.is_active } : {}),
        ...(body.data.config !== undefined ? { config: body.data.config } : {}),
      });
      return reply.send({ channel: row });
    }
  );

  // ── DELETE /channels/:channel ─────────────────────────────────────────────
  app.delete(
    "/commerce/stores/:storeId/channels/:channel",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ChannelParam.safeParse(request.params);
      if (!params.success || !isChannelName(params.data.channel)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown channel" },
        });
      }
      await deleteChannelSync(storeId, params.data.channel);
      return reply.send({ ok: true });
    }
  );

  // ── GET /channels/:channel/items — per-product sync state ─────────────────
  app.get(
    "/commerce/stores/:storeId/channels/:channel/items",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ChannelParam.safeParse(request.params);
      if (!params.success || !isChannelName(params.data.channel)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown channel" },
        });
      }
      const sync = await getChannelSync(storeId, params.data.channel);
      if (!sync) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "channel not configured" },
        });
      }
      const items = await listChannelSyncItems(storeId, sync.id);
      return reply.send({ channel: sync, items });
    }
  );

  // ── POST /channels/:channel/sync — trigger a manual sync (admin) ──────────
  app.post(
    "/commerce/stores/:storeId/channels/:channel/sync",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ChannelParam.safeParse(request.params);
      if (!params.success || !isChannelName(params.data.channel)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown channel" },
        });
      }
      const body = SyncBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid body" },
        });
      }

      const result = await runChannelSync(storeId, params.data.channel, {
        ...(body.data.mode ? { mode: body.data.mode } : {}),
      });
      return reply.send({ result });
    }
  );
};
