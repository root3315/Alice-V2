CREATE TABLE `bio_cache` (
	`entity_id` text PRIMARY KEY NOT NULL,
	`bio` text,
	`personal_channel_id` integer,
	`fetched_at` integer NOT NULL
);
