CREATE TABLE `deferred_outcome_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`channel_id` text NOT NULL,
	`action_ms` integer NOT NULL,
	`evaluation_ms` integer NOT NULL,
	`delay_ms` integer NOT NULL,
	`score` real NOT NULL,
	`confidence` real NOT NULL,
	`signals` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deferred_outcome_tick` ON `deferred_outcome_log` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_deferred_outcome_channel` ON `deferred_outcome_log` (`channel_id`);--> statement-breakpoint
ALTER TABLE `action_log` ADD `auto_writeback` text;