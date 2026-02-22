import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { BLUEBUBBLES_GROUP_ACTIONS } from "../../channels/plugins/bluebubbles-actions.js";
import {
  listChannelMessageActions,
  supportsChannelMessageButtons,
  supportsChannelMessageCards,
} from "../../channels/plugins/message-actions.js";
import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName,
} from "../../channels/plugins/types.js";
import { loadConfig } from "../../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { listChannelSupportedActions } from "../channel-tools.js";
import { channelTargetSchema, channelTargetsSchema, stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
const EXPLICIT_TARGET_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "sendWithEffect",
  "sendAttachment",
  "reply",
  "thread-reply",
  "broadcast",
]);

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return EXPLICIT_TARGET_ACTIONS.has(action);
}
function buildRoutingSchema() {
  return {
    channel: Type.Optional(Type.String()),
    target: Type.Optional(channelTargetSchema({ description: "Target channel/user id or name." })),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
  };
}

function buildSendSchema(options: { includeButtons: boolean; includeCards: boolean }) {
  const props: Record<string, unknown> = {
    message: Type.Optional(Type.String()),
    effectId: Type.Optional(
      Type.String({
        description: "Message effect name/id for sendWithEffect (e.g., invisible ink).",
      }),
    ),
    effect: Type.Optional(
      Type.String({ description: "Alias for effectId (e.g., invisible-ink, balloons)." }),
    ),
    media: Type.Optional(
      Type.String({
        description: "Media URL or local path. data: URLs are not supported here, use buffer.",
      }),
    ),
    filename: Type.Optional(Type.String()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64 payload for attachments (optionally a data: URL).",
      }),
    ),
    contentType: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(Type.Boolean()),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(
      Type.String({ description: "Quote text for Telegram reply_parameters" }),
    ),
    bestEffort: Type.Optional(Type.Boolean()),
    gifPlayback: Type.Optional(Type.Boolean()),
    buttons: Type.Optional(
      Type.Array(
        Type.Array(
          Type.Object({
            text: Type.String(),
            callback_data: Type.String(),
          }),
        ),
        {
          description: "Telegram inline keyboard buttons (array of button rows)",
        },
      ),
    ),
    card: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Adaptive Card JSON object (when supported by the channel)",
        },
      ),
    ),
  };
  if (!options.includeButtons) {
    delete props.buttons;
  }
  if (!options.includeCards) {
    delete props.card;
  }
  return props;
}

function buildReactionSchema() {
  return {
    messageId: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
    targetAuthor: Type.Optional(Type.String()),
    targetAuthorUuid: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
  };
}

function buildFetchSchema() {
  return {
    limit: Type.Optional(Type.Number()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
    around: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
    includeArchived: Type.Optional(Type.Boolean()),
  };
}

function buildPollSchema() {
  return {
    pollQuestion: Type.Optional(Type.String()),
    pollOption: Type.Optional(Type.Array(Type.String())),
    pollDurationHours: Type.Optional(Type.Number()),
    pollMulti: Type.Optional(Type.Boolean()),
  };
}

function buildChannelTargetSchema() {
  return {
    channelId: Type.Optional(
      Type.String({ description: "Channel id filter (search/thread list/event create)." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Channel id filter (repeatable)." })),
    ),
    guildId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
    authorId: Type.Optional(Type.String()),
    authorIds: Type.Optional(Type.Array(Type.String())),
    roleId: Type.Optional(Type.String()),
    roleIds: Type.Optional(Type.Array(Type.String())),
    participant: Type.Optional(Type.String()),
  };
}

function buildStickerSchema() {
  return {
    emojiName: Type.Optional(Type.String()),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    threadName: Type.Optional(Type.String()),
    autoArchiveMin: Type.Optional(Type.Number()),
  };
}

function buildEventSchema() {
  return {
    query: Type.Optional(Type.String()),
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    durationMin: Type.Optional(Type.Number()),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: Type.Optional(Type.Number()),
  };
}

function buildGatewaySchema() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  };
}

function buildPresenceSchema() {
  return {
    activityType: Type.Optional(
      Type.String({
        description: "Activity type: playing, streaming, listening, watching, competing, custom.",
      }),
    ),
    activityName: Type.Optional(
      Type.String({
        description: "Activity name shown in sidebar (e.g. 'with fire'). Ignored for custom type.",
      }),
    ),
    activityUrl: Type.Optional(
      Type.String({
        description:
          "Streaming URL (Twitch or YouTube). Only used with streaming type; may not render for bots.",
      }),
    ),
    activityState: Type.Optional(
      Type.String({
        description:
          "State text. For custom type this is the status text; for others it shows in the flyout.",
      }),
    ),
    status: Type.Optional(
      Type.String({ description: "Bot status: online, dnd, idle, invisible." }),
    ),
  };
}

function buildChannelManagementSchema() {
  return {
    name: Type.Optional(Type.String()),
    type: Type.Optional(Type.Number()),
    parentId: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    position: Type.Optional(Type.Number()),
    nsfw: Type.Optional(Type.Boolean()),
    rateLimitPerUser: Type.Optional(Type.Number()),
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear the parent/category when supported by the provider.",
      }),
    ),
  };
}

function buildMessageToolSchemaProps(options: { includeButtons: boolean; includeCards: boolean }) {
  return {
