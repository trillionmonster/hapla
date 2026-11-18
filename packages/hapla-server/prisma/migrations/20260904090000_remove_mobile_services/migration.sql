-- Hapla is web-first: remove tables used exclusively by mobile push and the
-- retired commercial voice integration.
DROP TABLE IF EXISTS "AccountPushToken";
DROP TABLE IF EXISTS "VoiceConversation";
