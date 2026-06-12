CREATE TABLE `action_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`voice` text NOT NULL,
	`target` text,
	`action_type` text NOT NULL,
	`chat_id` text,
	`message_text` text,
	`confidence` real,
	`reasoning` text,
	`success` integer DEFAULT false NOT NULL,
	`observation_gap` integer,
	`closure_depth` integer,
	`ea_proxy` real,
	`engagement_subcycles` integer,
	`engagement_duration_ms` integer,
	`engagement_outcome` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_action_log_tick` ON `action_log` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_action_log_chat_tick` ON `action_log` (`chat_id`,`tick`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_tick` ON `audit_events` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_level` ON `audit_events` (`level`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_source` ON `audit_events` (`source`);--> statement-breakpoint
CREATE TABLE `diary_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`content` text NOT NULL,
	`about` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_diary_tick` ON `diary_entries` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_diary_about` ON `diary_entries` (`about`);--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`src` text NOT NULL,
	`dst` text NOT NULL,
	`label` text NOT NULL,
	`category` text NOT NULL,
	`attrs` text
);
--> statement-breakpoint
CREATE INDEX `idx_graph_edges_src` ON `graph_edges` (`src`);--> statement-breakpoint
CREATE INDEX `idx_graph_edges_dst` ON `graph_edges` (`dst`);--> statement-breakpoint
CREATE INDEX `idx_graph_edges_src_label` ON `graph_edges` (`src`,`label`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`attrs` text NOT NULL,
	`updated_tick` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_graph_nodes_type` ON `graph_nodes` (`entity_type`);--> statement-breakpoint
CREATE TABLE `graph_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`graph_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_graph_snapshots_tick` ON `graph_snapshots` (`tick`);--> statement-breakpoint
CREATE TABLE `message_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`chat_id` text NOT NULL,
	`msg_id` integer,
	`reply_to_msg_id` integer,
	`sender_id` text,
	`sender_name` text,
	`text` text,
	`media_type` text,
	`is_outgoing` integer DEFAULT false NOT NULL,
	`is_directed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_message_log_tick` ON `message_log` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_message_log_chat` ON `message_log` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_message_log_chat_tick` ON `message_log` (`chat_id`,`tick`);--> statement-breakpoint
CREATE INDEX `idx_message_log_chat_msg` ON `message_log` (`chat_id`,`msg_id`);--> statement-breakpoint
CREATE INDEX `idx_message_log_sender` ON `message_log` (`sender_id`);--> statement-breakpoint
CREATE TABLE `mod_states` (
	`mod_name` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_tick` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `narrative_beats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`tick` integer NOT NULL,
	`content` text NOT NULL,
	`beat_type` text DEFAULT 'ambient' NOT NULL,
	`caused_by` text,
	`spawns` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_narrative_beats_thread` ON `narrative_beats` (`thread_id`);--> statement-breakpoint
CREATE TABLE `narrative_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`tension_frame` text,
	`tension_stake` text,
	`status` text DEFAULT 'open' NOT NULL,
	`weight` text DEFAULT 'minor' NOT NULL,
	`involves` text,
	`created_tick` integer NOT NULL,
	`last_beat_tick` integer,
	`resolved_tick` integer,
	`horizon` integer,
	`deadline_tick` integer,
	`summary` text,
	`summary_tick` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_narrative_threads_status` ON `narrative_threads` (`status`);--> statement-breakpoint
CREATE TABLE `personality_evolution_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`dimension` text NOT NULL,
	`delta` real NOT NULL,
	`source` text NOT NULL,
	`beat_type` text,
	`target_entity` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_personality_evo_tick` ON `personality_evolution_log` (`tick`);--> statement-breakpoint
CREATE TABLE `personality_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`weights` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`target_ms` integer,
	`interval_ms` integer,
	`action` text NOT NULL,
	`target` text,
	`payload` text,
	`created_at` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_active` ON `scheduled_tasks` (`active`,`target_ms`);--> statement-breakpoint
CREATE TABLE `silence_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`voice` text NOT NULL,
	`target` text,
	`reason` text NOT NULL,
	`net_value` real,
	`delta_p` real,
	`social_cost` real,
	`api_value` real,
	`silence_level` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_silence_log_tick` ON `silence_log` (`tick`);--> statement-breakpoint
CREATE TABLE `sticker_palette` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`file_id` text NOT NULL,
	`file_unique_id` text NOT NULL,
	`emoji` text,
	`set_name` text,
	`emotion` text,
	`action` text,
	`intensity` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_palette_file_id_unique` ON `sticker_palette` (`file_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_palette_file_unique_id_unique` ON `sticker_palette` (`file_unique_id`);--> statement-breakpoint
CREATE INDEX `idx_sticker_palette_label` ON `sticker_palette` (`label`);--> statement-breakpoint
CREATE INDEX `idx_sticker_palette_emotion` ON `sticker_palette` (`emotion`);--> statement-breakpoint
CREATE TABLE `sticker_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_unique_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sticker_usage_unique` ON `sticker_usage` (`file_unique_id`,`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_sticker_usage_chat` ON `sticker_usage` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_sticker_usage_count` ON `sticker_usage` (`count`);--> statement-breakpoint
CREATE TABLE `tick_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`p1` real NOT NULL,
	`p2` real NOT NULL,
	`p3` real NOT NULL,
	`p4` real NOT NULL,
	`p5` real NOT NULL,
	`p6` real NOT NULL,
	`api` real NOT NULL,
	`action` text,
	`target` text,
	`net_value` real,
	`delta_p` real,
	`social_cost` real,
	`selected_probability` real,
	`gate_verdict` text,
	`mode` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tick_log_tick` ON `tick_log` (`tick`);--> statement-breakpoint

-- ═══ FTS5 虚拟表（ADR-145: trigram 分词，CJK 友好）═══

CREATE VIRTUAL TABLE IF NOT EXISTS message_log_fts USING fts5(
  text,
  content='message_log',
  content_rowid='id',
  tokenize='better_trigram'
);--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(
  content,
  content='diary_entries',
  content_rowid='id',
  tokenize='better_trigram'
);--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
  title,
  summary,
  content='narrative_threads',
  content_rowid='id',
  tokenize='better_trigram'
);--> statement-breakpoint

-- ═══ FTS5 触发器——外部内容表自动同步 ═══
-- @see https://www.sqlite.org/fts5.html#external_content_tables

-- message_log_fts（1 列：text，可 NULL）
CREATE TRIGGER message_log_ai AFTER INSERT ON message_log
WHEN new.text IS NOT NULL
BEGIN
  INSERT INTO message_log_fts(rowid, text) VALUES (new.id, new.text);
END;--> statement-breakpoint
CREATE TRIGGER message_log_ad AFTER DELETE ON message_log
WHEN old.text IS NOT NULL
BEGIN
  INSERT INTO message_log_fts(message_log_fts, rowid, text)
    VALUES('delete', old.id, old.text);
END;--> statement-breakpoint
CREATE TRIGGER message_log_au AFTER UPDATE OF text ON message_log
BEGIN
  INSERT INTO message_log_fts(message_log_fts, rowid, text)
    SELECT 'delete', old.id, old.text WHERE old.text IS NOT NULL;
  INSERT INTO message_log_fts(rowid, text)
    SELECT new.id, new.text WHERE new.text IS NOT NULL;
END;--> statement-breakpoint

-- diary_fts（1 列：content，NOT NULL）
CREATE TRIGGER diary_entries_ai AFTER INSERT ON diary_entries
BEGIN
  INSERT INTO diary_fts(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint
CREATE TRIGGER diary_entries_ad AFTER DELETE ON diary_entries
BEGIN
  INSERT INTO diary_fts(diary_fts, rowid, content)
    VALUES('delete', old.id, old.content);
END;--> statement-breakpoint
CREATE TRIGGER diary_entries_au AFTER UPDATE OF content ON diary_entries
BEGIN
  INSERT INTO diary_fts(diary_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  INSERT INTO diary_fts(rowid, content) VALUES (new.id, new.content);
END;--> statement-breakpoint

-- threads_fts（2 列：title, summary）
CREATE TRIGGER narrative_threads_ai AFTER INSERT ON narrative_threads
BEGIN
  INSERT INTO threads_fts(rowid, title, summary)
    VALUES (new.id, new.title, COALESCE(new.summary, ''));
END;--> statement-breakpoint
CREATE TRIGGER narrative_threads_ad AFTER DELETE ON narrative_threads
BEGIN
  INSERT INTO threads_fts(threads_fts, rowid, title, summary)
    VALUES('delete', old.id, old.title, COALESCE(old.summary, ''));
END;--> statement-breakpoint
CREATE TRIGGER narrative_threads_au AFTER UPDATE OF title, summary ON narrative_threads
BEGIN
  INSERT INTO threads_fts(threads_fts, rowid, title, summary)
    VALUES('delete', old.id, old.title, COALESCE(old.summary, ''));
  INSERT INTO threads_fts(rowid, title, summary)
    VALUES (new.id, new.title, COALESCE(new.summary, ''));
END;