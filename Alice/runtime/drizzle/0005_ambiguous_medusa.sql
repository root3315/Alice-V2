CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`tick_start` integer NOT NULL,
	`tick_end` integer,
	`target` text,
	`voice` text,
	`outcome` text,
	`pressure_api` real,
	`pressure_dominant` text,
	`trigger_event` text,
	`entity_ids` text DEFAULT '[]' NOT NULL,
	`residue` text,
	`caused_by` text,
	`consults` text,
	`resolves` text,
	`created_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_episodes_tick` ON `episodes` (`tick_start`);--> statement-breakpoint
CREATE INDEX `idx_episodes_target` ON `episodes` (`target`);