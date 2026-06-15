CREATE TABLE `embedding_cache` (
	`text_hash` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	`vec` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_embedding_cache_updated` ON `embedding_cache` (`updated_at`);