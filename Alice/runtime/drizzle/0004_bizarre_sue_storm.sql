CREATE TABLE `consciousness_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tick` integer NOT NULL,
	`timestamp_ms` integer NOT NULL,
	`kind` text NOT NULL,
	`entity_ids` text DEFAULT '[]' NOT NULL,
	`summary` text NOT NULL,
	`salience` real DEFAULT 0.5 NOT NULL,
	`expand_hint` text
);
--> statement-breakpoint
CREATE INDEX `idx_ce_tick` ON `consciousness_events` (`tick`);--> statement-breakpoint
CREATE INDEX `idx_ce_salience` ON `consciousness_events` (`salience`);